# syntax=docker/dockerfile:1
# Build any Next.js app in the monorepo. Pass --build-arg APP=web|admin|explorer|docs
FROM node:22-alpine AS base
RUN corepack enable

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json nx.json ./
COPY packages ./packages
COPY apps ./apps
ARG APP=web
RUN pnpm install --frozen-lockfile --filter @stellar-pay/${APP}... --filter @stellar-pay/ui --filter @stellar-pay/sdk --filter @stellar-pay/wallet --filter @stellar-pay/types --filter @stellar-pay/shared

FROM deps AS build
WORKDIR /app
ARG APP=web
# Build the packages the app consumes, then the app itself.
RUN pnpm --filter @stellar-pay/types build && \
    pnpm --filter @stellar-pay/shared build && \
    pnpm --filter @stellar-pay/sdk build && \
    pnpm --filter @stellar-pay/wallet build && \
    pnpm --filter @stellar-pay/ui build
RUN pnpm --filter @stellar-pay/${APP} build
RUN pnpm --filter @stellar-pay/${APP} --prod --legacy deploy /out/node_modules
# Some apps ship a public/ dir and some don't; stage it so the runtime COPY
# below never fails on a missing source path.
RUN mkdir -p /out/public && if [ -d apps/${APP}/public ]; then cp -r apps/${APP}/public/. /out/public/; fi

# --- Runtime stage ----------------------------------------------------------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
ARG APP=web
ENV APP=${APP}
# The standalone build preserves the monorepo layout: the server entrypoint
# lives at apps/<APP>/server.js (inside the standalone output) with the traced
# node_modules at the standalone root. Copy the whole tree, then the static
# assets and public dir back into the same relative paths the server expects.
COPY --from=build /app/apps/${APP}/.next/standalone /app
COPY --from=build /app/apps/${APP}/.next/static /app/apps/${APP}/.next/static
COPY --from=build /out/public /app/apps/${APP}/public
EXPOSE 3000
CMD ["sh", "-c", "node apps/${APP}/server.js"]
