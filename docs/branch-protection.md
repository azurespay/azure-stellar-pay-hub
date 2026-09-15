# Branch protection for `main`

**Status: policy defined, not yet applied.** Applying it requires the
Administration write permission on the repository; the token used by the
automation that produced this file can read the ruleset list but receives
`403 Resource not accessible by integration` for both
`PUT /branches/main/protection` and `POST /rulesets`. Run the command below as a
repository admin.

Today `GET /repos/azurespay/azure-stellar-pay-hub/branches/main` reports
`"protected": false`, so nothing currently prevents a pull request from being
merged with failing checks.

## Why this matters

Every gate the project advertises — the four CI jobs, the DCO sign-off check and
CodeQL — is advisory until it is a required status check. A reviewer evaluating
the repository reads "CI passes" as "CI is enforced", and OpenSSF Scorecard
scores `Branch-Protection` (currently 0 because the branch is unprotected) on
exactly this configuration.

## The required checks

| Check                             | Workflow | Runs on every PR | Why it is required                              |
| --------------------------------- | -------- | ---------------- | ----------------------------------------------- |
| `Lint, typecheck & test`          | CI       | yes              | Format, lint, typecheck and 616 unit tests      |
| `Build apps & packages`           | CI       | yes              | Every app and package still compiles            |
| `Build Soroban contracts`         | CI       | yes              | The contracts still build                       |
| `Testnet E2E (live, required)`    | CI       | yes              | A real testnet payment actually settles         |
| `Every commit is signed off`      | DCO      | yes              | Developer Certificate of Origin on every commit |
| `Analyze JavaScript & TypeScript` | CodeQL   | yes (not forks)  | Static analysis before merge                    |

`Scorecard analysis` is deliberately **not** in the list: the Scorecard workflow
triggers on `push`, `schedule`, `branch_protection_rule` and `workflow_dispatch`
only, never on `pull_request`. A required check that never reports leaves every
PR stuck on "Expected — waiting for status to be reported", which would block
all development rather than protect it.

## Applying it

The payload keeps `enforce_admins: false` and leaves
`required_pull_request_reviews` off, so direct pushes to `main` — including the
`Update Soroban SDK badge` job — keep working exactly as they do now. Required
status checks gate merges into the branch, not pushes.

```bash
cat > /tmp/branch-protection.json <<'JSON'
{
  "required_status_checks": {
    "strict": false,
    "contexts": [
      "Lint, typecheck & test",
      "Build apps & packages",
      "Build Soroban contracts",
      "Testnet E2E (live, required)",
      "Every commit is signed off",
      "Analyze JavaScript & TypeScript"
    ]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "required_linear_history": false,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": false
}
JSON

gh api --method PUT repos/azurespay/azure-stellar-pay-hub/branches/main/protection \
  --input /tmp/branch-protection.json
```

## Verifying it

```bash
gh api repos/azurespay/azure-stellar-pay-hub/branches/main/protection \
  -q '.required_status_checks.contexts[]'
```

Each name must match a job's `name:` in `.github/workflows/` exactly — a typo
produces a check that is required but never satisfied.

## Known trade-off

`Analyze JavaScript & TypeScript` is skipped on pull requests from forks, because
a fork's token cannot be granted `security-events: write`. A skipped job reports
as skipped rather than as a failure, so it satisfies the requirement, but if
that ever changes the check should be dropped rather than leaving contributions
from forks permanently unmergeable.
