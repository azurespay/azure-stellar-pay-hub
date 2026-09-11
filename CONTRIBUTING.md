# Contributing to Azure StellarPay Hub

Thanks for wanting to contribute! 🚀

This project is part of the Stellar ecosystem — we build open-source payment infrastructure
on Stellar and Soroban. Whether you're fixing a typo, improving docs, or shipping a new
Soroban contract, your help is welcome.

## Ground Rules

- Be respectful. We follow the [Contributor Covenant](CODE_OF_CONDUCT.md).
- Follow existing naming and project conventions (see [Architecture](docs/architecture.md)).
- Every PR must pass `pnpm lint`, `pnpm typecheck`, and `pnpm test`.
- Rust contracts need unit tests for every public entry point.
- **No secrets in code** — use environment variables or a secret store.

## Getting Started

```bash
corepack enable
pnpm install
pnpm generate:env        # scaffold .env files
pnpm docker:up           # Postgres + Redis
pnpm db:generate && pnpm db:push && pnpm db:seed
pnpm dev                 # api:4000 · web:3000 · admin:3001 · explorer:3002 · docs:3003
```

## Finding Work

Browse [open issues](https://github.com/azurespay/azure-stellar-pay-hub/issues)
filtered by label:

- [`good first issue`](https://github.com/azurespay/azure-stellar-pay-hub/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) — beginner-friendly tasks
- [`help wanted`](https://github.com/azurespay/azure-stellar-pay-hub/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22) — we'd love community help
- [`complexity:low`](https://github.com/azurespay/azure-stellar-pay-hub/issues?q=is%3Aissue+is%3Aopen+label%3A%22complexity%3Alow%22) — small, scoped tasks
- [`complexity:medium`](https://github.com/azurespay/azure-stellar-pay-hub/issues?q=is%3Aissue+is%3Aopen+label%3A%22complexity%3Amedium%22) — feature work
- [`complexity:high`](https://github.com/azurespay/azure-stellar-pay-hub/issues?q=is%3Aissue+is%3Aopen+label%3A%22complexity%3Ahigh%22) — larger refactors or integrations

Comment on an issue to claim it, then open a PR referencing it.

## Branch Strategy

```text
main            ← production-ready only
  ├─ feat/<slug>      feature work (PR into main)
  ├─ fix/<slug>       bug fixes
  ├─ chore/<slug>     tooling, docs, CI
  └─ refactor/<slug>  structural changes
```

## Pull Request Process

1. Fork the repo and create your branch from `main`.
2. If you added code, add tests that cover it.
3. If you changed APIs or public TypeScript types, update the docs in `docs/`.
4. If the Prisma schema changed, include a migration (`pnpm db:migrate`).
5. Ensure the full CI suite passes locally:

   ```bash
   pnpm lint
   pnpm typecheck
   pnpm test
   pnpm format:check
   ```

6. Once CI is green and a maintainer has reviewed, your PR will be merged.

## Commit Conventions

We use [Conventional Commits](https://www.conventionalcommits.org/):

| Prefix      | When                                  |
| ----------- | ------------------------------------- |
| `feat:`     | New feature                           |
| `fix:`      | Bug fix                               |
| `chore:`    | Tooling, deps, config                 |
| `docs:`     | Documentation only                    |
| `refactor:` | Restructuring without behavior change |
| `test:`     | Adding or improving tests             |
| `ci:`       | CI / deployment changes               |
| `style:`    | Formatting, whitespace                |

Example: `feat: add invoice expiry to Soroban contract`

## Project Structure

```text
apps/            web · admin · api · explorer · docs        (NestJS + Next.js)
contracts/       payment · escrow · multisig · treasury · subscriptions · invoices · merchant · rewards  (Soroban/Rust)
packages/        sdk · wallet · ui · authentication · database · validation · analytics · notifications · config · logger · shared · types
infrastructure/  docker · kubernetes · terraform · monitoring
docs/            architecture · api · sdk · contracts · database · deployment · development
```

## Code Style

- **TypeScript**: ESLint + Prettier (configured at the root). Run `pnpm format` before committing.
- **Rust**: Standard `rustfmt`. All contracts use `#[contracterror]` for typed errors and emit events for state changes.
- **Naming**: `camelCase` for JS/TS, `snake_case` for Rust. Use descriptive names — `buildPaymentTransaction`, not `buildTx`.

## Security

Found a vulnerability? Do **not** open a public issue.
See [SECURITY.md](SECURITY.md) for the private reporting process.

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](LICENSE).
