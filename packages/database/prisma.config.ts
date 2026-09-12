import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { config as loadEnvFile } from 'dotenv';
import { defineConfig } from 'prisma/config';

/**
 * Prisma CLI configuration (replaces the deprecated `package.json#prisma` field,
 * which Prisma 7 removes).
 *
 * Two behaviours have to be reproduced explicitly here, because **the CLI stops
 * loading `.env` on its own once a config file exists** — it prints
 * "Prisma config detected, skipping environment variable loading":
 *
 *   1. `DATABASE_URL` (and anything else the schema needs) must be read from a
 *      `.env` file before Prisma parses the schema, or every `db:*` script dies
 *      with "Environment variable not found: DATABASE_URL".
 *   2. The schema/migrations paths must not depend on the current working
 *      directory, so the scripts keep working from the package directory
 *      (`pnpm --filter @stellar-pay/database …`) and from the repo root.
 *
 * dotenv does not override variables that are already set, so an exported
 * environment always wins — CI passes `DATABASE_URL` inline and is unaffected.
 */
const packageDir = __dirname;

// Same precedence the CLI used before (its cwd, i.e. this package, then the
// repo root that `pnpm generate:env` writes).
for (const envFile of [join(packageDir, '.env'), resolve(packageDir, '..', '..', '.env')]) {
  if (existsSync(envFile)) {
    loadEnvFile({ path: envFile });
  }
}

export default defineConfig({
  schema: join(packageDir, 'prisma', 'schema.prisma'),
  migrations: {
    path: join(packageDir, 'prisma', 'migrations'),
    seed: 'tsx scripts/seed.ts',
  },
});
