# Governance

This document describes how the Azure StellarPay Hub project is run: who decides
what, how decisions are made, and how contributors can take on more
responsibility. It is intentionally lightweight — the project is small and the
goal is to make the rules legible, not to add ceremony.

## Principles

1. **Evidence over claims.** Documentation, README status tables and the security
   threat model state what is actually implemented, tested and deployed. A
   capability that is not verifiable is labelled as such (`EXPERIMENTAL`,
   `SCAFFOLD`, or a known limitation) rather than described as done.
2. **Security is a review gate, not a feature.** Changes to the on-chain
   contracts, the authentication and payment paths, and the CI/CD pipelines
   require maintainer review before merge.
3. **Everything is public by default.** Design discussion, status and known
   limitations live in the repository.

## Roles

| Role            | Responsibility                                                                                                   | How you get it                                     |
| --------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| **Contributor** | Opens issues and pull requests under the [DCO](#developer-certificate-of-origin)                                 | Open a pull request                                |
| **Reviewer**    | Reviews pull requests in an area they have contributed to                                                        | Sustained, high-quality contributions in that area |
| **Maintainer**  | Merges, cuts releases, triages security reports, holds write access — listed in [MAINTAINERS.md](MAINTAINERS.md) | Nominated by a maintainer, see below               |

## Decision making

- **Day-to-day changes** (bug fixes, docs, refactors, dependency updates) are
  decided by pull-request review. One maintainer approval merges them.
- **Substantial changes** (new contracts, breaking API changes, storage or
  migration changes, new infrastructure targets) start as an issue in the
  repository and need a maintainer to agree on the approach before
  implementation. The rationale and the rejected alternatives are recorded in the
  issue, and the outcome is written up in [`docs/`](docs/) and
  [`CHANGELOG.md`](CHANGELOG.md).
- **Security fixes** follow [SECURITY.md](SECURITY.md): reported privately, fixed
  on a private branch when needed, disclosed in the changelog after a release.
- **Deadlock**: if maintainers disagree and cannot reach consensus, the change
  does not land. The status quo wins — this is deliberate for a payments system,
  where an unreviewed change is worse than no change.

Pull requests are merged with a squash merge onto `main`, which is expected to
stay releasable at all times (see [CONTRIBUTING.md](CONTRIBUTING.md)).

## Releases

- The project follows [Semantic Versioning](https://semver.org/) with
  [Conventional Commits](https://www.conventionalcommits.org/).
- [`CHANGELOG.md`](CHANGELOG.md) is the source of truth for release notes. The
  `[Unreleased]` section accumulates changes between tags.
- A release is a signed tag (`v0.2.0`, `v0.3.0`, …) plus a changelog entry. The
  Chrome extension is versioned and released independently under
  `extension-v*` tags.
- A release must not overstate deployment status. Nothing in this repository is
  deployed to Stellar mainnet, and the `[Unreleased]` section plus the README's
  verification table must reflect the network actually in use.

## Becoming a maintainer

A contributor is nominated by an existing maintainer when they have:

- had multiple pull requests merged, including at least one non-trivial change
  with tests;
- shown they understand and respect the project's security boundaries (payment
  truth comes from the chain, ownership is always scoped, secrets never land in
  the repository or the audit log);
- participated constructively in review; and
- agreed to the responsibilities in [MAINTAINERS.md](MAINTAINERS.md).

Nomination is agreed among the current maintainers and recorded in a pull
request that adds the person to `MAINTAINERS.md` and `.github/CODEOWNERS`.

## Developer Certificate of Origin

Every commit must be signed off under the
[Developer Certificate of Origin](https://developercertificate.org/) — see
[CONTRIBUTING.md](CONTRIBUTING.md#developer-certificate-of-origin). This is
checked automatically by `.github/workflows/dco.yml` on every pull request, not
left to reviewer discretion. The project does not require a separate Contributor
License Agreement: contributions are licensed under the project's
[MIT License](LICENSE).

## Changes to this document

Changes to `GOVERNANCE.md`, `MAINTAINERS.md` or `.github/CODEOWNERS` are
substantial changes and need a maintainer approval.
