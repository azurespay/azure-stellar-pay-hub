import { PaymentLinksService } from './payment-links.service';

describe('PaymentLinksService', () => {
  let service: PaymentLinksService;
  let mockPrisma: Record<string, any>;

  beforeEach(() => {
    mockPrisma = {
      paymentLink: {
        findUnique: jest.fn(),
        create: jest.fn(),
        findMany: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    service = new PaymentLinksService(mockPrisma as any);
  });

  it('expires only ACTIVE links whose expiry has passed', async () => {
    mockPrisma.paymentLink.updateMany.mockResolvedValue({ count: 2 });

    const count = await service.expireDue();

    expect(count).toBe(2);
    expect(mockPrisma.paymentLink.updateMany).toHaveBeenCalledWith({
      where: { status: 'ACTIVE', expiresAt: { lte: expect.any(Date) } },
      data: { status: 'EXPIRED' },
    });
  });

  it('returns 0 when nothing is due (no spurious state changes)', async () => {
    const count = await service.expireDue();
    expect(count).toBe(0);
  });

  it('does not touch links without an expiry or already EXPIRED links', async () => {
    await service.expireDue();
    const { where } = mockPrisma.paymentLink.updateMany.mock.calls[0][0];
    expect(where.status).toBe('ACTIVE'); // EXPIRED/PAUSED links excluded
    expect(where.expiresAt.lte).toBeInstanceOf(Date);
  });
});
