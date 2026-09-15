# Maintainers

Maintainers review and merge pull requests, cut releases, and are responsible for
security response (see [SECURITY.md](SECURITY.md)). The decision process is
described in [GOVERNANCE.md](GOVERNANCE.md).

| Maintainer                       | GitHub                                       | Areas                                                      |
| -------------------------------- | -------------------------------------------- | ---------------------------------------------------------- |
| Azure StellarPay Hub maintainers | [@sheyman546](https://github.com/sheyman546) | All areas — contracts, API, apps, packages, infrastructure |

Commit access is granted to contributors who have had several pull requests
merged and have demonstrated care with the project's security posture (see
[GOVERNANCE.md](GOVERNANCE.md#becoming-a-maintainer) for the exact criteria).

## Review requirements

- A change to `contracts/` (the deployed Soroban contracts) needs a maintainer
  review before merge.
- A change to `.github/workflows/` or `infrastructure/` (CI/CD and deployment)
  needs a maintainer review before merge.
- Every other change needs one approving review.

Path-level ownership is encoded in [`.github/CODEOWNERS`](.github/CODEOWNERS).

## Emeritus

None yet.
