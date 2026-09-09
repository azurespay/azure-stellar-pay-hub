import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '@stellar-pay/database';
import { addAmounts, toStroops } from '@stellar-pay/shared';
import { randomBytes } from 'crypto';
import { WalletService } from '../wallet/wallet.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { ContractIntegrationService } from '../contracts/contract-integration.service';
import type { CreateInvoice } from '@stellar-pay/validation';

const INVOICES_CONTRACT_ENV = 'CONTRACT_STELLAR_PAY_INVOICES';

@Injectable()
export class InvoicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly realtime: RealtimeGateway,
    private readonly contracts: ContractIntegrationService,
  ) {}

  /**
   * Crypto-strong invoice number. Invoice numbers double as the on-chain
   * payment memo for checkout reconciliation, so they must not be guessable:
   * `Math.random()` is predictable, and its base36 slice collapses to a small
   * space with real collision odds. `randomBytes(4)` → 8 hex chars (16^8 ≈
   * 4.3B values) with retry on the (astronomically unlikely) unique-constraint
   * collision.
   */
  private async nextNumber(): Promise<string> {
    const year = new Date().getFullYear();
    for (let attempt = 0; attempt < 5; attempt++) {
      const number = `INV-${year}-${randomBytes(4).toString('hex').toUpperCase()}`;
      const existing = await this.prisma.invoice.findUnique({ where: { number } });
      if (!existing) {
        return number;
      }
    }
    // Practically unreachable; fall back to a longer draw rather than throw.
    return `INV-${year}-${randomBytes(6).toString('hex').toUpperCase()}`;
  }

  /** Create an invoice; amount is computed from items unless overridden. */
  async create(merchantId: string, input: CreateInvoice) {
    const merchant = await this.prisma.merchant.findUnique({ where: { id: merchantId } });
    if (!merchant) {
      throw new NotFoundException('Merchant not found');
    }

    const computed = input.items.reduce((sum, item) => {
      return addAmounts(sum, String(Number(item.unitPrice) * item.quantity));
    }, '0');

    let customerId: string | null = null;
    if (input.customerPublicKey) {
      customerId = await this.upsertCustomer(
        merchantId,
        input.customerPublicKey,
        input.customerEmail,
        input.customerName,
      );
    }

    return this.prisma.invoice.create({
      data: {
        number: await this.nextNumber(),
        merchantId,
        customerId,
        customerPublicKey: input.customerPublicKey,
        title: input.title,
        description: input.description,
        items: input.items as never,
        amount: computed,
        assetCode: input.assetCode ?? 'USDC',
        assetIssuer: input.assetIssuer,
        status: 'ISSUED',
        dueDate: input.dueDate ? new Date(input.dueDate) : null,
        memo: input.memo,
      },
    });
  }

  private async upsertCustomer(
    merchantId: string,
    publicKey: string,
    email?: string,
    name?: string,
  ): Promise<string> {
    const customer = await this.prisma.customer.upsert({
      where: { merchantId_publicKey: { merchantId, publicKey } },
      update: { email: email ?? undefined, name: name ?? undefined },
      create: { merchantId, publicKey, email, name },
    });
    return customer.id;
  }

  async list(merchantId: string) {
    return this.prisma.invoice.findMany({ where: { merchantId }, orderBy: { createdAt: 'desc' } });
  }

  async getByNumber(number: string) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { number },
      include: { merchant: { select: { name: true } } },
    });
    if (!invoice) {
      throw new NotFoundException('Invoice not found');
    }
    return invoice;
  }

  async cancel(merchantId: string, id: string) {
    const invoice = await this.prisma.invoice.findFirst({ where: { id, merchantId } });
    if (!invoice) {
      throw new NotFoundException('Invoice not found');
    }
    return this.prisma.invoice.update({ where: { id }, data: { status: 'CANCELED' } });
  }

  // ── On-chain invoices (Soroban invoices contract) ──────────────────────

  /**
   * Prepare `create(merchant, customer, token, amount, description, due)` on
   * the invoices contract. The invoice's DB status becomes PAID only when the
   * contract's `paid` event is indexed — never on a database write alone.
   */
  async issueOnChain(merchantId: string, invoiceId: string) {
    const invoice = await this.findInvoice(merchantId, invoiceId);
    if (invoice.onChainId) {
      throw new BadRequestException('Invoice is already issued on-chain');
    }
    if (!invoice.customerPublicKey) {
      throw new BadRequestException(
        'Invoice has no customer public key — on-chain issue requires the payer address',
      );
    }
    const merchant = await this.prisma.merchant.findUnique({ where: { id: merchantId } });
    if (!merchant) {
      throw new NotFoundException('Merchant not found');
    }
    await this.wallet.assertWalletOwnership(merchant.userId, merchant.settlementPublicKey);
    const contractId = this.contracts.requireContractAddress(INVOICES_CONTRACT_ENV, 'Invoices');
    const tokenAddress = this.contracts.tokenAddress(invoice.assetCode, invoice.assetIssuer);
    const due = invoice.dueDate ? Math.floor(invoice.dueDate.getTime() / 1000) : 0;

    const prepared = await this.contracts.prepareCall({
      source: merchant.settlementPublicKey,
      contractId,
      functionName: 'create',
      args: [
        this.contracts.network().accountScVal(merchant.settlementPublicKey),
        this.contracts.network().accountScVal(invoice.customerPublicKey),
        this.contracts.network().accountScVal(tokenAddress),
        this.contracts.network().i128ScVal(BigInt(toStroops(invoice.amount))),
        this.contracts.network().stringScVal(invoice.title),
        this.contracts.network().u64ScVal(BigInt(due)),
      ],
    });
    return {
      invoiceId: invoice.id,
      unsignedXdr: prepared.unsignedXdr,
      message: 'Sign the transaction with your wallet, then submit it',
    };
  }

  /** Submit the wallet-signed `create` (issue) envelope. */
  async submitIssueOnChain(merchantId: string, invoiceId: string, signedXdr: string) {
    const invoice = await this.findInvoice(merchantId, invoiceId);
    if (invoice.onChainId) {
      throw new BadRequestException('Invoice is already issued on-chain');
    }
    let result;
    try {
      result = await this.contracts.submitCall(signedXdr);
    } catch (err) {
      throw err;
    }
    if (result.status === 'FAILED') {
      throw new BadRequestException(`Invoice issue reverted on-chain: ${result.errorMessage}`);
    }
    const updated = await this.prisma.invoice.update({
      where: { id: invoice.id },
      data: { issueTxHash: result.hash ?? null },
    });
    // onChainId is assigned by the indexer when the `issued` event lands.
    return updated;
  }

  /** Prepare `cancel(merchant, invoice_id)` on the invoices contract. */
  async cancelOnChain(merchantId: string, invoiceId: string) {
    const invoice = await this.findInvoice(merchantId, invoiceId);
    if (!invoice.onChainId) {
      throw new BadRequestException('Invoice is not issued on-chain');
    }
    if (invoice.status === 'PAID' || invoice.status === 'CANCELED') {
      throw new BadRequestException(`Invoice is already ${invoice.status.toLowerCase()}`);
    }
    const merchant = await this.prisma.merchant.findUnique({ where: { id: merchantId } });
    if (!merchant) {
      throw new NotFoundException('Merchant not found');
    }
    await this.wallet.assertWalletOwnership(merchant.userId, merchant.settlementPublicKey);
    const contractId = this.contracts.requireContractAddress(INVOICES_CONTRACT_ENV, 'Invoices');
    const prepared = await this.contracts.prepareCall({
      source: merchant.settlementPublicKey,
      contractId,
      functionName: 'cancel',
      args: [
        this.contracts.network().accountScVal(merchant.settlementPublicKey),
        this.contracts.network().u64ScVal(BigInt(invoice.onChainId)),
      ],
    });
    return {
      invoiceId: invoice.id,
      unsignedXdr: prepared.unsignedXdr,
      message: 'Sign the transaction with your wallet, then submit it',
    };
  }

  /** Submit the wallet-signed on-chain `cancel` envelope. */
  async submitCancelOnChain(merchantId: string, invoiceId: string, signedXdr: string) {
    const invoice = await this.findInvoice(merchantId, invoiceId);
    let result;
    try {
      result = await this.contracts.submitCall(signedXdr);
    } catch (err) {
      throw err;
    }
    if (result.status === 'FAILED') {
      throw new BadRequestException(`Invoice cancel reverted on-chain: ${result.errorMessage}`);
    }
    // Indexer marks CANCELED on the `cancel` event.
    return this.prisma.invoice.update({
      where: { id: invoice.id },
      data: { issueTxHash: invoice.issueTxHash }, // unchanged — keeps row fresh
    });
  }

  /**
   * Pay an on-chain invoice: prepare `pay(payer, invoice_id)` where the payer
   * must be the invoice's customer (the contract enforces PayerMismatch).
   */
  async payOnChain(
    invoiceId: string,
    input: { payerPublicKey: string; payerUserId: string },
  ) {
    await this.wallet.assertWalletOwnership(input.payerUserId, input.payerPublicKey);
    const invoice = await this.prisma.invoice.findUnique({ where: { id: invoiceId } });
    if (!invoice) {
      throw new NotFoundException('Invoice not found');
    }
    if (!invoice.onChainId) {
      throw new BadRequestException('Invoice is not issued on-chain');
    }
    if (invoice.status !== 'ISSUED') {
      throw new BadRequestException(`Invoice is not payable (status: ${invoice.status})`);
    }
    if (invoice.customerPublicKey && invoice.customerPublicKey !== input.payerPublicKey) {
      throw new BadRequestException('Only the invoice customer can pay this on-chain invoice');
    }
    const contractId = this.contracts.requireContractAddress(INVOICES_CONTRACT_ENV, 'Invoices');
    const prepared = await this.contracts.prepareCall({
      source: input.payerPublicKey,
      contractId,
      functionName: 'pay',
      args: [
        this.contracts.network().accountScVal(input.payerPublicKey),
        this.contracts.network().u64ScVal(BigInt(invoice.onChainId)),
      ],
    });
    return {
      invoiceId: invoice.id,
      unsignedXdr: prepared.unsignedXdr,
      message: 'Sign the transaction with your wallet, then submit it',
    };
  }

  /** Submit the wallet-signed on-chain `pay` envelope. */
  async submitPayOnChain(invoiceId: string, signedXdr: string) {
    const invoice = await this.prisma.invoice.findUnique({ where: { id: invoiceId } });
    if (!invoice) {
      throw new NotFoundException('Invoice not found');
    }
    let result;
    try {
      result = await this.contracts.submitCall(signedXdr);
    } catch (err) {
      throw err;
    }
    if (result.status === 'FAILED') {
      throw new BadRequestException(`Invoice payment reverted on-chain: ${result.errorMessage}`);
    }
    // PAID + paidAt + webhook come from the indexer when the `paid` event
    // lands — the database is never optimistically marked paid.
    return { invoiceId: invoice.id, hash: result.hash, status: 'SUBMITTED' };
  }

  private async findInvoice(merchantId: string, id: string) {
    const invoice = await this.prisma.invoice.findFirst({ where: { id, merchantId } });
    if (!invoice) {
      throw new NotFoundException('Invoice not found');
    }
    return invoice;
  }
}
