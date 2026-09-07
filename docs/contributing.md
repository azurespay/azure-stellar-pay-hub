---
title: Contributing
description: How to contribute — branch strategy, PR checklist, coding standards.
---

# Contributing

Thanks for contributing to Azure StellarPay Hub! 🚀

## Ground rules

- Follow the existing naming and structure conventions (see `docs/architecture.md`).
- Every PR must pass `pnpm lint`, `pnpm typecheck`, and `pnpm test`.
- Rust contracts need unit tests for every entry point.
- No secrets in code — ever. Use env vars / secret stores.

## Branch strategy

```text
main            ← reviewed & tested only (platform is currently on testnet)
  └─ feat/<slug>      feature work (PR into main)
  └─ fix/<slug>       bug fixes
  └─ chore/<slug>     tooling/docs
```

## PR checklist

- [ ] Tests pass locally (`pnpm test`)
- [ ] Typecheck + lint clean (`pnpm typecheck && pnpm lint`)
- [ ] Docs updated if public API/behavior changed (`docs/*.md`)
- [ ] Migration added if Prisma schema changed
- [ ] Changelog entry added (if applicable)

## Conventional commits

Use `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`, `ci:` prefixes so CI can
auto-label PRs.

## Security

Found a vulnerability? Do **not** open a public issue — see `SECURITY.md` for the private
reporting process.

## License

MIT — see `LICENSE`.
