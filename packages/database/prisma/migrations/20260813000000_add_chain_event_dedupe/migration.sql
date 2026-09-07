-- CreateTable
-- Dedupe ledger for on-chain event ingestion. `eventId` is a deterministic
-- chain id (Horizon payment paging token, or Soroban RPC event id); the unique
-- constraint makes duplicate deliveries impossible to process twice, which is
-- the idempotency backstop for both inbound listeners.
CREATE TABLE "ChainEvent" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "txHash" TEXT,
    "contractId" TEXT,
    "ledger" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChainEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ChainEvent_eventId_key" ON "ChainEvent"("eventId");

-- CreateIndex
CREATE INDEX "ChainEvent_source_idx" ON "ChainEvent"("source");

-- CreateIndex
CREATE INDEX "ChainEvent_createdAt_idx" ON "ChainEvent"("createdAt");
