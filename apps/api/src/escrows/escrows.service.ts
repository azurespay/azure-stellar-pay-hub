import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '@stellar-pay/database';
import { toStroops } from '@stellar-pay/shared';
import { WalletService } from '../wallet/wallet.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { NotificationsService } from '../notifications/notifications.service';
import { ContractIntegrationService } from '../contracts/contract-integration.service';
import type { CreateEscrow } from '@stellar-pay/validation';

const ESCROW_CONTRACT_ENV = 'CONTRACT_STELLAR_PAY_ESCROW';

/**
 * On-chain escrow lifecycle, mirroring the contract payment route:
 *
 *   create  → prepare `create(initiator, counterparty, arbiter, token,
 *             amount, release_time, expiry)` → wallet signs → submit →
 *             SUBMITTED → indexer observes `created` → FUNDED
 *   release → prepare `release(id, caller)` → wallet signs → submit →
 *             indexer observes `released` → RELEASED
 *   refund  → prepare `refund(id, caller)` → wallet signs → submit →
 *             indexer observes `refund` → REFUNDED
 *
 * Status transitions are driven exclusively by the event indexer (on-chain
 * evidence); the API never flips an escrow to FUNDED/RELEASED/REFUNDED on its
 * own.
 */
@Injectable()
export class EscrowsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly realtime: RealtimeGateway,
    private readonly notifications: NotificationsService,
    private readonly contracts: ContractIntegrationService,
  ) {}

  private contractId(): string {
    return this.contracts.requireContractAddress(ESCROW_CONTRACT_ENV, 'Escrow');
  }

  /** Create the escrow intent and prepare the signable `create` envelope. */
  async create(userId: string, dto: CreateEscrow) {
    await this.wallet.assertWalletOwnership(userId, dto.initiatorPublicKey);
    const contractId = this.contractId();
    const tokenAddress = this.contracts.tokenAddress(dto.assetCode, dto.assetIssuer);
    const releaseTime = Math.floor(new Date(dto.releaseTime).getTime() / 1000);
    const expiry = dto.expiry ? Math.floor(new Date(dto.expiry).getTime() / 1000) : null;
    if (expiry !== null && expiry <= releaseTime) {
      throw new BadRequestException('Expiry must be after the release time');
    }

    const prepared = await this.contracts.prepareCall({
      source: dto.initiatorPublicKey,
      contractId,
      functionName: 'create',
      args: [
        this.contracts.network().accountScVal(dto.initiatorPublicKey),
        this.contracts.network().accountScVal(dto.counterpartyPublicKey),
        this.contracts
          .network()
          .optionScVal(
            dto.arbiterPublicKey
              ? this.contracts.network().accountScVal(dto.arbiterPublicKey)
              : null,
          ),
        this.contracts.network().accountScVal(tokenAddress),
        this.contracts.network().i128ScVal(BigInt(toStroops(dto.amount))),
        this.contracts.network().u64ScVal(BigInt(releaseTime)),
        this.contracts.network().optionScVal(
          expiry !== null ? this.contracts.network().u64ScVal(BigInt(expiry)) : null,
        ),
      ],
    });

    const escrow = await this.prisma.escrow.create({
      data: {
        userId,
        initiatorPublicKey: dto.initiatorPublicKey,
        counterpartyPublicKey: dto.counterpartyPublicKey,
        arbiterPublicKey: dto.arbiterPublicKey ?? null,
        tokenAddress,
        assetCode: dto.assetCode,
        assetIssuer: dto.assetIssuer ?? null,
        amount: dto.amount,
        releaseTime: new Date(dto.releaseTime),
        expiry: dto.expiry ? new Date(dto.expiry) : null,
        status: 'AWAITING_SIGN',
      },
    });

    return {
      id: escrow.id,
      unsignedXdr: prepared.unsignedXdr,
      message: 'Sign the transaction with your wallet, then submit it',
    };
  }

  /** Submit the wallet-signed `create` envelope (creator-owned). */
  async submit(userId: string, id: string, signedXdr: string) {
    const escrow = await this.prisma.escrow.findFirst({ where: { id, userId } });
    if (!escrow) {
      throw new NotFoundException('Escrow not found');
    }
    if (escrow.status !== 'AWAITING_SIGN') {
      throw new BadRequestException(`Escrow is not awaiting signature (status: ${escrow.status})`);
    }

    // Atomic claim so a duplicate/concurrent submit is rejected before the
    // network is touched.
    const claim = await this.prisma.escrow.updateMany({
      where: { id, status: 'AWAITING_SIGN' },
      data: { status: 'SUBMITTED' },
    });
    if (claim.count !== 1) {
      throw new BadRequestException('Escrow already submitted');
    }

    let result;
    try {
      result = await this.contracts.submitCall(signedXdr);
    } catch (err) {
      // Transport/rejection: revert the claim so the user can retry.
      await this.prisma.escrow.updateMany({
        where: { id, status: 'SUBMITTED' },
        data: { status: 'AWAITING_SIGN' },
      });
      throw err;
    }

    if (result.status === 'FAILED') {
      await this.prisma.escrow.update({
        where: { id },
        data: { status: 'FAILED', hash: result.hash ?? null, errorMessage: result.errorMessage },
      });
      this.realtime.emitToUser(userId, 'escrow.updated', { id, status: 'FAILED' });
      throw new BadRequestException(`Escrow creation reverted on-chain: ${result.errorMessage}`);
    }

    const updated = await this.prisma.escrow.update({
      where: { id },
      data: { hash: result.hash ?? null, status: 'SUBMITTED' },
    });
    // Settlement CONFIRMED comes from the indexer (`created` event).
    return updated;
  }

  /** Prepare the signable `release(id, caller)` envelope. */
  async release(userId: string, id: string, callerPublicKey: string) {
    // Authorization mirrors the contract: the caller's *wallet key* must be a
    // party (initiator/counterparty/arbiter) — the DB row may belong to the
    // initiator while the counterparty acts from their own account.
    const escrow = await this.findVisible(userId, id);
    await this.wallet.assertWalletOwnership(userId, callerPublicKey);
    this.assertCanRelease(escrow, callerPublicKey);
    if (escrow.releaseHash) {
      throw new BadRequestException('Release already in flight');
    }

    const prepared = await this.contracts.prepareCall({
      source: callerPublicKey,
      contractId: this.contractId(),
      functionName: 'release',
      args: [
        this.contracts.network().u64ScVal(BigInt(escrow.contractId!)),
        this.contracts.network().accountScVal(callerPublicKey),
      ],
    });
    return {
      id: escrow.id,
      action: 'release',
      unsignedXdr: prepared.unsignedXdr,
      message: 'Sign the transaction with your wallet, then submit it',
    };
  }

  /** Prepare the signable `refund(id, caller)` envelope. */
  async refund(userId: string, id: string, callerPublicKey: string) {
    const escrow = await this.findVisible(userId, id);
    await this.wallet.assertWalletOwnership(userId, callerPublicKey);
    this.assertCanRefund(escrow, callerPublicKey);
    if (escrow.refundHash) {
      throw new BadRequestException('Refund already in flight');
    }

    const prepared = await this.contracts.prepareCall({
      source: callerPublicKey,
      contractId: this.contractId(),
      functionName: 'refund',
      args: [
        this.contracts.network().u64ScVal(BigInt(escrow.contractId!)),
        this.contracts.network().accountScVal(callerPublicKey),
      ],
    });
    return {
      id: escrow.id,
      action: 'refund',
      unsignedXdr: prepared.unsignedXdr,
      message: 'Sign the transaction with your wallet, then submit it',
    };
  }

  /** Submit the wallet-signed release/refund envelope; indexer finalizes. */
  async confirmAction(userId: string, id: string, action: 'release' | 'refund', signedXdr: string) {
    const escrow = await this.findVisible(userId, id);
    const hashField = action === 'release' ? 'releaseHash' : 'refundHash';
    const current = escrow[hashField];
    if (current) {
      throw new BadRequestException(`${action} already submitted (in flight)`);
    }
    if (escrow.status !== 'FUNDED') {
      throw new BadRequestException(
        `Escrow must be FUNDED on-chain before ${action} (status: ${escrow.status})`,
      );
    }

    let result;
    try {
      result = await this.contracts.submitCall(signedXdr);
    } catch (err) {
      throw err;
    }
    if (result.status === 'FAILED') {
      throw new BadRequestException(`${action} reverted on-chain: ${result.errorMessage}`);
    }

    const updated = await this.prisma.escrow.update({
      where: { id },
      data: { [hashField]: result.hash ?? null },
    });
    // RELEASED/REFUNDED is set by the indexer when the on-chain event lands.
    return updated;
  }

  async list(userId: string) {
    const myKeys = await this.myKeys(userId);
    return this.prisma.escrow.findMany({
      where: {
        OR: [
          { userId },
          {
            AND: [
              myKeys.length > 0
                ? {
                    OR: [
                      { initiatorPublicKey: { in: myKeys } },
                      { counterpartyPublicKey: { in: myKeys } },
                      { arbiterPublicKey: { in: myKeys } },
                    ],
                  }
                : { id: '__none__' },
            ],
          },
        ],
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async get(userId: string, id: string) {
    return this.findVisible(userId, id);
  }

  /** Escrows the user created OR ones where one of their wallet keys is a party. */
  private async findVisible(userId: string, id: string) {
    const myKeys = await this.myKeys(userId);
    const escrow = await this.prisma.escrow.findFirst({
      where: {
        id,
        OR: [
          { userId },
          ...(myKeys.length > 0
            ? [
                {
                  OR: [
                    { initiatorPublicKey: { in: myKeys } },
                    { counterpartyPublicKey: { in: myKeys } },
                    { arbiterPublicKey: { in: myKeys } },
                  ],
                },
              ]
            : []),
        ],
      },
    });
    if (!escrow) {
      throw new NotFoundException('Escrow not found');
    }
    return escrow;
  }

  private async myKeys(userId: string): Promise<string[]> {
    const wallets = await this.prisma.wallet.findMany({
      where: { userId },
      select: { publicKey: true },
    });
    return wallets.map((w) => w.publicKey);
  }

  /** Release authorization: initiator, counterparty, or arbiter. */
  private assertCanRelease(
    escrow: {
      contractId: number | null;
      initiatorPublicKey: string;
      counterpartyPublicKey: string;
      arbiterPublicKey: string | null;
    },
    callerPublicKey: string,
  ) {
    if (!escrow.contractId) {
      throw new BadRequestException('Escrow is not yet funded on-chain');
    }
    const allowed = [escrow.initiatorPublicKey, escrow.counterpartyPublicKey, escrow.arbiterPublicKey];
    if (!allowed.includes(callerPublicKey)) {
      throw new ForbiddenException('Only the initiator, counterparty, or arbiter can release');
    }
  }

  /** Refund authorization: initiator or counterparty (contract enforces timing). */
  private assertCanRefund(
    escrow: { contractId: number | null; initiatorPublicKey: string; counterpartyPublicKey: string },
    callerPublicKey: string,
  ) {
    if (!escrow.contractId) {
      throw new BadRequestException('Escrow is not yet funded on-chain');
    }
    if (callerPublicKey !== escrow.initiatorPublicKey && callerPublicKey !== escrow.counterpartyPublicKey) {
      throw new ForbiddenException('Only the initiator or counterparty can refund');
    }
  }
}