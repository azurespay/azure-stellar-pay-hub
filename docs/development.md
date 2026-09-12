---
title: Development
description: Local development guide — prerequisites, install, running each app.
---

# Development

## Prerequisites

| Tool        | Version               | Notes                            |
| ----------- | --------------------- | -------------------------------- |
| Node.js     | ≥ 20.9 (use `.nvmrc`) | `nvm install && nvm use`         |
| pnpm        | ≥ 9                   | `corepack enable`                |
| Docker      | latest                | Postgres + Redis for local dev   |
| Rust        | stable                | Soroban contracts (optional)     |
| soroban-cli | latest stable         | Contract build/deploy (optional) |

## Install & first run

```bash
corepack enable
pnpm install
pnpm generate:env        # scaffold .env files from templates
pnpm docker:up           # postgres + redis containers
pnpm db:generate         # prisma client
pnpm db:push && pnpm db:seed
pnpm dev                 # everything (api, web, admin, explorer, docs)
```

## Per-app development

| App        | URL                   | Command             |
| ---------- | --------------------- | ------------------- |
| `web`      | http://localhost:3000 | `pnpm dev:web`      |
| `admin`    | http://localhost:3001 | `pnpm dev:admin`    |
| `api`      | http://localhost:4000 | `pnpm dev:api`      |
| `explorer` | http://localhost:3002 | `pnpm dev:explorer` |
| `docs`     | http://localhost:3003 | `pnpm dev:docs`     |

## Testing & quality

```bash
pnpm lint              # eslint across workspace
pnpm typecheck         # tsc --noEmit everywhere
pnpm test              # unit + integration suites, then the Soroban contract build + tests
pnpm test:unit         # unit + integration suites only (skips the Rust step)
pnpm contracts:verify  # soroban contract build + tests
pnpm format:check      # prettier
```

## Scripts

- `scripts/generate-env.sh` — creates per-app `.env` files from `.env.example` templates.
- `scripts/setup.sh` — full first-time bootstrap (install, db generate/push/seed).
- `tests/smoke.mjs` — boots the API and hits the health endpoint (see `pnpm test:e2e`).

## Adding a new package

```bash
# create packages/<name> with package.json (name: @stellar-pay/<name>)
# add it to pnpm-workspace.yaml globs (already covered by packages/*)
pnpm install
nx graph               # verify the dependency graph
```
