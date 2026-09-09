import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@stellar-pay/database';
import { addAmounts } from '@stellar-pay/shared';
import { randomBytes } from 'crypto';
import type { CreateInvoice } from '@stellar-pay/validation';

@Injectable()
export class InvoicesService {
  constructor(private readonly prisma: PrismaService) {}

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
}
