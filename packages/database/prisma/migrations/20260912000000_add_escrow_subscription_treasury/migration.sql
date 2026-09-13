-- CreateEnum
CREATE TYPE "EscrowStatus" AS ENUM ('AWAITING_SIGN', 'SUBMITTED', 'FUNDED', 'RELEASED', 'REFUNDED', 'FAILED');

-- CreateEnum
CREATE TYPE "SubscriptionPlanStatus" AS ENUM ('PENDING', 'ACTIVE', 'INACTIVE', 'FAILED');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('PENDING', 'ACTIVE', 'CANCELED', 'FAILED');

-- CreateEnum
CREATE TYPE "TreasuryOperationType" AS ENUM ('DEPOSIT', 'WITHDRAWAL');

-- CreateEnum
CREATE TYPE "TreasuryOperationStatus" AS ENUM ('AWAITING_SIGN', 'SUBMITTED', 'CONFIRMED', 'FAILED');

-- CreateEnum
CREATE TYPE "TreasuryWithdrawalStatus" AS ENUM ('PROPOSED', 'APPROVED', 'EXECUTED', 'FAILED');

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "issueTxHash" TEXT,
ADD COLUMN     "onChainId" INTEGER;

-- AlterTable
ALTER TABLE "Merchant" ADD COLUMN     "onChainMerchantId" INTEGER,
ADD COLUMN     "registerTxHash" TEXT;

-- AlterTable
ALTER TABLE "Settlement" ADD COLUMN     "onChainMerchantId" INTEGER,
ADD COLUMN     "settleTxHash" TEXT;

-- CreateTable
CREATE TABLE "Escrow" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "contractId" INTEGER,
    "initiatorPublicKey" TEXT NOT NULL,
    "counterpartyPublicKey" TEXT NOT NULL,
    "arbiterPublicKey" TEXT,
    "tokenAddress" TEXT,
    "assetCode" TEXT NOT NULL,
    "assetIssuer" TEXT,
    "amount" TEXT NOT NULL,
    "releaseTime" TIMESTAMP(3) NOT NULL,
    "expiry" TIMESTAMP(3),
    "status" "EscrowStatus" NOT NULL DEFAULT 'AWAITING_SIGN',
    "hash" TEXT,
    "errorMessage" TEXT,
    "releaseHash" TEXT,
    "refundHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Escrow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionPlan" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "assetCode" TEXT NOT NULL,
    "assetIssuer" TEXT,
    "amount" TEXT NOT NULL,
    "intervalSeconds" INTEGER NOT NULL,
    "contractPlanId" INTEGER,
    "status" "SubscriptionPlanStatus" NOT NULL DEFAULT 'PENDING',
    "hash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "contractSubscriptionId" INTEGER,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'PENDING',
    "nextPaymentAt" TIMESTAMP(3),
    "hash" TEXT,
    "renewHash" TEXT,
    "cancelHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TreasuryOperation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "TreasuryOperationType" NOT NULL,
    "tokenAddress" TEXT,
    "assetCode" TEXT NOT NULL,
    "assetIssuer" TEXT,
    "amount" TEXT NOT NULL,
    "withdrawalId" TEXT,
    "status" "TreasuryOperationStatus" NOT NULL DEFAULT 'AWAITING_SIGN',
    "hash" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TreasuryOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TreasuryWithdrawal" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "operationId" TEXT,
    "toPublicKey" TEXT NOT NULL,
    "assetCode" TEXT NOT NULL,
    "assetIssuer" TEXT,
    "amount" TEXT NOT NULL,
    "contractWithdrawalId" INTEGER,
    "approvals" JSONB NOT NULL DEFAULT '[]',
    "threshold" INTEGER NOT NULL DEFAULT 0,
    "status" "TreasuryWithdrawalStatus" NOT NULL DEFAULT 'PROPOSED',
    "hash" TEXT,
    "approveHash" TEXT,
    "executedHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TreasuryWithdrawal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Escrow_contractId_key" ON "Escrow"("contractId");

-- CreateIndex
CREATE INDEX "Escrow_userId_idx" ON "Escrow"("userId");

-- CreateIndex
CREATE INDEX "Escrow_status_idx" ON "Escrow"("status");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionPlan_contractPlanId_key" ON "SubscriptionPlan"("contractPlanId");

-- CreateIndex
CREATE INDEX "SubscriptionPlan_userId_idx" ON "SubscriptionPlan"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_contractSubscriptionId_key" ON "Subscription"("contractSubscriptionId");

-- CreateIndex
CREATE INDEX "Subscription_userId_idx" ON "Subscription"("userId");

-- CreateIndex
CREATE INDEX "Subscription_planId_idx" ON "Subscription"("planId");

-- CreateIndex
CREATE INDEX "TreasuryOperation_userId_idx" ON "TreasuryOperation"("userId");

-- CreateIndex
CREATE INDEX "TreasuryOperation_status_idx" ON "TreasuryOperation"("status");

-- CreateIndex
CREATE UNIQUE INDEX "TreasuryWithdrawal_contractWithdrawalId_key" ON "TreasuryWithdrawal"("contractWithdrawalId");

-- CreateIndex
CREATE INDEX "TreasuryWithdrawal_userId_idx" ON "TreasuryWithdrawal"("userId");

-- CreateIndex
CREATE INDEX "TreasuryWithdrawal_status_idx" ON "TreasuryWithdrawal"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_onChainId_key" ON "Invoice"("onChainId");

-- CreateIndex
CREATE UNIQUE INDEX "Merchant_onChainMerchantId_key" ON "Merchant"("onChainMerchantId");

-- AddForeignKey
ALTER TABLE "Escrow" ADD CONSTRAINT "Escrow_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionPlan" ADD CONSTRAINT "SubscriptionPlan_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "SubscriptionPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TreasuryOperation" ADD CONSTRAINT "TreasuryOperation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TreasuryWithdrawal" ADD CONSTRAINT "TreasuryWithdrawal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

