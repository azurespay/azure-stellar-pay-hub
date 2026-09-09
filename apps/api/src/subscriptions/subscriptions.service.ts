import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '@stellar-pay/database';
import { toStroops } from '@stellar-pay/shared';
import { WalletService } from '../wallet/wallet.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { ContractIntegrationService } from '../contracts/contract-integration.service';
import type {
  CreateSubscriptionPlan,
  SubscribePlan,
  SubscriptionCall,
} from '@stellar-pay/validation';

const SUBSCRIPTIONS_CONTRACT_ENV = 'CONTRACT_STELLAR_PAY_SUBSCRIPTIONS';

/**
 * On-chain subscriptions lifecycle (subscriptions contract):
 *
 *   plan       → prepare `create_plan(merchant, token, amount, interval_seconds)`
 *                → sign → submit → indexer `plan` event → plan ACTIVE
 *   subscribe  → prepare `subscribe(subscriber, plan_id)` → sign → submit →
 *                indexer `sub` event → subscription ACTIVE (first payment on-chain)
 *   renew      → prepare `renew(caller, subscription_id)` → sign → submit →
 *                indexer `renew` event → nextPaymentAt advanced
 *   cancel     → prepare `cancel(caller, subscription_id)` → sign → submit →
 *                indexer `cancel` event → subscription CANCELED
 *
 * Status transitions are indexer-driven (on-chain evidence only).
 */
@Injectable()
export class SubscriptionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly realtime: RealtimeGateway,
    private readonly contracts: ContractIntegrationService,
  ) {}

  private contractId(): string {
    return this.contracts.requireContractAddress(SUBSCRIPTIONS_CONTRACT_ENV, 'Subscriptions');
  }

  async createPlan(userId: string, dto: CreateSubscriptionPlan) {
    const merchant = await this.prisma.merchant.findUnique({ where: { userId } });
    if (!merchant) {
      throw new ForbiddenException('No merchant profile');
    }
    if (merchant.status !== 'ACTIVE') {
      throw new ForbiddenException('Merchant account is not active');
    }
    await this.wallet.assertWalletOwnership(userId, merchant.settlementPublicKey);
    const tokenAddress = this.contracts.tokenAddress(dto.assetCode, dto.assetIssuer);

    const prepared = await this.contracts.prepareCall({
      source: merchant.settlementPublicKey,
      contractId: this.contractId(),
      functionName: 'create_plan',
      args: [
        this.contracts.network().accountScVal(merchant.settlementPublicKey),
        this.contracts.network().accountScVal(tokenAddress),
        this.contracts.network().i128ScVal(BigInt(toStroops(dto.amount))),
        this.contracts.network().u64ScVal(BigInt(dto.intervalSeconds)),
      ],
    });

    const plan = await this.prisma.subscriptionPlan.create({
      data: {
        userId,
        name: dto.name,
        description: dto.description ?? null,
        assetCode: dto.assetCode,
        assetIssuer: dto.assetIssuer ?? null,
        amount: dto.amount,
        intervalSeconds: dto.intervalSeconds,
        status: 'PENDING',
      },
    });
    return {
      id: plan.id,
      unsignedXdr: prepared.unsignedXdr,
      message: 'Sign the transaction with your wallet, then submit it',
    };
  }

  async submitPlan(userId: string, id: string, signedXdr: string) {
    const plan = await this.findPlan(userId, id);
    if (plan.status !== 'PENDING') {
      throw new BadRequestException(`Plan is not awaiting signature (status: ${plan.status})`);
    }
    const claim = await this.prisma.subscriptionPlan.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: 'PENDING' }, // stays PENDING until the on-chain `plan` event
    });
    if (claim.count !== 1) {
      throw new BadRequestException('Plan already submitted');
    }
    const result = await this.contracts.submitCall(signedXdr);
    if (result.status === 'FAILED') {
      await this.prisma.subscriptionPlan.update({
        where: { id },
        data: { status: 'FAILED', hash: result.hash ?? null },
      });
      this.realtime.emitToUser(userId, 'subscription-plan.updated', { id, status: 'FAILED' });
      throw new BadRequestException(`Plan creation reverted on-chain: ${result.errorMessage}`);
    }
    const updated = await this.prisma.subscriptionPlan.update({
      where: { id },
      data: { hash: result.hash ?? null },
    });
    // ACTIVE comes from the indexer (`plan` event).
    return updated;
  }

  async subscribe(userId: string, planId: string, dto: SubscribePlan) {
    await this.wallet.assertWalletOwnership(userId, dto.subscriberPublicKey);
    const plan = await this.prisma.subscriptionPlan.findUnique({ where: { id: planId } });
    if (!plan) {
      throw new NotFoundException('Subscription plan not found');
    }
    if (plan.status !== 'ACTIVE' || !plan.contractPlanId) {
      throw new BadRequestException('Plan is not active on-chain yet');
    }
    const prepared = await this.contracts.prepareCall({
      source: dto.subscriberPublicKey,
      contractId: this.contractId(),
      functionName: 'subscribe',
      args: [
        this.contracts.network().accountScVal(dto.subscriberPublicKey),
        this.contracts.network().u64ScVal(BigInt(plan.contractPlanId)),
      ],
    });
    const subscription = await this.prisma.subscription.create({
      data: {
        userId,
        planId: plan.id,
        status: 'PENDING',
      },
    });
    return {
      id: subscription.id,
      unsignedXdr: prepared.unsignedXdr,
      message: 'Sign the transaction with your wallet, then submit it',
    };
  }

  async submitSubscription(userId: string, id: string, signedXdr: string) {
    const subscription = await this.findSubscription(userId, id);
    if (subscription.status !== 'PENDING') {
      throw new BadRequestException(
        `Subscription is not awaiting signature (status: ${subscription.status})`,
      );
    }
    const result = await this.contracts.submitCall(signedXdr);
    if (result.status === 'FAILED') {
      await this.prisma.subscription.update({
        where: { id },
        data: { status: 'FAILED', hash: result.hash ?? null },
      });
      this.realtime.emitToUser(userId, 'subscription.updated', { id, status: 'FAILED' });
      throw new BadRequestException(`Subscription reverted on-chain: ${result.errorMessage}`);
    }
    const updated = await this.prisma.subscription.update({
      where: { id },
      data: { hash: result.hash ?? null },
    });
    // ACTIVE comes from the indexer (`sub` event — first payment executed).
    return updated;
  }

  async renew(userId: string, id: string, dto: SubscriptionCall) {
    await this.wallet.assertWalletOwnership(userId, dto.callerPublicKey);
    const subscription = await this.findSubscription(userId, id);
    if (subscription.status !== 'ACTIVE' || !subscription.contractSubscriptionId) {
      throw new BadRequestException('Subscription is not active on-chain');
    }
    // The contract allows the subscriber or the plan merchant to renew. Check
    // the caller is one of those before preparing the call (the contract
    // enforces it again with require_auth + the caller check).
    const plan = await this.prisma.subscriptionPlan.findUnique({
      where: { id: subscription.planId },
    });
    const merchant = plan ? await this.prisma.merchant.findUnique({ where: { userId: plan.userId } }) : null;
    const subscriberKeys = await this.prisma.wallet.findMany({
      where: { userId: subscription.userId, status: 'ACTIVE' },
      select: { publicKey: true },
    });
    const isSubscriber = subscriberKeys.some((w) => w.publicKey === dto.callerPublicKey);
    const isMerchant = !!merchant && dto.callerPublicKey === merchant.settlementPublicKey;
    if (!isSubscriber && !isMerchant) {
      throw new ForbiddenException('Only the subscriber or the plan merchant can renew');
    }
    const prepared = await this.contracts.prepareCall({
      source: dto.callerPublicKey,
      contractId: this.contractId(),
      functionName: 'renew',
      args: [
        this.contracts.network().accountScVal(dto.callerPublicKey),
        this.contracts.network().u64ScVal(BigInt(subscription.contractSubscriptionId)),
      ],
    });
    return {
      id: subscription.id,
      action: 'renew',
      unsignedXdr: prepared.unsignedXdr,
      message: 'Sign the transaction with your wallet, then submit it',
    };
  }

  async cancel(userId: string, id: string, dto: SubscriptionCall) {
    await this.wallet.assertWalletOwnership(userId, dto.callerPublicKey);
    const subscription = await this.findSubscription(userId, id);
    if (!subscription.contractSubscriptionId) {
      throw new BadRequestException('Subscription is not active on-chain');
    }
    const prepared = await this.contracts.prepareCall({
      source: dto.callerPublicKey,
      contractId: this.contractId(),
      functionName: 'cancel',
      args: [
        this.contracts.network().accountScVal(dto.callerPublicKey),
        this.contracts.network().u64ScVal(BigInt(subscription.contractSubscriptionId)),
      ],
    });
    return {
      id: subscription.id,
      action: 'cancel',
      unsignedXdr: prepared.unsignedXdr,
      message: 'Sign the transaction with your wallet, then submit it',
    };
  }

  async confirmAction(userId: string, id: string, action: 'renew' | 'cancel', signedXdr: string) {
    const subscription = await this.findSubscription(userId, id);
    const hashField = action === 'renew' ? 'renewHash' : 'cancelHash';
    if ((subscription as unknown as Record<string, string | null>)[hashField]) {
      throw new BadRequestException(`${action} already in flight`);
    }
    const result = await this.contracts.submitCall(signedXdr);
    if (result.status === 'FAILED') {
      throw new BadRequestException(`${action} reverted on-chain: ${result.errorMessage}`);
    }
    // Indexer advances status on the `renew`/`cancel` event.
    const updated = await this.prisma.subscription.update({
      where: { id },
      data: { [hashField]: result.hash ?? null } as never,
    });
    return updated;
  }

  async listPlans(userId: string) {
    return this.prisma.subscriptionPlan.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });
  }

  async listSubscriptions(userId: string) {
    return this.prisma.subscription.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: { plan: true },
    });
  }

  private async findPlan(userId: string, id: string) {
    const plan = await this.prisma.subscriptionPlan.findFirst({ where: { id, userId } });
    if (!plan) {
      throw new NotFoundException('Subscription plan not found');
    }
    return plan;
  }

  private async findSubscription(userId: string, id: string) {
    const subscription = await this.prisma.subscription.findFirst({ where: { id, userId } });
    if (!subscription) {
      throw new NotFoundException('Subscription not found');
    }
    return subscription;
  }
}