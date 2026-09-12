import { NotFoundException } from '@nestjs/common';
import type { PrismaService } from '@stellar-pay/database';
import type { CreateInvoice } from '@stellar-pay/validation';
import { InvoicesService } from './invoices.service';
import type { WalletService } from '../wallet/wallet.service';
import type { RealtimeGateway } from '../realtime/realtime.gateway';
import type { ContractIntegrationService } from '../contracts/contract-integration.service';

describe('InvoicesService', () => {
  let service: InvoicesService;
  let mockPrisma: Record<string, any>;
  let mockWallet: Record<string, jest.Mock>;
  let mockRealtime: Record<string, jest.Mock>;
  let mockContracts: Record<string, any>;

  beforeEach(() => {
    mockPrisma = {
      merchant: {
        findUnique: jest.fn().mockResolvedValue({ id: 'merchant-1', name: 'Acme' }),
      },
      invoice: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(({ data }) => ({ id: 'inv-1', ...data })),
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn(),
        update: jest.fn(),
      },
      customer: {
        upsert: jest.fn().mockImplementation(({ create }) => ({ id: 'cust-1', ...create })),
      },
    };
    mockWallet = { assertWalletOwnership: jest.fn().mockResolvedValue(undefined) };
    mockRealtime = { emitToUser: jest.fn() };
    mockContracts = {
      requireContractAddress: jest.fn().mockReturnValue('CCONTRACT'),
      tokenAddress: jest.fn().mockReturnValue('CTOKEN'),
      prepareCall: jest
        .fn()
        .mockResolvedValue({ unsignedXdr: 'AAAA', minResourceFee: '100', latestLedger: 1 }),
      submitCall: jest.fn().mockResolvedValue({ hash: 'hash-1', status: 'SUCCEEDED', fee: '100' }),
      network: jest.fn().mockReturnValue({
        accountScVal: jest.fn(),
        stringScVal: jest.fn(),
        u64ScVal: jest.fn(),
        i128ScVal: jest.fn(),
        optionScVal: jest.fn(),
        u32ScVal: jest.fn(),
        boolScVal: jest.fn(),
      }),
    };
    service = new InvoicesService(
      mockPrisma as unknown as PrismaService,
      mockWallet as unknown as WalletService,
      mockRealtime as unknown as RealtimeGateway,
      mockContracts as unknown as ContractIntegrationService,
    );
  });

  describe('create', () => {
    const baseInput: CreateInvoice = {
      title: 'Consulting',
      description: 'Q3 engagement',
      items: [{ name: 'Hours', currency: 'USD', quantity: 2, unitPrice: '100' }],
      assetCode: 'USDC',
    };

    it('computes the amount from items and persists with a generated number', async () => {
      const result = await service.create('merchant-1', baseInput);

      expect(mockPrisma.invoice.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          number: expect.stringMatching(/^INV-\d{4}-[A-F0-9]{8}$/),
          merchantId: 'merchant-1',
          amount: '200',
          assetCode: 'USDC',
          status: 'ISSUED',
        }),
      });
      expect(result.number).toMatch(/^INV-\d{4}-[A-F0-9]{8}$/);
    });

    it('throws NotFoundException when the merchant does not exist', async () => {
      mockPrisma.merchant.findUnique.mockResolvedValue(null);
      await expect(service.create('merchant-x', baseInput)).rejects.toThrow(NotFoundException);
      expect(mockPrisma.invoice.create).not.toHaveBeenCalled();
    });

    it('generates a fresh number on the (unlikely) unique collision', async () => {
      // First draw collides with an existing invoice, second succeeds.
      mockPrisma.invoice.findUnique
        .mockResolvedValueOnce({ id: 'existing' })
        .mockResolvedValueOnce(null);
      const result = await service.create('merchant-1', baseInput);
      expect(mockPrisma.invoice.findUnique).toHaveBeenCalledTimes(2);
      expect(result.number).toMatch(/^INV-\d{4}-[A-F0-9]{8}$/);
    });

    it('upserts the customer when customerPublicKey is provided', async () => {
      await service.create('merchant-1', {
        ...baseInput,
        customerPublicKey: 'GCUSTOMER',
        customerEmail: 'c@example.com',
        customerName: 'Carla',
      });

      expect(mockPrisma.customer.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { merchantId_publicKey: { merchantId: 'merchant-1', publicKey: 'GCUSTOMER' } },
        }),
      );
    });
  });

  describe('list / getByNumber / cancel', () => {
    it('lists invoices for the merchant', async () => {
      await service.list('merchant-1');
      expect(mockPrisma.invoice.findMany).toHaveBeenCalledWith({
        where: { merchantId: 'merchant-1' },
        orderBy: { createdAt: 'desc' },
      });
    });

    it('returns an invoice by number with the merchant name', async () => {
      mockPrisma.invoice.findUnique.mockResolvedValue({
        id: 'inv-1',
        number: 'INV-2026-ABC',
        merchant: { name: 'Acme' },
      });
      const result = await service.getByNumber('INV-2026-ABC');
      expect(result.merchant.name).toBe('Acme');
    });

    it('throws when cancelling an invoice owned by another merchant (owner-scoped)', async () => {
      mockPrisma.invoice.findFirst.mockResolvedValue(null);
      await expect(service.cancel('merchant-2', 'inv-1')).rejects.toThrow(NotFoundException);
      expect(mockPrisma.invoice.update).not.toHaveBeenCalled();
    });
  });
});
