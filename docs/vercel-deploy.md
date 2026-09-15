# Vercel Deployment Guide

This monorepo deploys two Next.js apps to Vercel: **web** and **admin**.

## Prerequisites

- [Vercel CLI](https://vercel.com/docs/cli) installed or Vercel dashboard access
- GitHub repository connected to Vercel
- Railway API deployment running (for the backend API URL)

## Project Setup

### 1. Create Vercel Projects

Create two projects in the Vercel dashboard, both pointing to the same GitHub repository:

| Project           | Framework | Root Directory |
| ----------------- | --------- | -------------- |
| stellar-pay-web   | Next.js   | `apps/web`     |
| stellar-pay-admin | Next.js   | `apps/admin`   |

Vercel auto-detects the monorepo root from the `pnpm-workspace.yaml` and installs
dependencies from the repo root, even when the Root Directory is set to a subdirectory.

### 2. Environment Variables

Set these in **each** project's Settings → Environment Variables:

| Variable                      | Value                              | Notes                                                            |
| ----------------------------- | ---------------------------------- | ---------------------------------------------------------------- |
| `NEXT_PUBLIC_API_URL`         | `https://your-api.railway.app/api` | **Required** — your Railway API URL, including the `/api` prefix |
| `NEXT_PUBLIC_STELLAR_NETWORK` | `testnet` or `public`              | Defaults to `testnet` in vercel.json                             |

`NEXT_PUBLIC_API_URL` is the base the SDK appends request paths to, and the API
is mounted under `/api` (`apps/api/src/main.ts` sets that global prefix), so the
prefix belongs in the value — a bare origin sends every request to the wrong
path and 404s. The clients append a missing prefix themselves, so a bare origin
still works, but set the explicit form above.

For the admin app, also consider:

- Restricting access via [Vercel Authentication](https://vercel.com/docs/security/deployment-protection) or a middleware auth check.

### 3. Node.js Version

Both apps have `.node-version` files pinned to **Node.js 22**. Vercel respects this
automatically. The root `.node-version` also pins Node 22 as a fallback.

### 4. pnpm Version

The root `package.json` declares `"packageManager": "pnpm@10.32.1"`. Vercel uses
Corepack to auto-install the correct pnpm version.

## Build Configuration

Each app has its own `vercel.json` with:

- **installCommand**: `pnpm install --frozen-lockfile`
- **buildCommand**: Builds required workspace packages (`@stellar-pay/types`, `@stellar-pay/ui`, etc.) then builds the app
- **outputDirectory**: `.next` (standard Next.js output)
- **Security headers**: `X-Content-Type-Options`, `X-Frame-Options`, `X-XSS-Protection`, `Referrer-Policy`, `Permissions-Policy`

## Deployment

### Automatic (recommended)

Push to `main` — Vercel auto-deploys both projects via the GitHub integration.

### Manual

```bash
# Deploy web
cd apps/web
vercel --prod

# Deploy admin
cd apps/admin
vercel --prod
```

## Troubleshooting

### Build fails with `useContext` error

This is a Node.js version mismatch. Ensure:

- `.node-version` files are present with `22`
- Vercel project settings have Node.js version set to 22 (not "Latest")

### `pnpm install` fails

Ensure the Vercel project's Root Directory is set correctly:

- **web**: `apps/web`
- **admin**: `apps/admin`

Vercel auto-detects the monorepo root from `pnpm-workspace.yaml`.

### API connection errors

Verify `NEXT_PUBLIC_API_URL` is set in Vercel dashboard and points to your
running Railway API instance. The health endpoint should respond:

```bash
curl https://your-api.railway.app/api/health
# {"status":"ok","service":"stellar-pay-api","database":"up",...}
```
