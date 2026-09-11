import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@stellar-pay/database';
import { toStroops } from '@stellar-pay/shared';
import { WalletService } from '../wallet/wallet.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { ContractIntegrationService } from '../contracts/contract-integration.service';
import type {
  TreasuryDeposit,
  TreasuryMemberAction,
  TreasuryProposeWithdrawal,
} from '@stellar-pay/validation';

const TREASURY_CONTRACT_ENV = 'CONTRACT_STELLAR_PAY_TREASURY';

/**
 * On-chain treasury lifecycle (treasury contract):
 *
 *   deposit  → prepare `deposit(from, token, amount)` → sign → submit →
 *              indexer `deposit` event → operation CONFIRMED
 *   propose  → prepare `propose_withdraw(proposer, token, to, amount)` →
 *              sign → submit → indexer `wprop` → withdrawal PROPOSED
 *   approve  → prepare `approve_withdraw(member, id)` → sign → submit →
 *              indexer `wappr` → APPROVED (once ≥1 member approval observed)
 *   execute  → prepare `execute_withdraw(member, id)` → sign → submit →
 *              indexer `wexec` → EXECUTED (quorum enforced on-chain; funds
 *              only move in this transaction)
 *
 * The on-chain contract enforces governance membership + threshold + caps;
 * the API never marks EXECUTED on its own.
 */
@Injectable()
export class TreasuryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly realtime: RealtimeGateway,
    private readonly contracts: ContractIntegrationService,
  ) {}

  private contractId(): string {
    return this.contracts.requireContractAddress(TREASURY_CONTRACT_ENV, 'Treasury');
  }

  // ── Deposits ────────────────────────────────────────────────────────────

  async createDeposit(userId: string, dto: TreasuryDeposit) {
    await this.wallet.assertWalletOwnership(userId, dto.fromPublicKey);
    const tokenAddress = this.contracts.tokenAddress(dto.assetCode, dto.assetIssuer);
    const prepared = await this.contracts.prepareCall({
      source: dto.fromPublicKey,
      contractId: this.contractId(),
      functionName: 'deposit',
      args: [
        this.contracts.network().accountScVal(dto.fromPublicKey),
        this.contracts.network().accountScVal(tokenAddress),
        this.contracts.network().i128ScVal(BigInt(toStroops(dto.amount))),
      ],
    });
    const operation = await this.prisma.treasuryOperation.create({
      data: {
        userId,
        type: 'DEPOSIT',
        tokenAddress,
        assetCode: dto.assetCode,
        assetIssuer: dto.assetIssuer ?? null,
        amount: dto.amount,
        status: 'AWAITING_SIGN',
      },
    });
    return {
      id: operation.id,
      unsignedXdr: prepared.unsignedXdr,
      message: 'Sign the transaction with your wallet, then submit it',
    };
  }

  async submitDeposit(userId: string, id: string, signedXdr: string) {
    const operation = await this.findOperation(userId, id);
    if (operation.type !== 'DEPOSIT' || operation.status !== 'AWAITING_SIGN') {
      throw new BadRequestException('Deposit is not awaiting signature');
    }
    const claim = await this.prisma.treasuryOperation.updateMany({
      where: { id, type: 'DEPOSIT', status: 'AWAITING_SIGN' },
      data: { status: 'SUBMITTED' },
    });
    if (claim.count !== 1) {
      throw new BadRequestException('Deposit already submitted');
    }
    let result;
    try {
      result = await this.contracts.submitCall(signedXdr);
    } catch (err) {
      await this.prisma.treasuryOperation.updateMany({
        where: { id, status: 'SUBMITTED' },
        data: { status: 'AWAITING_SIGN' },
      });
      throw err;
    }
    if (result.status === 'FAILED') {
      await this.prisma.treasuryOperation.update({
        where: { id },
        data: { status: 'FAILED', hash: result.hash ?? null, errorMessage: result.errorMessage },
      });
      this.realtime.emitToUser(userId, 'treasury-operation.updated', { id, status: 'FAILED' });
      throw new BadRequestException(`Deposit reverted on-chain: ${result.errorMessage}`);
    }
    const updated = await this.prisma.treasuryOperation.update({
      where: { id },
      data: { hash: result.hash ?? null },
    });
    // CONFIRMED comes from the indexer (`deposit` event).
    return updated;
  }

  // ── Governed withdrawals ────────────────────────────────────────────────

  async proposeWithdrawal(userId: string, dto: TreasuryProposeWithdrawal) {
    await this.wallet.assertWalletOwnership(userId, dto.proposerPublicKey);
    const tokenAddress = this.contracts.tokenAddress(dto.assetCode, dto.assetIssuer);
    const prepared = await this.contracts.prepareCall({
      source: dto.proposerPublicKey,
      contractId: this.contractId(),
      functionName: 'propose_withdraw',
      args: [
        this.contracts.network().accountScVal(dto.proposerPublicKey),
        this.contracts.network().accountScVal(tokenAddress),
        this.contracts.network().accountScVal(dto.toPublicKey),
        this.contracts.network().i128ScVal(BigInt(toStroops(dto.amount))),
      ],
    });
    const withdrawal = await this.prisma.treasuryWithdrawal.create({
      data: {
        userId,
        toPublicKey: dto.toPublicKey,
        assetCode: dto.assetCode,
        assetIssuer: dto.assetIssuer ?? null,
        amount: dto.amount,
        approvals: [],
        status: 'PROPOSED',
      },
    });
    return {
      id: withdrawal.id,
      unsignedXdr: prepared.unsignedXdr,
      message: 'Sign the transaction with your wallet, then submit it',
    };
  }

  async submitProposal(userId: string, id: string, signedXdr: string) {
    const withdrawal = await this.findWithdrawal(userId, id);
    if (withdrawal.contractWithdrawalId) {
      throw new BadRequestException('Withdrawal already proposed on-chain');
    }
    const result = await this.contracts.submitCall(signedXdr);
    if (result.status === 'FAILED') {
      await this.prisma.treasuryWithdrawal.update({
        where: { id },
        data: { status: 'FAILED', hash: result.hash ?? null },
      });
      throw new BadRequestException(`Proposal reverted on-chain: ${result.errorMessage}`);
    }
    const updated = await this.prisma.treasuryWithdrawal.update({
      where: { id },
      data: { hash: result.hash ?? null },
    });
    // contractWithdrawalId + PROPOSED come from the indexer (`wprop` event).
    return updated;
  }

  async approve(userId: string, id: string, dto: TreasuryMemberAction) {
    await this.wallet.assertWalletOwnership(userId, dto.memberPublicKey);
    const withdrawal = await this.findWithdrawal(userId, id);
    if (!withdrawal.contractWithdrawalId) {
      throw new BadRequestException('Withdrawal is not proposed on-chain yet');
    }
    const prepared = await this.contracts.prepareCall({
      source: dto.memberPublicKey,
      contractId: this.contractId(),
      functionName: 'approve_withdraw',
      args: [
        this.contracts.network().accountScVal(dto.memberPublicKey),
        this.contracts.network().u64ScVal(BigInt(withdrawal.contractWithdrawalId)),
      ],
    });
    return {
      id: withdrawal.id,
      action: 'approve',
      unsignedXdr: prepared.unsignedXdr,
      message: 'Sign the transaction with your wallet, then submit it',
    };
  }

  async execute(userId: string, id: string, dto: TreasuryMemberAction) {
    await this.wallet.assertWalletOwnership(userId, dto.memberPublicKey);
    const withdrawal = await this.findWithdrawal(userId, id);
    if (!withdrawal.contractWithdrawalId) {
      throw new BadRequestException('Withdrawal is not proposed on-chain yet');
    }
    if (withdrawal.status === 'EXECUTED') {
      throw new BadRequestException('Withdrawal already executed');
    }
    const prepared = await this.contracts.prepareCall({
      source: dto.memberPublicKey,
      contractId: this.contractId(),
      functionName: 'execute_withdraw',
      args: [
        this.contracts.network().accountScVal(dto.memberPublicKey),
        this.contracts.network().u64ScVal(BigInt(withdrawal.contractWithdrawalId)),
      ],
    });
    return {
      id: withdrawal.id,
      action: 'execute',
      unsignedXdr: prepared.unsignedXdr,
      message: 'Sign the transaction with your wallet, then submit it',
    };
  }

  async confirmAction(
    userId: string,
    id: string,
    action: 'approve' | 'execute',
    signedXdr: string,
  ) {
    const withdrawal = await this.findWithdrawal(userId, id);
    const hashField = action === 'approve' ? 'approveHash' : 'executedHash';
    if ((withdrawal as unknown as Record<string, string | null>)[hashField]) {
      throw new BadRequestException(`${action} already in flight`);
    }
    const result = await this.contracts.submitCall(signedXdr);
    if (result.status === 'FAILED') {
      throw new BadRequestException(`${action} reverted on-chain: ${result.errorMessage}`);
    }
    const updated = await this.prisma.treasuryWithdrawal.update({
      where: { id },
      data: { [hashField]: result.hash ?? null } as never,
    });
    // Status advances on the `wappr` / `wexec` event.
    return updated;
  }

  async listOperations(userId: string) {
    return this.prisma.treasuryOperation.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async listWithdrawals(userId: string) {
    return this.prisma.treasuryWithdrawal.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  private async findOperation(userId: string, id: string) {
    const operation = await this.prisma.treasuryOperation.findFirst({ where: { id, userId } });
    if (!operation) {
      throw new NotFoundException('Treasury operation not found');
    }
    return operation;
  }

  private async findWithdrawal(userId: string, id: string) {
    const withdrawal = await this.prisma.treasuryWithdrawal.findFirst({ where: { id, userId } });
    if (!withdrawal) {
      throw new NotFoundException('Treasury withdrawal not found');
    }
    return withdrawal;
  }
}
