import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@stellar-pay/database';
import { createStellarNetwork } from '../infra/stellar';
import { isValidPublicKey } from '@stellar-pay/shared';
import { TransactionReconciliationService } from '../payments/transaction-reconciliation.service';

@Injectable()
export class CheckoutService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly reconciliation: TransactionReconciliationService,
  ) {}

  private network() {
    return createStellarNetwork(this.config);
  }

  /** Public data for the hosted checkout page (payment links). */
  async getPaymentLink(code: string) {
    const link = await this.prisma.paymentLink.findUnique({
      where: { code },
      include: {
        merchant: {
          select: { name: true, slug: true, logoUrl: true, settlementPublicKey: true },
        },
      },
    });
    if (!link || link.status !== 'ACTIVE') {
      throw new NotFoundException('Payment link not found');
    }
    return {
      id: link.id,
      title: link.title,
      description: link.description,
      amount: link.amount,
      assetCode: link.assetCode,
      assetIssuer: link.assetIssuer,
      fixedAmount: link.fixedAmount,
      merchantName: link.merchant.name,
      merchantLogo: link.merchant.logoUrl,
      destination: link.merchant.settlementPublicKey,
      totalPayments: link.totalPayments,
      checkoutUrl: `${this.config.get('WEB_APP_URL')}/pay/${code}`,
    };
  }

  /** Public data for invoice checkout. */
  async getInvoice(number: string) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { number },
      include: {
        merchant: { select: { name: true, settlementPublicKey: true } },
      },
    });
    if (!invoice) {
      throw new NotFoundException('Invoice not found');
    }
    return {
      id: invoice.id,
      number: invoice.number,
      title: invoice.title,
      description: invoice.description,
      items: invoice.items,
      amount: invoice.amount,
      assetCode: invoice.assetCode,
      assetIssuer: invoice.assetIssuer,
      status: invoice.status,
      merchantName: invoice.merchant.name,
      destination: invoice.merchant.settlementPublicKey,
      checkoutUrl: `${this.config.get('WEB_APP_URL')}/checkout/invoice/${number}`,
    };
  }

  /**
   * Build an unsigned payment XDR for a payer paying a payment link
   * (no account/session required).
   */
  async payPaymentLink(code: string, payerPublicKey: string, amount?: string) {
    if (!isValidPublicKey(payerPublicKey)) {
      throw new BadRequestException('Invalid payer public key');
    }
    const link = await this.getPaymentLink(code);
    const effectiveAmount = amount ?? link.amount;
    if (!effectiveAmount) {
      throw new BadRequestException('This payment link requires an amount');
    }

    const xdr = await this.network().buildPaymentTransaction({
      from: payerPublicKey,
      to: link.destination,
      amount: effectiveAmount,
      assetCode: link.assetCode,
      assetIssuer: link.assetIssuer,
      memo: `pay-${code}`,
      memoType: 'text',
    });

    const transaction = await this.prisma.transaction.create({
      data: {
        userId: null,
        fromPublicKey: payerPublicKey,
        toPublicKey: link.destination,
        amount: effectiveAmount,
        assetCode: link.assetCode,
        assetIssuer: link.assetIssuer,
        memo: `pay-${code}`,
        memoType: 'text',
        status: 'PENDING',
        direction: 'OUTGOING',
        kind: 'payment_link',
        sourceNetwork: this.config.get<string>('STELLAR_NETWORK') ?? 'testnet',
        meta: { type: 'PAYMENT_LINK', paymentLinkCode: code },
      },
    });
    return { id: transaction.id, unsignedXdr: xdr, amount: effectiveAmount };
  }

  /** Public invoice checkout: build XDR for invoice payment. */
  async payInvoice(number: string, payerPublicKey: string) {
    if (!isValidPublicKey(payerPublicKey)) {
      throw new BadRequestException('Invalid payer public key');
    }
    const invoice = await this.getInvoice(number);
    if (invoice.status === 'PAID') {
      throw new BadRequestException('Invoice already paid');
    }
    const xdr = await this.network().buildPaymentTransaction({
      from: payerPublicKey,
      to: invoice.destination,
      amount: invoice.amount,
      assetCode: invoice.assetCode,
      assetIssuer: invoice.assetIssuer,
      memo: invoice.number,
      memoType: 'text',
    });
    const transaction = await this.prisma.transaction.create({
      data: {
        userId: null,
        fromPublicKey: payerPublicKey,
        toPublicKey: invoice.destination,
        amount: invoice.amount,
        assetCode: invoice.assetCode,
        assetIssuer: invoice.assetIssuer,
        memo: invoice.number,
        memoType: 'text',
        status: 'PENDING',
        direction: 'OUTGOING',
        kind: 'invoice',
        sourceNetwork: this.config.get<string>('STELLAR_NETWORK') ?? 'testnet',
        meta: { type: 'INVOICE', invoiceNumber: invoice.number },
      },
    });
    return { id: transaction.id, unsignedXdr: xdr, amount: invoice.amount };
  }

  /** Submit a signed checkout XDR (public endpoint). */
  async submitSigned(transactionId: string, signedXdr: string) {
    const tx = await this.prisma.transaction.findUnique({ where: { id: transactionId } });
    if (!tx) {
      throw new NotFoundException('Transaction not found');
    }

    // Atomically claim PENDING → SUBMITTED so a duplicate/concurrent submit of
    // the same intent is rejected before it can reach the network twice.
    const claim = await this.prisma.transaction.updateMany({
      where: { id: transactionId, status: 'PENDING' },
      data: { status: 'SUBMITTED' },
    });
    if (claim.count !== 1) {
      throw new BadRequestException('Transaction already submitted');
    }

    // A transport/infrastructure failure (timeout, Horizon unreachable) is not
    // a payment failure: revert the claim so the payer can retry.
    let result;
    try {
      result = await this.network().submitSignedTransaction(signedXdr);
    } catch (err) {
      await this.prisma.transaction.updateMany({
        where: { id: transactionId, status: 'SUBMITTED' },
        data: { status: 'PENDING' },
      });
      throw err;
    }
    const updated = await this.prisma.transaction.update({
      where: { id: transactionId },
      data: {
        hash: result.hash || null,
        status: result.status,
        fee: result.fee,
        errorMessage: result.errorMessage,
      },
    });

    // A successful public-checkout payment must still reconcile the merchant
    // side: mark invoices PAID (notifying the merchant), bump payment-link
    // stats, and dispatch webhooks. There is no payer user session here, so
    // payer-scoped notifications are skipped (callers with a user handle that
    // separately in PaymentsService).
    if (updated.status === 'SUCCEEDED') {
      await this.reconciliation.onPaymentSucceeded(updated);
    }

    return { status: result.status, hash: result.hash, errorMessage: result.errorMessage };
  }
}
