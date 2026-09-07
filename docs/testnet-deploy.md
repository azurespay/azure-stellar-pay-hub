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
5. Build all 8 Soroban contracts
6. Deploy each contract to testnet
7. Save contract addresses to `.deployed-contracts.env`
8. Create `.env.testnet` with all configuration
9. Build the API and frontend apps
10. Provide instructions to start the API

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

# Repeat for: escrow, multisig, treasury, subscriptions, invoices, merchant, rewards

# Save the returned addresses — you'll need them for the API
```

### 6. Initialize Contracts (if needed)

Some contracts require initialization after deployment:

```bash
# Example: initialize multisig with signers and threshold
stellar contract invoke \
  --id <MULTISIG_ADDRESS> \
  --source-account S... \
  --network testnet \
  -- initialize --signers '["G...","G..."]' --threshold 2
```

### 7. Record Contract Addresses

Add deployed addresses to your `.env`:

```env
CONTRACT_STELLAR_PAY_PAYMENT=C...
CONTRACT_STELLAR_PAY_ESCROW=C...
CONTRACT_STELLAR_PAY_MULTISIG=C...
CONTRACT_STELLAR_PAY_TREASURY=C...
CONTRACT_STELLAR_PAY_SUBSCRIPTIONS=C...
CONTRACT_STELLAR_PAY_INVOICES=C...
CONTRACT_STELLAR_PAY_MERCHANT=C...
CONTRACT_STELLAR_PAY_REWARDS=C...
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
| Payment       | [`CC5UU...VHLCA`](https://stellar.expert/explorer/testnet/contract/CC5UUVJCU3WRXDPDE3MEP65BN7XASQDV6O5IWVQRT53D5UKJ63UVHLCA)   |
| Escrow        | [`CA2KM...M23GOY`](https://stellar.expert/explorer/testnet/contract/CA2KMJRW3VDB65U5CLN7VF7AKDQXZ7OYIVUEDBA673UAECUYR6M23GOY)  |
| Multisig      | [`CAPHT...J6TGUH`](https://stellar.expert/explorer/testnet/contract/CAPHTEX57F3P5DHX67TV7CDHEHEC5COHQ7TDBSYYNN4MN6PCF6J6TGUH)  |
| Treasury      | [`CB3FI...KY2TH`](https://stellar.expert/explorer/testnet/contract/CB3FI5CKQAO2INOWFIMFLZXCXDUK3EMJNA5B5WEPRMGSP75NTX3KY2TH)   |
| Subscriptions | [`CDU4A...7QK46K`](https://stellar.expert/explorer/testnet/contract/CDU4ANSQWZMVPZDNSE2FWCXSOBIVJWGODC3CLCZGIILKUIMW3M7QK46K)  |
| Invoices      | [`CCQFA...2QBGR5`](https://stellar.expert/explorer/testnet/contract/CCQFABKSRSVAZGAXHQIR5FPPMFPNS5BHTKYRLAVKMMJE76546Q2QBGR5)  |
| Merchant      | [`CBT3H...Q3SX3I7`](https://stellar.expert/explorer/testnet/contract/CBT3HOK5WJ6UTO6S3I5ZE3JHB5IPIJBWCFXZZGO26T6T7OXPWQ3SX3I7) |
| Rewards       | [`CBE3J...B37Z4IU`](https://stellar.expert/explorer/testnet/contract/CBE3JCWEH4D6INRELW62CPVK4ZHFUZRPGLKCTGAH2B4IALINFB37Z4IU) |

Full addresses are in [`.deployed-contracts.env`](../.deployed-contracts.env).

> **Verification (2026-09-07):** all eight contract addresses above were verified
> live on Stellar testnet via the Soroban RPC `getLedgerEntries` method — each
> returned a contract-instance ledger entry (deployed around ledger 4,067,8xx on
> 2026-08-10 from `GCYOTZ…RMQ5S5`, per Horizon `invoke_host_function` history).

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
