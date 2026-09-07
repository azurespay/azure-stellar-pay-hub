-- AlterEnum
-- CONFIRMED marks a contract-route payment whose Soroban invocation was
-- observed as successful on the ledger by the event indexer (SUBMITTED alone
-- only means Horizon accepted the envelope).
ALTER TYPE "TransactionStatus" ADD VALUE 'CONFIRMED';
