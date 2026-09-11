import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '@stellar-pay/database';
import { createId } from '@stellar-pay/shared';
import { toStroops } from '@stellar-pay/shared';
import { buildPaymentUri } from '@stellar-pay/shared';
import { WalletService } from '../wallet/wallet.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { ContractIntegrationService } from '../contracts/contract-integration.service';
import type {
  CreateMerchant,
  UpdateMerchant,
  CreateProduct,
  MerchantRegisterOnChain,
  MerchantSettle,
} from '@stellar-pay/validation';

const MERCHANT_CONTRACT_ENV = 'CONTRACT_STELLAR_PAY_MERCHANT';

@Injectable()
export class MerchantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly realtime: RealtimeGateway,
    private readonly contracts: ContractIntegrationService,
  ) {}

  async register(userId: string, input: CreateMerchant) {
    const existing = await this.prisma.merchant.findUnique({ where: { userId } });
    if (existing) {
      throw new ConflictException('Merchant profile already exists');
    }
    const slugTaken = await this.prisma.merchant.findUnique({ where: { slug: input.slug } });
    if (slugTaken) {
      throw new ConflictException('Merchant slug is already taken');
    }
    const merchant = await this.prisma.merchant.create({
      data: {
        userId,
        name: input.name,
        slug: input.slug,
        description: input.description,
        logoUrl: input.logoUrl,
        websiteUrl: input.websiteUrl,
        currency: input.currency ?? 'USD',
        settlementAssetCode: input.settlementAssetCode ?? 'USDC',
        settlementAssetIssuer: input.settlementAssetIssuer,
        settlementPublicKey: input.settlementPublicKey,
        webhookUrl: input.webhookUrl,
        webhookSecret: createId(),
        status: 'PENDING',
      },
    });
    // Elevate the user to the merchant role.
    await this.prisma.user.update({ where: { id: userId }, data: { role: 'MERCHANT' } });
    return merchant;
  }

  /**
   * View the caller's own profile. SUSPENDED/REJECTED merchants are locked
   * out entirely (an admin suspension therefore takes effect on the next
   * request rather than only blocking new inbound credits); a PENDING
   * merchant may still see and refine its profile while awaiting approval.
   */
  async me(userId: string) {
    const merchant = await this.prisma.merchant.findUnique({ where: { userId } });
    if (!merchant) {
      throw new NotFoundException('No merchant profile for this account');
    }
    if (merchant.status === 'SUSPENDED' || merchant.status === 'REJECTED') {
      throw new ForbiddenException('Merchant account is not active');
    }
    return merchant;
  }

  /** Fetch the caller's merchant and require it to be fully ACTIVE. */
  private async activeMerchant(userId: string) {
    const merchant = await this.me(userId);
    if (merchant.status !== 'ACTIVE') {
      throw new ForbiddenException('Merchant account is not yet active');
    }
    return merchant;
  }

  async update(userId: string, input: UpdateMerchant) {
    const merchant = await this.me(userId);
    return this.prisma.merchant.update({
      where: { id: merchant.id },
      data: {
        name: input.name,
        description: input.description,
        logoUrl: input.logoUrl,
        websiteUrl: input.websiteUrl,
        settlementPublicKey: input.settlementPublicKey,
        webhookUrl: input.webhookUrl,
      },
    });
  }

  async products(userId: string, page = 1, pageSize = 50) {
    const merchant = await this.activeMerchant(userId);
    const [items, total] = await Promise.all([
      this.prisma.product.findMany({
        where: { merchantId: merchant.id },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.product.count({ where: { merchantId: merchant.id } }),
    ]);
    return {
      data: items,
      meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    };
  }

  async createProduct(userId: string, input: CreateProduct) {
    const merchant = await this.activeMerchant(userId);
    return this.prisma.product.create({
      data: {
        merchantId: merchant.id,
        name: input.name,
        description: input.description,
        priceAmount: input.priceAmount,
        assetCode: input.assetCode ?? 'USDC',
        assetIssuer: input.assetIssuer,
        imageUrl: input.imageUrl,
      },
    });
  }

  async deleteProduct(userId: string, productId: string) {
    const merchant = await this.activeMerchant(userId);
    await this.prisma.product.deleteMany({ where: { id: productId, merchantId: merchant.id } });
    return { ok: true };
  }

  async invoices(userId: string) {
    const merchant = await this.activeMerchant(userId);
    return this.prisma.invoice.findMany({
      where: { merchantId: merchant.id },
      orderBy: { createdAt: 'desc' },
    });
  }

  async paymentLinks(userId: string) {
    const merchant = await this.activeMerchant(userId);
    return this.prisma.paymentLink.findMany({
      where: { merchantId: merchant.id },
      orderBy: { createdAt: 'desc' },
    });
  }

  async settlements(userId: string) {
    const merchant = await this.activeMerchant(userId);
    return this.prisma.settlement.findMany({
      where: { merchantId: merchant.id },
      orderBy: { createdAt: 'desc' },
    });
  }

  async customers(userId: string) {
    const merchant = await this.activeMerchant(userId);
    return this.prisma.customer.findMany({
      where: { merchantId: merchant.id },
      orderBy: { totalSpent: 'desc' },
    });
  }

  // ── On-chain merchant contract integration ────────────────────────────

  /** Prepare `register(owner, name, settlement, commission_bps)` on the merchant contract. */
  async registerOnChain(userId: string, dto: MerchantRegisterOnChain) {
    const merchant = await this.activeMerchant(userId);
    if (merchant.onChainMerchantId) {
      throw new BadRequestException('Merchant is already registered on-chain');
    }
    await this.wallet.assertWalletOwnership(userId, dto.ownerPublicKey);
    const contractId = this.contracts.requireContractAddress(MERCHANT_CONTRACT_ENV, 'Merchant');
    const prepared = await this.contracts.prepareCall({
      source: dto.ownerPublicKey,
      contractId,
      functionName: 'register',
      args: [
        this.contracts.network().accountScVal(dto.ownerPublicKey),
        this.contracts.network().stringScVal(dto.name),
        this.contracts.network().accountScVal(dto.settlementPublicKey),
        this.contracts.network().u32ScVal(dto.commissionBps),
      ],
    });
    return {
      merchantId: merchant.id,
      unsignedXdr: prepared.unsignedXdr,
      message: 'Sign the transaction with your wallet, then submit it',
    };
  }

  /** Submit the wallet-signed `register` envelope. */
  async submitRegisterOnChain(userId: string, signedXdr: string) {
    const merchant = await this.activeMerchant(userId);
    if (merchant.onChainMerchantId) {
      throw new BadRequestException('Merchant is already registered on-chain');
    }
    const result = await this.contracts.submitCall(signedXdr);
    if (result.status === 'FAILED') {
      throw new BadRequestException(
        `Merchant registration reverted on-chain: ${result.errorMessage}`,
      );
    }
    const updated = await this.prisma.merchant.update({
      where: { id: merchant.id },
      data: { registerTxHash: result.hash ?? null },
    });
    // onChainMerchantId is assigned by the indexer (`reg` event).
    return updated;
  }

  /**
   * Record a sale through the merchant contract (`record_sale`): the payer's
   * tokens move to the contract and the merchant's on-chain balance is
   * credited. The confirmed INCOMING transaction row is created by the
   * indexer when the `sale` event is observed (never by this endpoint), so a
   * re-submission cannot double-credit.
   */
  async recordSale(
    userId: string,
    merchantId: string,
    input: {
      payerPublicKey: string;
      assetCode?: string;
      assetIssuer?: string | null;
      amount: string;
    },
  ) {
    await this.wallet.assertWalletOwnership(userId, input.payerPublicKey);
    const merchant = await this.prisma.merchant.findUnique({ where: { id: merchantId } });
    if (!merchant) {
      throw new NotFoundException('Merchant not found');
    }
    if (!merchant.onChainMerchantId) {
      throw new BadRequestException('Merchant is not registered on-chain');
    }
    const assetCode = input.assetCode ?? 'XLM';
    const tokenAddress = this.contracts.tokenAddress(assetCode, input.assetIssuer);
    const contractId = this.contracts.requireContractAddress(MERCHANT_CONTRACT_ENV, 'Merchant');
    const prepared = await this.contracts.prepareCall({
      source: input.payerPublicKey,
      contractId,
      functionName: 'record_sale',
      args: [
        this.contracts.network().accountScVal(input.payerPublicKey),
        this.contracts.network().u64ScVal(BigInt(merchant.onChainMerchantId)),
        this.contracts.network().accountScVal(tokenAddress),
        this.contracts.network().i128ScVal(BigInt(toStroops(input.amount))),
      ],
    });
    return {
      merchantId,
      unsignedXdr: prepared.unsignedXdr,
      message: 'Sign the transaction with your wallet, then submit it',
    };
  }

  /** Submit the wallet-signed `record_sale` envelope. */
  async submitSale(signedXdr: string) {
    const result = await this.contracts.submitCall(signedXdr);
    if (result.status === 'FAILED') {
      throw new BadRequestException(`Sale reverted on-chain: ${result.errorMessage}`);
    }
    // The merchant's INCOMING credit lands when the indexer observes `sale`.
    return {
      hash: result.hash,
      status: 'SUBMITTED',
      message: 'Sale submitted — confirming on-chain',
    };
  }

  /**
   * Prepare `settle(owner, id, token)` on the merchant contract: the owner
   * moves the merchant's held balance (minus commission) to its settlement
   * address. Creates a Settlement row in PROCESSING; the indexer marks it
   * COMPLETED on the `settle` event and fills in the real amount.
   */
  async settleOnChain(userId: string, dto: MerchantSettle) {
    const merchant = await this.activeMerchant(userId);
    if (!merchant.onChainMerchantId) {
      throw new BadRequestException('Merchant is not registered on-chain');
    }
    await this.wallet.assertWalletOwnership(userId, dto.ownerPublicKey);
    const contractId = this.contracts.requireContractAddress(MERCHANT_CONTRACT_ENV, 'Merchant');
    const tokenAddress = this.contracts.tokenAddress(dto.assetCode, dto.assetIssuer);
    const prepared = await this.contracts.prepareCall({
      source: dto.ownerPublicKey,
      contractId,
      functionName: 'settle',
      args: [
        this.contracts.network().accountScVal(dto.ownerPublicKey),
        this.contracts.network().u64ScVal(BigInt(merchant.onChainMerchantId)),
        this.contracts.network().accountScVal(tokenAddress),
      ],
    });
    const settlement = await this.prisma.settlement.create({
      data: {
        merchantId: merchant.id,
        periodStart: new Date(Date.now() - 30 * 86_400_000),
        periodEnd: new Date(),
        amount: '0', // filled in by the indexer from the `settle` event
        assetCode: dto.assetCode,
        assetIssuer: dto.assetIssuer ?? null,
        status: 'PROCESSING',
        onChainMerchantId: merchant.onChainMerchantId,
      },
    });
    return {
      settlementId: settlement.id,
      unsignedXdr: prepared.unsignedXdr,
      message: 'Sign the transaction with your wallet, then submit it',
    };
  }

  /** Submit the wallet-signed `settle` envelope. */
  async submitSettle(userId: string, settlementId: string, signedXdr: string) {
    const settlement = await this.prisma.settlement.findFirst({
      where: { id: settlementId, merchant: { userId } },
    });
    if (!settlement) {
      throw new NotFoundException('Settlement not found');
    }
    if (settlement.status !== 'PROCESSING') {
      throw new BadRequestException('Settlement is not awaiting submission');
    }
    const result = await this.contracts.submitCall(signedXdr);
    if (result.status === 'FAILED') {
      await this.prisma.settlement.update({
        where: { id: settlementId },
        data: { status: 'FAILED' },
      });
      throw new BadRequestException(`Settlement reverted on-chain: ${result.errorMessage}`);
    }
    const updated = await this.prisma.settlement.update({
      where: { id: settlementId },
      data: { payoutTransactionId: result.hash ?? null },
    });
    // COMPLETED comes from the indexer (`settle` event).
    return updated;
  }

  /** POS checkout: sum products (or a custom amount) into a payment URI + QR payload. */
  async posCheckout(
    userId: string,
    input: {
      productIds?: string[];
      amount?: string;
      assetCode?: string;
      customerPublicKey?: string;
    },
  ) {
    const merchant = await this.activeMerchant(userId);
    let amount = input.amount;
    let assetCode = input.assetCode ?? merchant.settlementAssetCode;
    if (!amount && input.productIds?.length) {
      const products = await this.prisma.product.findMany({
        where: { id: { in: input.productIds }, merchantId: merchant.id, status: 'ACTIVE' },
      });
      if (products.length !== input.productIds.length) {
        throw new NotFoundException('One or more products not found');
      }
      amount = products.reduce((sum, p) => sum + Number(p.priceAmount), 0).toString();
      assetCode = products[0]?.assetCode ?? assetCode;
    }
    if (!amount) {
      throw new ConflictException('Provide either products or an amount');
    }
    const uri = buildPaymentUri({
      destination: merchant.settlementPublicKey,
      amount,
      assetCode,
      assetIssuer: merchant.settlementAssetIssuer ?? undefined,
    });
    return { uri, qrPayload: uri, amount, assetCode, merchantName: merchant.name };
  }
}
