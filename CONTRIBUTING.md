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
- Sign off every commit under the [Developer Certificate of Origin](#developer-certificate-of-origin)
  (`git commit -s`) — CI enforces it on every commit in a pull request.
- How the project is run: [GOVERNANCE.md](GOVERNANCE.md) · who reviews what:
  [MAINTAINERS.md](MAINTAINERS.md).

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

6. Sign off your commits (see [Developer Certificate of Origin](#developer-certificate-of-origin)).
7. Once CI is green and a maintainer has reviewed, your PR will be merged.

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
contracts/       payment · escrow · treasury · subscriptions · invoices · merchant  (Soroban/Rust)
packages/        sdk · wallet · ui · authentication · database · validation · analytics · notifications · config · logger · shared · types
infrastructure/  docker · kubernetes · terraform · monitoring
docs/            architecture · api · sdk · contracts · database · deployment · development
```

## Code Style

- **TypeScript**: ESLint + Prettier (configured at the root). Run `pnpm format` before committing.
- **Rust**: Standard `rustfmt`. All contracts use `#[contracterror]` for typed errors and emit events for state changes.
- **Naming**: `camelCase` for JS/TS, `snake_case` for Rust. Use descriptive names — `buildPaymentTransaction`, not `buildTx`.

## Developer Certificate of Origin

This project uses the [Developer Certificate of Origin](https://developercertificate.org/)
(DCO) instead of a Contributor License Agreement. By signing off a commit you
certify that you wrote the contribution, or that it is based on work you are
allowed to submit under the project's [MIT License](LICENSE).

Add the sign-off to every commit with `git commit -s`, which appends a trailer
to the commit message:

```text
feat: add invoice expiry to the Soroban contract

Signed-off-by: Your Name <your.email@example.com>
```

Use a real name and a reachable email address; anonymous sign-offs are not
accepted. To sign off a whole branch after the fact, use
`git rebase --signoff main`.

[`.github/workflows/dco.yml`](.github/workflows/dco.yml) enforces the trailer on
every commit in a pull request — the check fails and lists each offending commit
when a sign-off is missing or its address does not match the commit author. The
same check runs locally, against `origin/main..HEAD` by default:

```bash
pnpm dco                        # origin/main..HEAD
pnpm dco origin/main..HEAD      # an explicit range
```

Two details worth knowing. Merge commits are skipped (GitHub creates them
unsigned), and commits authored by dependency bots are exempt because they
cannot sign off. A squash merge rewrites the message, so `main` will not carry
the trailer even when every commit in the PR did — the PR's commits are the
record of certification.

## Security

Found a vulnerability? Do **not** open a public issue.
See [SECURITY.md](SECURITY.md) for the private reporting process.

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](LICENSE).
