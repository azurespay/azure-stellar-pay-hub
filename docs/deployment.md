---
title: Deployment
description: Docker, Kubernetes, Terraform (Azure), and monitoring — production deployment guide.
---

# Deployment

## Deployment targets & status

The repository supports several deployment paths. They are **not** equivalent
production routes — classify them as follows:

| Target                                                        | Class                                    | Notes                                                                                                                                                                                       |
| ------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Docker Compose (`pnpm docker:up` + dev)                       | **Canonical (local dev)**                | Postgres + Redis for development and the test tiers below                                                                                                                                   |
| Railway (`deploy-railway.yml`)                                | **Supported — current hosted API**       | Auto-deploys the API on push to `main`; smoke-tests the `/api/health` endpoint. This is the API that the hosted frontends point at. Uses testnet by default — **not a mainnet deployment**  |
| Vercel (frontends)                                            | **Supported — current hosted frontends** | Auto-deploys on push via the Vercel GitHub integration (admin/web/explorer/docs)                                                                                                            |
| Kubernetes / AKS (`deploy.yml` + `infrastructure/kubernetes`) | **Experimental / production-oriented**   | GHCR images + Kustomize + rollout on `main`. The workflow's smoke test still uses an `api.stellar-pay.example` placeholder domain, so this path is **not verified as the live environment** |
| Terraform (Azure)                                             | **Experimental / production-oriented**   | Provisions AKS, managed Postgres/Redis and Key Vault — the IaC for the AKS path                                                                                                             |
| Stellar testnet (`scripts/deploy-testnet.sh`)                 | **Canonical blockchain path**            | Reproducible Soroban contract + API deployment to **Stellar testnet only** (see `docs/testnet-deploy.md`)                                                                                   |
| Stellar mainnet                                               | **Not deployed**                         | Requires explicit human approval after contract/integration/E2E/security review (see implementation guardrails)                                                                             |

**Deployment state today:** the platform is production-_oriented_ (Docker/K8s/
Terraform/monitoring all exist), but real usage runs on **Stellar testnet** with
demo data. Nothing has been deployed to Stellar mainnet and no mainnet
contracts exist. Do not read the existence of production infrastructure as
proof of a production deployment.

## 1. Local with Docker Compose

```bash
cp .env.example .env            # fill in values
pnpm docker:up                  # postgres + redis
pnpm db:generate && pnpm db:push && pnpm db:seed
pnpm dev                        # nx run-many, starts api + web + admin
```

## 2. Production images

`infrastructure/docker/` contains multi-stage Dockerfiles:

- `api.Dockerfile` — builds the workspace, runs `nx build api`, ships the compiled NestJS app.
- `web.Dockerfile` — builds the Next.js web app and serves it with the standalone output.

```bash
docker build -f infrastructure/docker/api.Dockerfile -t stellar-pay/api .
docker build -f infrastructure/docker/web.Dockerfile -t stellar-pay/web .
```

## 3. Kubernetes

`infrastructure/kubernetes/` is a Kustomize bundle: namespace, ConfigMap, Secret (example),
Postgres + Redis StatefulSets, API + Web deployments, and an NGINX ingress with TLS.

```bash
kubectl apply -k infrastructure/kubernetes
kubectl -n stellar-pay get pods
```

## 4. Terraform (Azure)

`infrastructure/terraform/` provisions the AKS cluster, managed Postgres (`flexible
server`), Redis cache, and Key Vault with Terraform Cloud state.

```bash
cd infrastructure/terraform
terraform init && terraform plan && terraform apply
```

## 5. Monitoring

`infrastructure/monitoring/` ships Prometheus + Grafana (auto-provisioned datasource) and a
base alert rule set (API error rate, 5xx spikes, payment failure rate). When
`METRICS_ENABLED=true` the API serves a Prometheus text-format endpoint at
**`/api/metrics`** (no auth — enable only where that is acceptable) with
`http_requests_total`, `payments_succeeded_total`, `payments_failed_total`,
`inbound_payments_credited_total`, and `indexer_last_poll_seconds` (event-processor
freshness). Metrics are in-memory and reset on restart — the database remains the
authoritative record. See `infrastructure/monitoring/README.md` for local run notes.

## 6. Health & readiness probes

- `GET /api/health` — liveness (process up; reports Postgres reachability).
- `GET /api/health/ready` — readiness: 200 only when Postgres **and** Redis respond;
  503 with per-component status otherwise. Intentionally shallow (no outbound Stellar
  calls) so an upstream Stellar incident is not misreported as an API incident.

## 7. CI/CD

GitHub Actions (`.github/workflows/`) runs on every PR and push to `main`:

- `ci.yml` — install, lint, typecheck, format, unit/integration tests, API integration
  tests (tier 3, Postgres + Redis), contract build + tests, app builds, security scans.
- `deploy-railway.yml` — deploys the API to Railway on push to `main` (API/Docker paths).
- `deploy.yml` — build + push Docker images to a registry, then roll AKS deployments
  (experimental path; not the live environment).

Deployment is gated by the same pipeline a human reviews: PRs run the full CI suite
before merge, and deploys only happen after merge to `main`. There is **no automated
mainnet deployment** — Stellar mainnet requires explicit human approval
(see `docs/testnet-deploy.md`).

## 8. Deployment checklist

Before any deployment to testnet (or later, mainnet):

- [ ] `pnpm typecheck` and `pnpm lint` pass
- [ ] `pnpm test` passes (unit + integration tiers)
- [ ] `pnpm --filter @stellar-pay/api test:e2e` passes (Postgres + Redis)
- [ ] Contracts build (`pnpm contracts:build`) and contract tests pass
- [ ] Contract addresses verified on-chain (testnet: `docs/testnet-deploy.md`)
- [ ] `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `ADMIN_PASSWORD`, `WEBHOOK_SIGNING_SECRET` set
- [ ] Health + readiness probes return 200 (`/api/health`, `/api/health/ready`)
- [ ] CORS origins and security headers configured (helmet is on by default)
- [ ] Rate limiting enabled (global throttler is on by default)
- [ ] Logging enabled (pino; JSON in production)
- [ ] Monitoring reachable (`METRICS_ENABLED=true` where Prometheus scrapes)
- [ ] No private keys/secrets in env files or images

Mainnet additionally requires: security review, contract + admin/upgrade authority review,
backup/recovery testing, monitoring verification, a rollback plan, and explicit human
approval.

## 9. Rollback & recovery

- **API / frontend**: keep the previous image/commit — Railway and AKS deploys are
  image-based, so rollback is re-deploying the prior version (`git revert` + push, or
  re-tag the previous image).
- **Database migrations**: migrations are forward-only (`prisma migrate deploy`).
  Before applying a migration in a shared environment, back up the database. To roll
  back a schema change, restore the pre-migration backup — never edit applied
  migrations in place.
- **Redis**: treat as recoverable cache/queue state, **not** the source of truth.
  Losing Redis only loses cursors/locks/rate-limit state; the `ChainEvent` table and
  on-chain Stellar state allow replay (see recovery below).
- **Indexer/event recovery**: cursors are persisted in Redis, and the `ChainEvent`
  unique-event ledger in Postgres is the correctness backstop — after a Redis loss,
  re-polls resume from the ledger, and duplicate deliveries are ignored idempotently.
- **Payments**: PostgreSQL + Stellar are authoritative. If a submit succeeded on-chain
  but the API lost the response, the indexer re-polls `SUBMITTED` rows via
  `getTransaction` and moves them to `CONFIRMED` on the ledger result.

## 10. Environment variables

See `.env.example` and `apps/api/.env.example` — every variable is documented with its
purpose and whether it is required or optional. Never commit secrets; inject via K8s
Secrets, Azure Key Vault, Railway dashboard, or the platform's secret store. Each
environment (local / testnet / mainnet) uses its own database, Redis, credentials,
contract addresses, and signing configuration — never reuse development credentials
for production.
