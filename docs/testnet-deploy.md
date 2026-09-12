---
title: Testnet Deployment
description: Complete guide to deploying Azure StellarPay Hub to Stellar testnet.
---

# Testnet Deployment

This guide walks through deploying the full platform — smart contracts, API, database,
and frontend apps — to Stellar testnet.

## Prerequisites

| Requirement                     | How to get it                                                                                                                                                    |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Stellar testnet account**     | Create at [laboratory.stellar.org](https://laboratory.stellar.org/#create-account?network=test)                                                                  |
| **Funded with XLM**             | Fund at [laboratory.stellar.org](https://laboratory.stellar.org/#create-account?network=test) or use Friendbot: `curl "https://friendbot.stellar.org?addr=G..."` |
| **Secret key**                  | Save the secret key (starts with `S...`) — you'll need it for contract deployment                                                                                |
| **Node.js ≥ 20.9**              | `nvm install && nvm use`                                                                                                                                         |
| **pnpm ≥ 9**                    | `corepack enable`                                                                                                                                                |
| **Rust + wasm32v1-none target** | `rustup target add wasm32v1-none`                                                                                                                                |
| **stellar-cli**                 | `cargo install stellar-cli`                                                                                                                                      |
| **Docker**                      | For local Postgres + Redis                                                                                                                                       |

## Quick Deploy (One Command)

```bash
# Set your testnet account secret key
export STELLAR_SECRET_KEY=SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX

# Run the deploy script
bash scripts/deploy-testnet.sh
```

The script will:

1. Verify prerequisites (stellar-cli, Node, pnpm, Docker, funded account)
2. Install dependencies
3. Start Postgres + Redis
4. Create and seed the database
5. Build all 6 Soroban contracts
6. Deploy each contract to testnet
7. **Initialize + allowlist each contract on-chain** (admin, XLM SAC allowlist, verification)
8. Save contract addresses to `.deployed-contracts.env`
9. Create `.env.testnet` with all configuration
10. Build the API and frontend apps
11. Provide instructions to start the API

After the script completes:

```bash
cp .env.testnet .env        # Use the generated config
pnpm dev:api                # Start the API on testnet
```

## Manual Deployment

### 1. Configure Environment

```bash
pnpm generate:env           # Creates .env from templates
```

Edit `.env` and set:

```env
STELLAR_NETWORK=testnet
HORIZON_URL=https://horizon-testnet.stellar.org
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
NETWORK_PASSPHRASE=Test SDF Network ; September 2015

JWT_SECRET=<generate a strong random secret>
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/stellar_pay?schema=public
```

### 2. Start Infrastructure

```bash
pnpm docker:up              # Postgres + Redis
```

### 3. Set Up Database

```bash
pnpm db:generate
pnpm db:push
pnpm db:seed                # Creates admin user + demo data
```

### 4. Build Contracts

```bash
cd contracts
stellar contract build
cd ..
```

> **Note**: Use `stellar contract build` (not `cargo build`) which targets
> `wasm32v1-none` (WASM MVP) for maximum Soroban testnet compatibility.

### 5. Deploy Contracts

```bash
# Deploy each contract to testnet
stellar contract deploy \
  --wasm contracts/target/wasm32v1-none/release/stellar_pay_payment.wasm \
  --source-account SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX \
  --network testnet

# Repeat for: escrow, treasury, subscriptions, invoices, merchant

# Save the returned addresses — you'll need them for the API
```

### 6. Initialize + Allowlist Contracts

Deployed contracts are **inert until initialized**: `initialize(...)` must be
called on the contracts that need it (payment, escrow, merchant, treasury),
and the payment/treasury token allowlists must be set before
`send`/`withdraw` will accept a token. All of this is automated:

```bash
export STELLAR_SECRET_KEY=S...   # the deployer (admin) key
pnpm contracts:init
```

`scripts/init-contracts.mjs` calls `initialize` on every contract that requires
it, `set_allowed(admin, <SAC>, true)` for XLM (plus any `ALLOWLIST_TOKENS`
passed as space-separated SAC addresses), and verifies the on-chain storage
(`Admin` / `Paused` / `Allowed`) afterwards. Re-running is idempotent
(already-initialized contracts are skipped).

Manual equivalent for a single contract:

```bash
stellar contract invoke \
  --id <CONTRACT_ADDRESS> \
  --source-account S... \
  --network testnet \
  -- initialize
```

### 7. Record Contract Addresses

Add deployed addresses to your `.env`:

```env
CONTRACT_STELLAR_PAY_PAYMENT=C...
CONTRACT_STELLAR_PAY_ESCROW=C...
CONTRACT_STELLAR_PAY_TREASURY=C...
CONTRACT_STELLAR_PAY_SUBSCRIPTIONS=C...
CONTRACT_STELLAR_PAY_INVOICES=C...
CONTRACT_STELLAR_PAY_MERCHANT=C...
```

### 8. Build and Start

```bash
pnpm build:packages
pnpm build:apps
pnpm dev:api                # API on http://localhost:4000
```

## Verify Deployment

```bash
# Health check
curl http://localhost:4000/api/health

# Expected response:
# { "status": "ok", "network": "testnet", "version": "0.1.0" }

# Fund a test account
curl "https://friendbot.stellar.org?addr=G..."

# Create a payment via the API
curl -X POST http://localhost:4000/api/payments \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <jwt>" \
  -d '{"to":"G...","amount":"10","assetCode":"XLM"}'
```

## Deployed Contract Addresses (Current Testnet)

| Contract      | Address                                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Payment       | [`CBDOG...K7IN4Q`](https://stellar.expert/explorer/testnet/contract/CBDOGRJIOX46MEHIYRGU7BFKLT2OOPT7QIN7ZU53DH5WK7FF5QK7IN4Q)  |
| Escrow        | [`CDWVU...3AMUEY`](https://stellar.expert/explorer/testnet/contract/CDWVUTCME6JSATWKKWIFVBEO4NAZSJCCX2ECNRQN3L33W65EFT3AMUEY)  |
| Treasury      | [`CCKWX...4UWRMKZ`](https://stellar.expert/explorer/testnet/contract/CCKWXDASGA7W3KWMEOEXYWMV5RVDLV2WGEJOHO3SYHKMXHZ3X4UWRMKZ) |
| Subscriptions | [`CCMQF...XOLBNI`](https://stellar.expert/explorer/testnet/contract/CCMQF6EB5DT6HKWGOB5BTRMD6Q66D5MVBQQN5HOK3565WHATXINOLBNI)  |
| Invoices      | [`CB3XB...TVDHZ`](https://stellar.expert/explorer/testnet/contract/CB3XBXQUY4LHSFPWJ4XZL6T7A2ITNMBWMCTT2QOS6LB7PF7RPJBTVDHZ)   |
| Merchant      | [`CDNQT...GDQUEU`](https://stellar.expert/explorer/testnet/contract/CDNQTYF4XSOPNY6ID6MHUROAC2BNIQTYWHJYVGXWMU5WFA5AOQGDQUEU)  |

The full addresses are also written to the generated, gitignored
`.deployed-contracts.env` by the deploy scripts (it is not committed, so the
table above is the in-repo record).

> **Verification (2026-09-09):** all six contract addresses above were deployed
> and **initialized + allowlisted on-chain** via `pnpm contracts:init` — Admin,
> Signers/Threshold, `Allowed(XLM)` and `Paused` were each read back from the
> contracts' instance storage and verified. A contract-route payment (`E2E_CONTRACT=1`)
> was executed end-to-end: the API invoked the payment contract's `send`, the
> contract emitted its `payment` event, the indexer reconciled it to `CONFIRMED`,
> and the realtime channel delivered the status update. The deployer account is
> `GASXJVT43O2TZHOXR6KYZYJY3MSWG722XPYMB57KH5Q4MNXDRDCVKV4Y`.
>
> **Re-verification (2026-09-11):** all six contract instances were confirmed
> live via Soroban RPC `getLedgerEntries`, and `admin()` / `paused()` /
> `is_allowed(XLM SAC)` were simulated on the `payment` contract (admin = the
> deployer, not paused, XLM allowlisted). The contract-route E2E (`E2E_CONTRACT=1`)
> was re-run and passed 22/22 (tx `cb8db1b8…`, ledger 4622907), as did the classic
> route (22/22, tx `393cc465…`, ledger 4622888).

## Funding Test Accounts

Stellar testnet uses Friendbot to fund accounts:

```bash
# Fund with 10,000 XLM
curl "https://friendbot.stellar.org?addr=GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
```

You can also use the [Stellar Laboratory](https://laboratory.stellar.org/#create-account?network=test):

1. Select "Test" network
2. Click "Create Account"
3. Fund with Friendbot

## Switching to Mainnet

> **Mainnet deployment requires explicit human approval.** It is only
> appropriate after the following are all complete and reviewed:
>
> 1. contract unit tests (`pnpm contracts:test`) pass for the exact commit
> 2. integration + E2E coverage of the payment lifecycle (see `tests/README.md`)
> 3. security review (contracts, key management, admin surface)
> 4. key-management review — mainnet signing keys must never live in code/envs
> 5. deployment verification on testnet and staging
> 6. operational readiness (monitoring, alerting, rollback, support)
>
> Do **not** change the network settings below as a shortcut to satisfy a spec;
> the platform currently runs on **Stellar testnet with demo data only**.

When ready and approved, update these values:

```env
STELLAR_NETWORK=public
HORIZON_URL=https://horizon.stellar.org
SOROBAN_RPC_URL=https://soroban.stellar.org
NETWORK_PASSPHRASE=Public Global Stellar Network ; September 2015
```

Then re-deploy contracts to mainnet and update the contract addresses in `.env`.

## Troubleshooting

### "stellar: command not found"

```bash
cargo install stellar-cli
# Or download from: https://github.com/stellar/stellar-cli/releases
```

### "Account not found" during deploy

Your testnet account needs to exist and be funded before deploying contracts.
Visit [laboratory.stellar.org](https://laboratory.stellar.org/#create-account?network=test)
to create and fund your account.

### "Insufficient balance" during deploy

Each contract deployment costs a small fee in XLM. Make sure your account
has at least 100 XLM. Fund with Friendbot:

```bash
curl "https://friendbot.stellar.org?addr=G..."
```

### Database connection errors

Make sure Docker is running and Postgres is healthy:

```bash
docker ps | grep postgres
pnpm docker:down && pnpm docker:up  # restart if needed
```

### Contract build failures

```bash
rustup update stable
rustup target add wasm32v1-none
cd contracts && stellar contract build
```

### "reference-types not enabled" error

If you see this error during deployment, ensure you're using `stellar contract build`
which targets `wasm32v1-none` (WASM MVP). Do NOT use `cargo build --target wasm32-unknown-unknown`
as it enables `reference-types` by default on modern Rust toolchains, which the Soroban
testnet validator rejects.
