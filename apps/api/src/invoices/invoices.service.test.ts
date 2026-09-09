import { NotFoundException } from '@nestjs/common';
import { InvoicesService } from './invoices.service';

describe('InvoicesService', () => {
  let service: InvoicesService;
  let mockPrisma: Record<string, any>;

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
    service = new InvoicesService(mockPrisma as never);
  });

  describe('create', () => {
    const baseInput = {
      title: 'Consulting',
      description: 'Q3 engagement',
      items: [{ description: 'Hours', unitPrice: '100', quantity: 2 }],
      assetCode: 'USDC',
    };

    it('computes the amount from items and persists with a generated number', async () => {
      const result = await service.create('merchant-1', baseInput as never);

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
      await expect(service.create('merchant-x', baseInput as never)).rejects.toThrow(
        NotFoundException,
      );
      expect(mockPrisma.invoice.create).not.toHaveBeenCalled();
    });

    it('generates a fresh number on the (unlikely) unique collision', async () => {
      // First draw collides with an existing invoice, second succeeds.
      mockPrisma.invoice.findUnique
        .mockResolvedValueOnce({ id: 'existing' })
        .mockResolvedValueOnce(null);
      const result = await service.create('merchant-1', baseInput as never);
      expect(mockPrisma.invoice.findUnique).toHaveBeenCalledTimes(2);
      expect(result.number).toMatch(/^INV-\d{4}-[A-F0-9]{8}$/);
    });

    it('upserts the customer when customerPublicKey is provided', async () => {
      await service.create('merchant-1', {
        ...baseInput,
        customerPublicKey: 'GCUSTOMER',
        customerEmail: 'c@example.com',
        customerName: 'Carla',
      } as never);

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
