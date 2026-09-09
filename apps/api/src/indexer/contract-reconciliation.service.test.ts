import { ConfigService } from '@nestjs/config';
import { Asset, Keypair, Networks, StrKey, xdr } from '@stellar/stellar-sdk';
import { ContractReconciliationService } from './contract-reconciliation.service';

const ESCROW = 'CESCROW_123';
const INVOICES = 'CINVOICES_123';
const TREASURY = 'CTREASURY_123';
const MERCHANT = 'CMERCHANT_123';

function keyedConfig(map: Record<string, unknown>) {
  return { get: jest.fn((key: string) => map[key]) } as unknown as ConfigService;
}

function accountScVal(publicKey: string): xdr.ScVal {
  return xdr.ScVal.scvAddress(
    xdr.ScAddress.scAddressTypeAccount(
      xdr.PublicKey.publicKeyTypeEd25519(StrKey.decodeEd25519PublicKey(publicKey)),
    ),
  );
}

function i128(stroops: bigint): xdr.ScVal {
  return xdr.ScVal.scvI128(
    new xdr.Int128Parts({
      lo: stroops,
      hi: 0n,
    } as unknown as ConstructorParameters<typeof xdr.Int128Parts>[0]),
  );
}

function u64(value: bigint): xdr.ScVal {
  return xdr.ScVal.scvU64(value as never);
}

function topic(name: string): string[] {
  return [xdr.ScVal.scvSymbol(name).toXDR('base64').toString()];
}

function value(fields: xdr.ScVal[]): string {
  return xdr.ScVal.scvVec(fields).toXDR('base64').toString();
}

function contractScVal(contractId: string): xdr.ScVal {
  return xdr.ScVal.scvAddress(
    xdr.ScAddress.scAddressTypeContract(
      StrKey.decodeContract(contractId) as unknown as xdr.Hash,
    ),
  );
}

describe('ContractReconciliationService', () => {
  let service: ContractReconciliationService;
  let mockPrisma: Record<string, any>;
  let mockRealtime: Record<string, jest.Mock>;
  let mockNotifications: Record<string, jest.Mock>;
  let mockWebhooks: Record<string, jest.Mock>;

  const payer = Keypair.random().publicKey();
  const counterparty = Keypair.random().publicKey();
  const merchantKey = Keypair.random().publicKey();
  // Native XLM SAC on testnet — merchant sale credits are XLM-only for now.
  const nativeSac = Asset.native().contractId(Networks.TESTNET);

  beforeEach(() => {
    mockPrisma = {
      escrow: { updateMany: jest.fn().mockResolvedValue({ count: 1 }), findFirst: jest.fn() },
      invoice: { updateMany: jest.fn().mockResolvedValue({ count: 1 }), findUnique: jest.fn() },
      treasuryWithdrawal: { updateMany: jest.fn().mockResolvedValue({ count: 1 }), findUnique: jest.fn(), update: jest.fn() },
      merchant: { updateMany: jest.fn().mockResolvedValue({ count: 1 }), findFirst: jest.fn(), findUnique: jest.fn() },
      settlement: { updateMany: jest.fn().mockResolvedValue({ count: 1 }), findFirst: jest.fn() },
      chainEvent: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn() },
      transaction: { create: jest.fn() },
    };
    mockRealtime = { emitToUser: jest.fn() };
    mockNotifications = {
      invoicePaid: jest.fn().mockResolvedValue(undefined),
      paymentReceived: jest.fn().mockResolvedValue(undefined),
    };
    mockWebhooks = { dispatch: jest.fn().mockResolvedValue(undefined) };
    service = new ContractReconciliationService(
      mockPrisma as any,
      keyedConfig({
        CONTRACT_STELLAR_PAY_ESCROW: ESCROW,
        CONTRACT_STELLAR_PAY_INVOICES: INVOICES,
        CONTRACT_STELLAR_PAY_TREASURY: TREASURY,
        CONTRACT_STELLAR_PAY_MERCHANT: MERCHANT,
      }),
      mockRealtime as any,
      mockNotifications as any,
      mockWebhooks as any,
    );
  });

  describe('escrow reconciliation', () => {
    it('funds an escrow on the `created` event, correlating by tx hash', async () => {
      mockPrisma.escrow.findFirst.mockResolvedValue({ id: 'esc-1', userId: 'u1' });
      await service.reconcile({
        contractId: ESCROW,
        eventId: 'evt-1',
        txHash: 'tx-create',
        topic: topic('created'),
        value: value([u64(5n), accountScVal(payer), accountScVal(counterparty), i128(100_000_000n)]),
      });
      expect(mockPrisma.escrow.updateMany).toHaveBeenCalledWith({
        where: { hash: 'tx-create', status: 'SUBMITTED' },
        data: { contractId: 5, status: 'FUNDED' },
      });
      expect(mockRealtime.emitToUser).toHaveBeenCalledWith('u1', 'escrow.updated', {
        id: 'esc-1',
        status: 'FUNDED',
        contractId: 5,
      });
    });

    it('is idempotent: a re-delivered `created` event (lost race) fires no side effects', async () => {
      mockPrisma.escrow.updateMany.mockResolvedValue({ count: 0 });
      await service.reconcile({
        contractId: ESCROW,
        eventId: 'evt-1-dup',
        txHash: 'tx-create',
        topic: topic('created'),
        value: value([u64(5n), accountScVal(payer), accountScVal(counterparty), i128(100_000_000n)]),
      });
      expect(mockPrisma.escrow.updateMany).toHaveBeenCalledTimes(1);
      expect(mockRealtime.emitToUser).not.toHaveBeenCalled();
    });
  });

  describe('invoice reconciliation (guarded PAID transition)', () => {
    it('marks an on-chain invoice PAID on the `paid` event + notifies + webhooks', async () => {
      mockPrisma.invoice.findUnique.mockResolvedValue({
        id: 'inv-1',
        number: 'INV-2026-1',
        merchantId: 'm-1',
        amount: '5',
        assetCode: 'USDC',
        merchant: { userId: 'u-merchant', id: 'm-1' },
      });
      await service.reconcile({
        contractId: INVOICES,
        eventId: 'evt-paid',
        txHash: 'tx-paid',
        topic: topic('paid'),
        value: value([u64(9n), accountScVal(payer), accountScVal(merchantKey), i128(50_000_000n)]),
      });
      expect(mockPrisma.invoice.updateMany).toHaveBeenCalledWith({
        where: { onChainId: 9, status: 'ISSUED' },
        data: { status: 'PAID', paidAt: expect.any(Date) },
      });
      expect(mockNotifications.invoicePaid).toHaveBeenCalledWith({
        merchantId: 'm-1',
        invoiceNumber: 'INV-2026-1',
      });
      expect(mockWebhooks.dispatch).toHaveBeenCalledWith(
        'invoice.paid',
        expect.objectContaining({ invoiceId: 'inv-1', number: 'INV-2026-1', hash: 'tx-paid' }),
        { merchantId: 'm-1' },
      );
    });

    it('does not re-mark an already-paid invoice (guarded transition)', async () => {
      mockPrisma.invoice.updateMany.mockResolvedValue({ count: 0 });
      await service.reconcile({
        contractId: INVOICES,
        eventId: 'evt-paid-dup',
        txHash: 'tx-paid',
        topic: topic('paid'),
        value: value([u64(9n), accountScVal(payer), accountScVal(merchantKey), i128(50_000_000n)]),
      });
      expect(mockNotifications.invoicePaid).not.toHaveBeenCalled();
      expect(mockWebhooks.dispatch).not.toHaveBeenCalled();
    });
  });

  describe('merchant reconciliation', () => {
    it('credits a merchant sale exactly once (ChainEvent dedupe backstop)', async () => {
      mockPrisma.merchant.findUnique.mockResolvedValue({
        id: 'm-1',
        userId: 'u-merchant',
        settlementPublicKey: 'GSETTLE',
      });
      await service.reconcile({
        contractId: MERCHANT,
        eventId: 'evt-sale',
        txHash: 'tx-sale',
        topic: topic('sale'),
        value: value([u64(1n), contractScVal(nativeSac), i128(9_000_000n)]),
      });
      expect(mockPrisma.transaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          amount: '0.9',
          assetCode: 'XLM',
          status: 'CONFIRMED',
          direction: 'INCOMING',
          kind: 'merchant_sale',
        }),
      });
      expect(mockWebhooks.dispatch).toHaveBeenCalledWith(
        'payment.received',
        expect.objectContaining({ merchantId: 'm-1', amount: '0.9' }),
        { merchantId: 'm-1' },
      );

      // Re-delivery (cursor loss) is skipped by the ChainEvent unique ledger.
      mockPrisma.chainEvent.findUnique.mockResolvedValue({ id: 'existing' });
      await service.reconcile({
        contractId: MERCHANT,
        eventId: 'evt-sale',
        txHash: 'tx-sale',
        topic: topic('sale'),
        value: value([u64(1n), contractScVal(nativeSac), i128(9_000_000n)]),
      });
      expect(mockPrisma.transaction.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('unknown contract events', () => {
    it('ignores events from contracts the platform does not watch', async () => {
      await service.reconcile({
        contractId: 'CSOME_OTHER_CONTRACT',
        eventId: 'evt-x',
        txHash: 'tx-x',
        topic: topic('paid'),
        value: value([u64(1n), accountScVal(payer), accountScVal(merchantKey), i128(1n)]),
      });
      expect(mockPrisma.invoice.updateMany).not.toHaveBeenCalled();
      expect(mockPrisma.escrow.updateMany).not.toHaveBeenCalled();
    });
  });
});