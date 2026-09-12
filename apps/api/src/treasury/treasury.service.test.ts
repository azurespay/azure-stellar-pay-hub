import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { PrismaService } from '@stellar-pay/database';
import type { TreasuryDeposit, TreasuryProposeWithdrawal } from '@stellar-pay/validation';
import { TreasuryService } from './treasury.service';
import type { WalletService } from '../wallet/wallet.service';
import type { RealtimeGateway } from '../realtime/realtime.gateway';
import type { ContractIntegrationService } from '../contracts/contract-integration.service';

describe('TreasuryService', () => {
  let service: TreasuryService;
  let mockPrisma: Record<string, any>;
  let mockWallet: Record<string, jest.Mock>;
  let mockRealtime: Record<string, jest.Mock>;
  let mockContracts: Record<string, any>;

  const depositRow = {
    id: 'op-1',
    userId: 'user-1',
    type: 'DEPOSIT',
    status: 'AWAITING_SIGN',
    hash: null,
    amount: '2',
    assetCode: 'XLM',
  };

  const withdrawalRow = {
    id: 'wd-1',
    userId: 'user-1',
    status: 'PROPOSED',
    contractWithdrawalId: 7,
    approveHash: null,
    executedHash: null,
    hash: 'propose-hash',
    approvals: [] as string[],
    threshold: 2,
    amount: '1',
    toPublicKey: 'GTO',
  };

  beforeEach(() => {
    mockPrisma = {
      treasuryOperation: {
        create: jest.fn().mockImplementation(({ data }) => ({ id: 'op-1', ...data })),
        findFirst: jest.fn().mockResolvedValue(depositRow),
        findMany: jest.fn().mockResolvedValue([depositRow]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockImplementation(({ data }) => ({ ...depositRow, ...data })),
      },
      treasuryWithdrawal: {
        create: jest.fn().mockImplementation(({ data }) => ({ id: 'wd-1', ...data })),
        findFirst: jest.fn().mockResolvedValue(withdrawalRow),
        findMany: jest.fn().mockResolvedValue([withdrawalRow]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockImplementation(({ data }) => ({ ...withdrawalRow, ...data })),
      },
    };
    mockWallet = { assertWalletOwnership: jest.fn().mockResolvedValue(undefined) };
    mockRealtime = { emitToUser: jest.fn() };
    mockContracts = {
      requireContractAddress: jest.fn().mockReturnValue('CTREASURY'),
      tokenAddress: jest.fn().mockReturnValue('CTOKEN'),
      prepareCall: jest.fn().mockResolvedValue({
        unsignedXdr: 'AAAA',
        minResourceFee: '100',
        latestLedger: 1,
      }),
      submitCall: jest.fn().mockResolvedValue({ hash: 'hash-1', status: 'SUCCEEDED', fee: '100' }),
      network: jest.fn().mockReturnValue({
        accountScVal: jest.fn(),
        i128ScVal: jest.fn(),
        u64ScVal: jest.fn(),
      }),
    };
    service = new TreasuryService(
      mockPrisma as unknown as PrismaService,
      mockWallet as unknown as WalletService,
      mockRealtime as unknown as RealtimeGateway,
      mockContracts as unknown as ContractIntegrationService,
    );
  });

  describe('deposits', () => {
    const dto: TreasuryDeposit = { fromPublicKey: 'GFROM', assetCode: 'XLM', amount: '2' };

    it('prepares the contract deposit and stores an AWAITING_SIGN row', async () => {
      const result = await service.createDeposit('user-1', dto);
      expect(result.unsignedXdr).toBe('AAAA');
      expect(mockPrisma.treasuryOperation.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ type: 'DEPOSIT', status: 'AWAITING_SIGN' }),
      });
      expect(mockContracts.prepareCall).toHaveBeenCalledWith(
        expect.objectContaining({ contractId: 'CTREASURY', functionName: 'deposit' }),
      );
    });

    it('requires wallet ownership of the depositing key', async () => {
      mockWallet.assertWalletOwnership.mockRejectedValue(
        new NotFoundException('Wallet not linked'),
      );
      await expect(service.createDeposit('user-1', dto)).rejects.toThrow(NotFoundException);
    });

    it('throws 503 when the treasury contract is not configured', async () => {
      mockContracts.requireContractAddress.mockImplementation(() => {
        throw new ServiceUnavailableException('not configured');
      });
      await expect(service.createDeposit('user-1', dto)).rejects.toThrow(
        ServiceUnavailableException,
      );
    });

    it('atomically claims AWAITING_SIGN → SUBMITTED and persists the hash', async () => {
      const result = await service.submitDeposit('user-1', 'op-1', 'signed-xdr');
      expect(mockPrisma.treasuryOperation.updateMany).toHaveBeenCalledWith({
        where: { id: 'op-1', type: 'DEPOSIT', status: 'AWAITING_SIGN' },
        data: { status: 'SUBMITTED' },
      });
      expect(result.hash).toBe('hash-1');
    });

    it('rejects a submit that is not awaiting signature', async () => {
      mockPrisma.treasuryOperation.findFirst.mockResolvedValue({
        ...depositRow,
        status: 'SUBMITTED',
      });
      await expect(service.submitDeposit('user-1', 'op-1', 'signed-xdr')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects a duplicate submit (claim loses the race)', async () => {
      mockPrisma.treasuryOperation.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.submitDeposit('user-1', 'op-1', 'signed-xdr')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('reverts the claim to AWAITING_SIGN on transport failure so the user can retry', async () => {
      mockContracts.submitCall.mockRejectedValue(new Error('rpc down'));
      await expect(service.submitDeposit('user-1', 'op-1', 'signed-xdr')).rejects.toThrow(
        'rpc down',
      );
      expect(mockPrisma.treasuryOperation.updateMany).toHaveBeenLastCalledWith({
        where: { id: 'op-1', status: 'SUBMITTED' },
        data: { status: 'AWAITING_SIGN' },
      });
    });

    it('persists FAILED when the invocation reverted on-chain', async () => {
      mockContracts.submitCall.mockResolvedValue({
        hash: 'hash-2',
        status: 'FAILED',
        errorMessage: 'contract revert: treasury error',
      });
      await expect(service.submitDeposit('user-1', 'op-1', 'signed-xdr')).rejects.toThrow(
        BadRequestException,
      );
      expect(mockPrisma.treasuryOperation.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }),
      );
      expect(mockRealtime.emitToUser).toHaveBeenCalledWith('user-1', 'treasury-operation.updated', {
        id: 'op-1',
        status: 'FAILED',
      });
    });
  });

  describe('governed withdrawals', () => {
    const proposeDto: TreasuryProposeWithdrawal = {
      proposerPublicKey: 'GPROPOSER',
      toPublicKey: 'GTO',
      assetCode: 'XLM',
      amount: '1',
    };

    it('prepares propose_withdraw and stores a PROPOSED row', async () => {
      const result = await service.proposeWithdrawal('user-1', proposeDto);
      expect(result.unsignedXdr).toBe('AAAA');
      expect(mockPrisma.treasuryWithdrawal.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ status: 'PROPOSED', approvals: [] }),
      });
      expect(mockContracts.prepareCall).toHaveBeenCalledWith(
        expect.objectContaining({ functionName: 'propose_withdraw' }),
      );
    });

    it('rejects a second proposal once the withdrawal exists on-chain', async () => {
      await expect(service.submitProposal('user-1', 'wd-1', 'signed-xdr')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('persists FAILED when the proposal reverted on-chain', async () => {
      mockPrisma.treasuryWithdrawal.findFirst.mockResolvedValue({
        ...withdrawalRow,
        contractWithdrawalId: null,
      });
      mockContracts.submitCall.mockResolvedValue({
        hash: 'hash-3',
        status: 'FAILED',
        errorMessage: 'revert',
      });
      await expect(service.submitProposal('user-1', 'wd-1', 'signed-xdr')).rejects.toThrow(
        BadRequestException,
      );
      expect(mockPrisma.treasuryWithdrawal.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }),
      );
    });

    it('blocks approval until the withdrawal is proposed on-chain', async () => {
      mockPrisma.treasuryWithdrawal.findFirst.mockResolvedValue({
        ...withdrawalRow,
        contractWithdrawalId: null,
      });
      await expect(
        service.approve('user-1', 'wd-1', { memberPublicKey: 'GMEMBER' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('prepares approve_withdraw with the on-chain withdrawal id', async () => {
      const result = await service.approve('user-1', 'wd-1', {
        memberPublicKey: 'GMEMBER',
      });
      expect(result.action).toBe('approve');
      expect(result.unsignedXdr).toBe('AAAA');
      expect(mockContracts.prepareCall).toHaveBeenCalledWith(
        expect.objectContaining({ functionName: 'approve_withdraw' }),
      );
    });

    it('prepares execute_withdraw for a funded, proposed withdrawal', async () => {
      const result = await service.execute('user-1', 'wd-1', {
        memberPublicKey: 'GMEMBER',
      });
      expect(result.action).toBe('execute');
      expect(mockContracts.prepareCall).toHaveBeenCalledWith(
        expect.objectContaining({ functionName: 'execute_withdraw' }),
      );
    });

    it('rejects executing a withdrawal that is already EXECUTED', async () => {
      mockPrisma.treasuryWithdrawal.findFirst.mockResolvedValue({
        ...withdrawalRow,
        status: 'EXECUTED',
      });
      await expect(
        service.execute('user-1', 'wd-1', { memberPublicKey: 'GMEMBER' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a duplicate in-flight approval', async () => {
      mockPrisma.treasuryWithdrawal.findFirst.mockResolvedValue({
        ...withdrawalRow,
        approveHash: 'already-submitted',
      });
      await expect(
        service.confirmAction('user-1', 'wd-1', 'approve', 'signed-xdr'),
      ).rejects.toThrow(BadRequestException);
    });

    it('records the execution hash from the indexer-reconciled action', async () => {
      const result = await service.confirmAction('user-1', 'wd-1', 'execute', 'signed-xdr');
      expect(mockPrisma.treasuryWithdrawal.update).toHaveBeenCalledWith({
        where: { id: 'wd-1' },
        data: { executedHash: 'hash-1' },
      });
      expect(result.executedHash).toBe('hash-1');
    });
  });

  describe('ownership scoping', () => {
    it('returns 404 for another user\u2019s operation', async () => {
      mockPrisma.treasuryOperation.findFirst.mockResolvedValue(null);
      await expect(service.submitDeposit('user-2', 'op-1', 'signed-xdr')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('returns 404 for another user\u2019s withdrawal', async () => {
      mockPrisma.treasuryWithdrawal.findFirst.mockResolvedValue(null);
      await expect(
        service.approve('user-2', 'wd-1', { memberPublicKey: 'GMEMBER' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('lists only the caller\u2019s operations and withdrawals', async () => {
      await service.listOperations('user-1');
      expect(mockPrisma.treasuryOperation.findMany).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
        orderBy: { createdAt: 'desc' },
      });
      await service.listWithdrawals('user-1');
      expect(mockPrisma.treasuryWithdrawal.findMany).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
        orderBy: { createdAt: 'desc' },
      });
    });
  });
});
