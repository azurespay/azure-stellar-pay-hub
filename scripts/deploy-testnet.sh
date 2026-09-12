#!/usr/bin/env bash
# deploy-testnet.sh — Deploy Azure StellarPay Hub to Stellar testnet.
#
# Prerequisites:
#   - Stellar testnet account with XLM (fund at https://laboratory.stellar.org/#create-account)
#   - Secret key for the deployer account (set STELLAR_SECRET_KEY env var)
#   - soroban-cli installed (npm install -g soroban-cli or cargo install soroban-cli)
#   - Docker running (for Postgres + Redis)
#   - Node.js 22 + pnpm + Rust stable with wasm32 target
#
# Usage:
#   export STELLAR_SECRET_KEY=S...      # deployer secret key
#   export DATABASE_URL=postgresql://... # or use local defaults
#   bash scripts/deploy-testnet.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1" >&2; exit 1; }

# ── Prerequisite checks ──────────────────────────────────────────────────────

echo ""
echo "=============================================="
echo " Azure StellarPay Hub — Testnet Deployment"
echo "=============================================="
echo ""

command -v stellar >/dev/null 2>&1 || err "stellar-cli not found. Install: cargo install stellar-cli"
command -v node >/dev/null 2>&1   || err "Node.js not found"
command -v pnpm >/dev/null 2>&1  || err "pnpm not found"
command -v docker >/dev/null 2>&1 || err "Docker not found"

if [ -z "${STELLAR_SECRET_KEY:-}" ]; then
  err "STELLAR_SECRET_KEY is not set. Export your testnet account secret key."
fi

STELLAR_SECRET_KEY="${STELLAR_SECRET_KEY}"

# Derive public key from secret
DEPLOYER_PUBLIC=$(stellar keys address "$STELLAR_SECRET_KEY" 2>/dev/null || \
  node -e "const {Keypair}=require('@stellar/stellar-sdk');console.log(Keypair.fromSecret('$STELLAR_SECRET_KEY').publicKey())")
log "Deployer: $DEPLOYER_PUBLIC"

# ── 1. Fund the deployer account if needed ───────────────────────────────────

ACCOUNT_EXISTS=$(curl -s "https://horizon-testnet.stellar.org/accounts/$DEPLOYER_PUBLIC" | grep -c '"id"' || true)
if [ "$ACCOUNT_EXISTS" -eq 0 ]; then
  warn "Account $DEPLOYER_PUBLIC not found on testnet."
  warn "Fund it at https://laboratory.stellar.org/#create-account?network=test"
  warn "Then re-run this script."
  exit 1
fi
log "Account exists on testnet"

# ── 2. Install dependencies ──────────────────────────────────────────────────

log "Installing dependencies..."
pnpm install --frozen-lockfile 2>&1 | tail -1

# ── 3. Start infrastructure ──────────────────────────────────────────────────

log "Starting Postgres + Redis..."
pnpm docker:up 2>&1 | tail -2
sleep 3

# ── 4. Database setup ────────────────────────────────────────────────────────

log "Setting up database..."
pnpm db:generate 2>&1 | tail -1
pnpm db:push 2>&1 | tail -1
pnpm db:seed 2>&1 | tail -1
log "Database ready"

# ── 5. Build Soroban contracts ───────────────────────────────────────────────

log "Building Soroban contracts..."
rustup target add wasm32v1-none 2>/dev/null || true
cd "$ROOT/contracts"
stellar contract build 2>&1 | tail -5
cd "$ROOT"
log "Contracts compiled"

# ── 6. Deploy contracts to testnet ───────────────────────────────────────────

CONTRACTS_DIR="$ROOT/contracts/target/wasm32v1-none/release"
DEPLOY_LOG="$ROOT/.deployed-contracts.env"

echo "# Deployed contract addresses — $(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$DEPLOY_LOG"

declare -a CONTRACTS=(
  "stellar_pay_payment"
  "stellar_pay_escrow"
  "stellar_pay_treasury"
  "stellar_pay_subscriptions"
  "stellar_pay_invoices"
  "stellar_pay_merchant"
)

for contract in "${CONTRACTS[@]}"; do
  WASM="$CONTRACTS_DIR/${contract}.wasm"
  if [ ! -f "$WASM" ]; then
    warn "WASM not found: $WASM — skipping"
    continue
  fi
  log "Deploying $contract..."
  ADDRESS=$(stellar contract deploy \
    --wasm "$WASM" \
    --source-account "$STELLAR_SECRET_KEY" \
    --network testnet 2>&1 | tail -1)
  # Only save if it looks like a contract address (56 chars, starts with C)
  if [[ "$ADDRESS" =~ ^C[A-Z0-9]{55}$ ]]; then
    echo "CONTRACT_$(echo "$contract" | tr '[:lower:]' '[:upper:]')=$ADDRESS" >> "$DEPLOY_LOG"
    log "  $contract → $ADDRESS"
  else
    warn "  $contract deployment may have failed: $ADDRESS"
    echo "# $contract: $ADDRESS" >> "$DEPLOY_LOG"
  fi
  sleep 3
done

log "Contract addresses saved to $DEPLOY_LOG"

# ── 6b. Initialize + allowlist contracts ─────────────────────────────────────

log "Initializing contracts and setting token allowlists..."
if node "$ROOT/scripts/init-contracts.mjs" 2>&1 | tail -30; then
  log "Contracts initialized and allowlisted"
else
  warn "Contract initialization reported failures — see output above."
  warn "You can re-run it later with: pnpm contracts:init"
fi

# ── 7. Create .env.testnet with contract addresses ───────────────────────────

cp .env.example .env.testnet
{
  echo ""
  echo "# --- Deployed contract addresses (auto-generated) ---"
  cat "$DEPLOY_LOG"
} >> .env.testnet

log "Created .env.testnet with deployed contract addresses"

# ── 8. Build the API and apps ────────────────────────────────────────────────

log "Building packages..."
pnpm build:packages 2>&1 | tail -3

log "Building apps..."
pnpm build:apps 2>&1 | tail -3
log "Build complete"

# ── 9. Start the API ────────────────────────────────────────────────────────

log "Starting API on Stellar testnet..."
echo ""
echo -e "${GREEN}=============================================="
echo " Testnet deployment complete!"
echo "=============================================="
echo ""
echo " Contract addresses: $DEPLOY_LOG"
echo " Environment file:   .env.testnet"
echo ""
echo " Start the API:"
echo "   cp .env.testnet .env"
echo "   pnpm dev:api"
echo ""
echo " API will be available at http://localhost:4000"
echo " Health check:        http://localhost:4000/api/health"
echo ""
echo " Next steps:"
echo "   1. Copy .env.testnet to .env"
echo "   2. Update DATABASE_URL if using a remote DB"
echo "   3. Set JWT_SECRET to a strong random value"
echo "   4. Run 'pnpm dev' to start all apps"
echo -e "${NC}"
