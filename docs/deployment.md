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
base alert rule set (API error rate, 5xx spikes, payment failure rate). The API exposes
metrics at `/metrics` when `METRICS_ENABLED=true`.

## CI/CD

GitHub Actions (`.github/workflows/`) runs on every PR and push to `main`:

- `ci.yml` — install, lint, typecheck, test, build contracts, build apps.
- `deploy.yml` — build + push Docker images to a registry, then roll AKS deployments.

## Environment variables

See `.env.example` and `apps/api/.env.example`. Never commit secrets; inject via K8s
Secrets, Azure Key Vault, or the platform's secret store.
