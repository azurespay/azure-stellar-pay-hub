-- Add a client-supplied idempotency key to payment intents so a retried
-- POST /payments (same user + Idempotency-Key header) returns the original
-- row instead of creating a second payment. PostgreSQL unique indexes treat
-- NULLs as distinct, so the composite constraint only dedupes keyed rows.
ALTER TABLE "Transaction" ADD COLUMN "idempotencyKey" TEXT;
CREATE UNIQUE INDEX "Transaction_userId_idempotencyKey_key" ON "Transaction"("userId", "idempotencyKey");
