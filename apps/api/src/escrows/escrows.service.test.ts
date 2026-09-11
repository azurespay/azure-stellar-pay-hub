import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { EscrowsService } from './escrows.service';

describe('EscrowsService', () => {
  let service: EscrowsService;
  let mockPrisma: Record<string, any>;
  let mockWallet: Record<string, jest.Mock>;
  let mockRealtime: Record<string, jest.Mock>;
  let mockNotifications: Record<string, jest.Mock>;
  let mockContracts: Record<string, any>;

  const escrowRow = {
    id: 'esc-1',
    userId: 'user-1',
    contractId: 5,
    initiatorPublicKey: 'GINIT',
    counterpartyPublicKey: 'GCOUNTER',
    arbiterPublicKey: null,
    assetCode: 'XLM',
    amount: '10',
    status: 'FUNDED',
    releaseHash: null,
    refundHash: null,
    releaseTime: new Date(),
    expiry: null,
  };

  beforeEach(() => {
    mockPrisma = {
      escrow: {
        create: jest.fn().mockImplementation(({ data }) => ({ id: 'esc-1', ...data })),
        findFirst: jest.fn().mockResolvedValue(escrowRow),
        findMany: jest.fn().mockResolvedValue([escrowRow]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockImplementation(({ data }) => ({ ...escrowRow, ...data })),
      },
      wallet: {
        // `myKeys` powers party visibility (release/refund by a party account).
        findMany: jest.fn().mockResolvedValue([{ publicKey: 'GCOUNTER' }]),
      },
    };
    mockWallet = { assertWalletOwnership: jest.fn().mockResolvedValue(undefined) };
    mockRealtime = { emitToUser: jest.fn() };
    mockNotifications = { paymentFailed: jest.fn().mockResolvedValue(undefined) };
    mockContracts = {
      requireContractAddress: jest.fn().mockReturnValue('CESCROW'),
      tokenAddress: jest.fn().mockReturnValue('CTOKEN'),
      prepareCall: jest.fn().mockResolvedValue({
        unsignedXdr: 'AAAA',
        minResourceFee: '100',
        latestLedger: 1,
      }),
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
    service = new EscrowsService(
      mockPrisma as never,
      mockWallet as never,
      mockRealtime as never,
      mockNotifications as never,
      mockContracts as never,
    );
  });

  describe('create', () => {
    const dto = {
      initiatorPublicKey: 'GINIT',
      counterpartyPublicKey: 'GCOUNTER',
      assetCode: 'XLM',
      amount: '10',
      releaseTime: '2030-01-01T00:00:00.000Z',
    };

    it('prepares the contract create call and stores an AWAITING_SIGN row', async () => {
      const result = await service.create('user-1', dto as never);
      expect(result.unsignedXdr).toBe('AAAA');
      expect(mockPrisma.escrow.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ status: 'AWAITING_SIGN', userId: 'user-1' }),
      });
      expect(mockContracts.prepareCall).toHaveBeenCalledWith(
        expect.objectContaining({ contractId: 'CESCROW', functionName: 'create' }),
      );
    });

    it('rejects an expiry before the release time', async () => {
      await expect(
        service.create('user-1', { ...dto, expiry: '2029-01-01T00:00:00.000Z' } as never),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws 503 when the escrow contract is not configured', async () => {
      mockContracts.requireContractAddress.mockImplementation(() => {
        throw new ServiceUnavailableException('not configured');
      });
      await expect(service.create('user-1', dto as never)).rejects.toThrow(
        ServiceUnavailableException,
      );
    });

    it('requires wallet ownership of the initiator key', async () => {
      mockWallet.assertWalletOwnership.mockRejectedValue(
        new NotFoundException('Wallet not linked'),
      );
      await expect(service.create('user-1', dto as never)).rejects.toThrow(NotFoundException);
    });
  });

  describe('submit', () => {
    it('atomically claims AWAITING_SIGN → SUBMITTED and persists the hash', async () => {
      mockPrisma.escrow.findFirst.mockResolvedValue({ ...escrowRow, status: 'AWAITING_SIGN' });
      const result = await service.submit('user-1', 'esc-1', 'signed-xdr');
      expect(mockPrisma.escrow.updateMany).toHaveBeenCalledWith({
        where: { id: 'esc-1', status: 'AWAITING_SIGN' },
        data: { status: 'SUBMITTED' },
      });
      expect(result.hash).toBe('hash-1');
    });

    it('rejects a second submit (claim loses the race)', async () => {
      mockPrisma.escrow.findFirst.mockResolvedValue({ ...escrowRow, status: 'AWAITING_SIGN' });
      mockPrisma.escrow.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.submit('user-1', 'esc-1', 'signed-xdr')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('reverts the claim to AWAITING_SIGN on transport failure so the user can retry', async () => {
      mockPrisma.escrow.findFirst.mockResolvedValue({ ...escrowRow, status: 'AWAITING_SIGN' });
      mockContracts.submitCall.mockRejectedValue(new Error('rpc down'));
      await expect(service.submit('user-1', 'esc-1', 'signed-xdr')).rejects.toThrow('rpc down');
      expect(mockPrisma.escrow.updateMany).toHaveBeenLastCalledWith({
        where: { id: 'esc-1', status: 'SUBMITTED' },
        data: { status: 'AWAITING_SIGN' },
      });
    });

    it('persists FAILED when the invocation reverted on-chain', async () => {
      mockPrisma.escrow.findFirst.mockResolvedValue({ ...escrowRow, status: 'AWAITING_SIGN' });
      mockContracts.submitCall.mockResolvedValue({
        hash: 'hash-2',
        status: 'FAILED',
        errorMessage: 'contract revert: escrow error',
      });
      await expect(service.submit('user-1', 'esc-1', 'signed-xdr')).rejects.toThrow(
        BadRequestException,
      );
      expect(mockPrisma.escrow.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'FAILED' }),
        }),
      );
    });
  });

  describe('release / refund authorization', () => {
    it('allows the counterparty to prepare a release', async () => {
      mockPrisma.escrow.findFirst.mockResolvedValue(escrowRow);
      const result = await service.release('user-1', 'esc-1', 'GCOUNTER');
      expect(result.action).toBe('release');
      expect(result.unsignedXdr).toBe('AAAA');
    });

    it('rejects a caller who is not a party (server-side authorization)', async () => {
      mockPrisma.escrow.findFirst.mockResolvedValue(escrowRow);
      await expect(service.release('user-1', 'esc-1', 'GINTRUDER')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('blocks release before the escrow is funded on-chain', async () => {
      mockPrisma.escrow.findFirst.mockResolvedValue({ ...escrowRow, contractId: null });
      await expect(service.release('user-1', 'esc-1', 'GCOUNTER')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('blocks a second in-flight release', async () => {
      mockPrisma.escrow.findFirst.mockResolvedValue({
        ...escrowRow,
        releaseHash: 'already-submitted',
      });
      await expect(service.release('user-1', 'esc-1', 'GCOUNTER')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('requires the escrow to be FUNDED before confirming a release', async () => {
      mockPrisma.escrow.findFirst.mockResolvedValue({ ...escrowRow, status: 'AWAITING_SIGN' });
      await expect(
        service.confirmAction('user-1', 'esc-1', 'release', 'signed-xdr'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('ownership scoping', () => {
    it('returns 404 for escrows owned by another user', async () => {
      mockPrisma.escrow.findFirst.mockResolvedValue(null);
      await expect(service.get('user-2', 'esc-1')).rejects.toThrow(NotFoundException);
    });
  });
});
