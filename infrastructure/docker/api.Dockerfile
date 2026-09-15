# syntax=docker/dockerfile:1
#
# The base image is pinned by tag **and** digest: a tag is a moving pointer, so
# `node:22-alpine` silently changes under us between builds and a compromised or
# renamed tag would ship whatever it points at. `.github/dependabot.yml` carries
# a `docker` ecosystem entry for this directory, so the digest is bumped by PR
# (with the `:22-alpine` tag kept readable) instead of drifting unnoticed.
#
# --- Build stage -----------------------------------------------------------
FROM node:26-alpine@sha256:ef24c5053d50fdc3e4e56eb4e7ddb7861874ab0fdc797046ba897581deb8e868 AS base
RUN corepack enable

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json nx.json ./
COPY packages ./packages
COPY apps/api ./apps/api
RUN pnpm install --frozen-lockfile --filter @stellar-pay/api... --filter @stellar-pay/database

FROM deps AS build
WORKDIR /app
# Build workspace packages with explicit ordering (TypeScript cross-references
# require each package's dist/ before dependents compile).
# Build order: types → shared → config → logger → database → validation → sdk → authentication → notifications
RUN pnpm --filter @stellar-pay/types build && \
    pnpm --filter @stellar-pay/shared build && \
    pnpm --filter @stellar-pay/config build && \
    pnpm --filter @stellar-pay/logger build && \
    pnpm --filter @stellar-pay/database build && \
    pnpm --filter @stellar-pay/validation build && \
    pnpm --filter @stellar-pay/sdk build && \
    pnpm --filter @stellar-pay/authentication build && \
    pnpm --filter @stellar-pay/notifications build
# Build the API last (depends on all packages above)
RUN pnpm --filter @stellar-pay/api build
# Prune to production-only node_modules into /out/node_modules
RUN pnpm --filter @stellar-pay/api --prod --legacy deploy /out/node_modules

# --- Runtime stage ----------------------------------------------------------
FROM node:26-alpine@sha256:ef24c5053d50fdc3e4e56eb4e7ddb7861874ab0fdc797046ba897581deb8e868 AS runtime
ENV NODE_ENV=production
WORKDIR /app

# pnpm --legacy deploy nests dependencies under node_modules/node_modules.
# Flatten: copy just the actual deps to /app/node_modules.
COPY --from=build /out/node_modules/node_modules /app/node_modules

# Compiled API
COPY --from=build /app/apps/api/dist /app/dist

# Prisma schema and migrations — used by migrate deploy at startup
COPY --from=build /app/packages/database/prisma /app/prisma

# Seed script (for manual seeding via Railway shell)
COPY --from=build /app/packages/database/scripts/seed.ts /app/scripts/seed.ts

# Entrypoint
COPY infrastructure/docker/start.sh /app/start.sh
RUN chmod +x /app/start.sh

EXPOSE 4000
CMD ["/app/start.sh"]
