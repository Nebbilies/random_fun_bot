# Roll allowances and cooldowns: validation

Date: 2026-11-11. Baseline: `79995d1`.
Branch: `refactor/roll-allowances`, implemented in the `.idea` checkout.

## Preparation and baseline

- Tracked files were clean before starting. Incoming tracked paths did not collide with the eight original untracked documents.
- Fetched and fast-forwarded `main` to `79995d1`, then created the refactor branch. The existing `feat/threadbreaker` branch was preserved.
- Used the existing Node v22.23.2 executable and installed dependencies. No dependency installation, upgrade, or lockfile change was required.
- Baseline catalog typechecking passed. The full baseline suite passed: **1,829 passed, one skipped, zero failures** (`roll-allowance-baseline-tests.log`).
- Test subprocesses ran outside the sandbox because the machine's sandbox blocks Node test subprocess creation. No system settings or test temporary-directory changes were needed.

## Simple TDD and first commit

- The initial service test failed with `ERR_MODULE_NOT_FOUND` before the new service existed (`roll-allowance-red.log`).
- After extraction, it passed using feature operations and legacy reservation/status imports on the same SQLite connection.
- Additional service scenarios passed: duplicate requests do not debit twice; default and custom reset boundaries remain exact; legacy daily eligibility survives schedule activation; normal eligibility differs from token availability on a query-only connection; global credits retain capacity clamps, stale-period behavior, counts, and input validation.
- Focused existing allowance/command/affection/buff regressions passed. Catalog typechecking passed with the new modules and service tests included.
- The first implementation commit passed the full suite independently: **1,834 passed, one skipped, zero failures** (`roll-allowance-commit-1-tests.log`).

## Lifecycle delegation

Two real SQLite failure-injection tests passed before and after storage delegation:

1. A rejected roll insert rolls back the earlier Rolling Fever refund, subsequent debit, and buff spending. A retry preserves refund-before-debit ordering, and a duplicate retry does not spend again.
2. A rejected claim-history insert rolls back ownership, claim usage, and roll settlement. Removing the injected failure allows the same claim to succeed and start the normal cooldown.

The four relevant command changes replace imports only. Their parsing, response text, and permissions are unchanged. The service has no direct SQL or dependency on `lib/characterRolls.js`; that module retains compatibility exports and lifecycle transaction ownership. The repository starts no transactions.

## Final checks

- Full regression suite: **1,836 passed, one skipped, zero failures** on Node v22.23.2 (`roll-allowance-final-tests.log`). This includes the existing legacy/final-schema, affection, ring/token, mystery, command, and recovery suites.
- Catalog typechecking passed with both new modules and both new test files included.
- Node syntax checks passed for the new modules, modified lifecycle/commands, and new tests.
- Diff checks passed after final cleanup. Review confirmed identical reset arithmetic and public operation contracts, preserved lifecycle call order and transaction ownership, no direct allowance SQL remaining in the lifecycle, and no service-to-compatibility import cycle.
- The first two implementation slices were committed only after passing their respective regression runs. The final documentation commit records the approved design, self-reviewed plan, and this evidence.
- Only explicitly selected stage files were staged. The eight original untracked documents remain outside these commits.

No schema, dependency, Discord runtime, mystery, vault, reward, or unrelated type changes are included. No live bot login, production database access, push, PR, merge, or deployment is part of this stage.
