import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SubscriptionsService } from './subscriptions.service';

describe('SubscriptionsService', () => {
  let service: SubscriptionsService;
  let mockPrisma: Record<string, any>;
  let mockWallet: Record<string, jest.Mock>;
  let mockRealtime: Record<string, jest.Mock>;
  let mockContracts: Record<string, any>;

  const activeMerchant = {
    userId: 'merchant-user',
    status: 'ACTIVE',
    settlementPublicKey: 'GMERCHANT',
  };

  const planRow = {
    id: 'plan-1',
    userId: 'merchant-user',
    name: 'Pro',
    assetCode: 'XLM',
    amount: '1',
    intervalSeconds: 60,
    status: 'PENDING',
    hash: null,
    contractPlanId: null,
  };

  const subscriptionRow = {
    id: 'sub-1',
    userId: 'subscriber-user',
    planId: 'plan-1',
    status: 'PENDING',
    hash: null,
    contractSubscriptionId: null,
    renewHash: null,
    cancelHash: null,
  };

  beforeEach(() => {
    mockPrisma = {
      merchant: { findUnique: jest.fn().mockResolvedValue(activeMerchant) },
      subscriptionPlan: {
        create: jest.fn().mockImplementation(({ data }) => ({ id: 'plan-1', ...data })),
        findFirst: jest.fn().mockResolvedValue(planRow),
        findUnique: jest.fn().mockResolvedValue(planRow),
        findMany: jest.fn().mockResolvedValue([planRow]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockImplementation(({ data }) => ({ ...planRow, ...data })),
      },
      subscription: {
        create: jest.fn().mockImplementation(({ data }) => ({ id: 'sub-1', ...data })),
        findFirst: jest.fn().mockResolvedValue(subscriptionRow),
        findUnique: jest.fn().mockResolvedValue(subscriptionRow),
        findMany: jest.fn().mockResolvedValue([subscriptionRow]),
        update: jest.fn().mockImplementation(({ data }) => ({ ...subscriptionRow, ...data })),
      },
      wallet: { findMany: jest.fn().mockResolvedValue([{ publicKey: 'GSUB' }]) },
    };
    mockWallet = { assertWalletOwnership: jest.fn().mockResolvedValue(undefined) };
    mockRealtime = { emitToUser: jest.fn() };
    mockContracts = {
      requireContractAddress: jest.fn().mockReturnValue('CSUBS'),
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
    service = new SubscriptionsService(
      mockPrisma as never,
      mockWallet as never,
      mockRealtime as never,
      mockContracts as never,
    );
  });

  describe('createPlan', () => {
    const dto = { name: 'Pro', assetCode: 'XLM', amount: '1', intervalSeconds: 60 };

    it('prepares create_plan from the merchant settlement key and stores a PENDING plan', async () => {
      const result = await service.createPlan('merchant-user', dto as never);
      expect(result.unsignedXdr).toBe('AAAA');
      expect(mockPrisma.subscriptionPlan.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ status: 'PENDING', userId: 'merchant-user' }),
      });
      expect(mockContracts.prepareCall).toHaveBeenCalledWith(
        expect.objectContaining({ contractId: 'CSUBS', functionName: 'create_plan' }),
      );
    });

    it('rejects a user without a merchant profile', async () => {
      mockPrisma.merchant.findUnique.mockResolvedValue(null);
      await expect(service.createPlan('user-1', dto as never)).rejects.toThrow(ForbiddenException);
    });

    it('rejects a merchant that is not ACTIVE', async () => {
      mockPrisma.merchant.findUnique.mockResolvedValue({
        ...activeMerchant,
        status: 'PENDING',
      });
      await expect(service.createPlan('merchant-user', dto as never)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('requires wallet ownership of the merchant settlement key', async () => {
      mockWallet.assertWalletOwnership.mockRejectedValue(
        new NotFoundException('Wallet not linked'),
      );
      await expect(service.createPlan('merchant-user', dto as never)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws 503 when the subscriptions contract is not configured', async () => {
      mockContracts.requireContractAddress.mockImplementation(() => {
        throw new ServiceUnavailableException('not configured');
      });
      await expect(service.createPlan('merchant-user', dto as never)).rejects.toThrow(
        ServiceUnavailableException,
      );
    });
  });

  describe('submitPlan', () => {
    it('claims a PENDING plan and persists the on-chain hash', async () => {
      const result = await service.submitPlan('merchant-user', 'plan-1', 'signed-xdr');
      expect(mockPrisma.subscriptionPlan.updateMany).toHaveBeenCalledWith({
        where: { id: 'plan-1', status: 'PENDING' },
        data: { status: 'PENDING' },
      });
      expect(result.hash).toBe('hash-1');
    });

    it('rejects a plan that is not awaiting signature', async () => {
      mockPrisma.subscriptionPlan.findFirst.mockResolvedValue({ ...planRow, status: 'ACTIVE' });
      await expect(service.submitPlan('merchant-user', 'plan-1', 'signed-xdr')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('persists FAILED when plan creation reverted on-chain', async () => {
      mockContracts.submitCall.mockResolvedValue({
        hash: 'hash-2',
        status: 'FAILED',
        errorMessage: 'revert',
      });
      await expect(service.submitPlan('merchant-user', 'plan-1', 'signed-xdr')).rejects.toThrow(
        BadRequestException,
      );
      expect(mockPrisma.subscriptionPlan.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }),
      );
      expect(mockRealtime.emitToUser).toHaveBeenCalledWith(
        'merchant-user',
        'subscription-plan.updated',
        { id: 'plan-1', status: 'FAILED' },
      );
    });
  });

  describe('subscribe', () => {
    it('prepares subscribe against an ACTIVE on-chain plan', async () => {
      mockPrisma.subscriptionPlan.findUnique.mockResolvedValue({
        ...planRow,
        status: 'ACTIVE',
        contractPlanId: 5,
      });
      const result = await service.subscribe('subscriber-user', 'plan-1', {
        subscriberPublicKey: 'GSUB',
      } as never);
      expect(result.unsignedXdr).toBe('AAAA');
      expect(mockContracts.prepareCall).toHaveBeenCalledWith(
        expect.objectContaining({ functionName: 'subscribe' }),
      );
    });

    it('refuses to subscribe to a plan that is not ACTIVE on-chain', async () => {
      await expect(
        service.subscribe('subscriber-user', 'plan-1', { subscriberPublicKey: 'GSUB' } as never),
      ).rejects.toThrow(BadRequestException);
    });

    it('requires wallet ownership of the subscriber key', async () => {
      mockPrisma.subscriptionPlan.findUnique.mockResolvedValue({
        ...planRow,
        status: 'ACTIVE',
        contractPlanId: 5,
      });
      mockWallet.assertWalletOwnership.mockRejectedValue(
        new NotFoundException('Wallet not linked'),
      );
      await expect(
        service.subscribe('subscriber-user', 'plan-1', { subscriberPublicKey: 'GSUB' } as never),
      ).rejects.toThrow(NotFoundException);
    });

    it('returns 404 for an unknown plan', async () => {
      mockPrisma.subscriptionPlan.findUnique.mockResolvedValue(null);
      await expect(
        service.subscribe('subscriber-user', 'missing', { subscriberPublicKey: 'GSUB' } as never),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('renew authorization', () => {
    const activeSub = {
      ...subscriptionRow,
      status: 'ACTIVE',
      contractSubscriptionId: 9,
    };

    beforeEach(() => {
      mockPrisma.subscription.findFirst.mockResolvedValue(activeSub);
      mockPrisma.subscriptionPlan.findUnique.mockResolvedValue({
        ...planRow,
        status: 'ACTIVE',
        contractPlanId: 5,
      });
    });

    it('allows the subscriber to prepare a renew', async () => {
      const result = await service.renew('subscriber-user', 'sub-1', {
        callerPublicKey: 'GSUB',
      } as never);
      expect(result.action).toBe('renew');
      expect(mockContracts.prepareCall).toHaveBeenCalledWith(
        expect.objectContaining({ functionName: 'renew' }),
      );
    });

    it('allows the plan merchant to prepare a renew', async () => {
      const result = await service.renew('subscriber-user', 'sub-1', {
        callerPublicKey: 'GMERCHANT',
      } as never);
      expect(result.action).toBe('renew');
    });

    it('rejects a caller who is neither subscriber nor merchant', async () => {
      await expect(
        service.renew('subscriber-user', 'sub-1', { callerPublicKey: 'GINTRUDER' } as never),
      ).rejects.toThrow(ForbiddenException);
    });

    it('refuses to renew a subscription that is not active on-chain', async () => {
      mockPrisma.subscription.findFirst.mockResolvedValue(subscriptionRow);
      await expect(
        service.renew('subscriber-user', 'sub-1', { callerPublicKey: 'GSUB' } as never),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('cancel', () => {
    it('prepares cancel for an on-chain subscription', async () => {
      mockPrisma.subscription.findFirst.mockResolvedValue({
        ...subscriptionRow,
        status: 'ACTIVE',
        contractSubscriptionId: 9,
      });
      const result = await service.cancel('subscriber-user', 'sub-1', {
        callerPublicKey: 'GSUB',
      } as never);
      expect(result.action).toBe('cancel');
    });

    it('refuses to cancel a subscription that was never created on-chain', async () => {
      await expect(
        service.cancel('subscriber-user', 'sub-1', { callerPublicKey: 'GSUB' } as never),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('confirmAction', () => {
    it('records the renew hash for the indexer to reconcile', async () => {
      const result = await service.confirmAction('subscriber-user', 'sub-1', 'renew', 'signed-xdr');
      expect(mockPrisma.subscription.update).toHaveBeenCalledWith({
        where: { id: 'sub-1' },
        data: { renewHash: 'hash-1' },
      });
      expect(result.renewHash).toBe('hash-1');
    });

    it('rejects a duplicate in-flight cancel', async () => {
      mockPrisma.subscription.findFirst.mockResolvedValue({
        ...subscriptionRow,
        cancelHash: 'already-submitted',
      });
      await expect(
        service.confirmAction('subscriber-user', 'sub-1', 'cancel', 'signed-xdr'),
      ).rejects.toThrow(BadRequestException);
    });

    it('surfaces an on-chain revert as a 400 without touching state', async () => {
      mockContracts.submitCall.mockResolvedValue({
        hash: 'hash-3',
        status: 'FAILED',
        errorMessage: 'revert',
      });
      await expect(
        service.confirmAction('subscriber-user', 'sub-1', 'cancel', 'signed-xdr'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('ownership scoping', () => {
    it('returns 404 for another user\u2019s plan', async () => {
      mockPrisma.subscriptionPlan.findFirst.mockResolvedValue(null);
      await expect(service.submitPlan('user-2', 'plan-1', 'signed-xdr')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('returns 404 for another user\u2019s subscription', async () => {
      mockPrisma.subscription.findFirst.mockResolvedValue(null);
      await expect(service.confirmAction('user-2', 'sub-1', 'renew', 'signed-xdr')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('lists only the caller\u2019s plans and subscriptions', async () => {
      await service.listPlans('merchant-user');
      expect(mockPrisma.subscriptionPlan.findMany).toHaveBeenCalledWith({
        where: { userId: 'merchant-user' },
        orderBy: { createdAt: 'desc' },
      });
      await service.listSubscriptions('subscriber-user');
      expect(mockPrisma.subscription.findMany).toHaveBeenCalledWith({
        where: { userId: 'subscriber-user' },
        orderBy: { createdAt: 'desc' },
        include: { plan: true },
      });
    });
  });
});
