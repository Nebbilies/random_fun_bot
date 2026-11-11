# Roll publication, claims, and closure: validation

Date: 2026-11-11. Branch: `refactor/roll-lifecycle`.
Baseline: `dc7c8b1` (merged PR #46). Runtime: Node v22.23.2; existing dependencies.
Related: [approved design](roll-lifecycle-design.md), [self-reviewed plan](roll-lifecycle-plan.md).

## Changes

Extracted publication, failure, claims, escape refresh, lookup, claim notices, and reportability into the lifecycle service and concrete repository. Extracted shared durable snapshot validation, mystery-session lookup/terminal settlement, and synchronous delivery capture. Existing public paths retain compatibility re-exports. Runtime/delivery callers import the lifecycle and snapshot modules directly.

Reservation, mystery progression, cleanup/recovery policies, reward handling, schemas, dependencies, commands, and Discord payload/handler behavior remain unchanged. The lifecycle service contains no direct SQL. Repositories and shared settlement/capture helpers do not control transactions. Caller-owned claims retain their transaction-neutral entry point.

## Baseline and TDD evidence

- Baseline full suite: 1,836 passed, 1 skipped, 0 failed (1,837 total). Catalog typecheck passed.
- Snapshot test first failed with `ERR_MODULE_NOT_FOUND`, then passed after extraction.
- Mystery-settlement test first failed because the extracted terminal operation did not exist, then passed after moving the existing implementation.
- Delivery-capture test first failed with `ERR_MODULE_NOT_FOUND`, then passed after extraction.
- Lifecycle-service test first failed with `ERR_MODULE_NOT_FOUND`, then passed after extraction.
- Dependency slice: 59 focused tests passed; full suite 1,839 passed, 1 skipped, 0 failed; catalog typecheck and syntax checks passed.
- Lifecycle slice: 85 initial focused tests passed; expanded transaction/regression group 63 passed; full suite 1,845 passed, 1 skipped, 0 failed; catalog typecheck and syntax checks passed.
- Adapter slice: 84 focused tests passed; full suite 1,845 passed, 1 skipped, 0 failed; catalog typecheck and syntax checks passed.

The checked new transaction tests use a narrow type assertion for the legacy mystery function's string winner ID, whose existing default infers null. No unrelated production types were changed.

## Preservation evidence

New tests cover captured snapshots across catalog edits and corruption, terminal mystery rollback and repeated settlement, delivery capture rollback with reservation, outer capture transactions, compatibility imports, single-winner marriage/resource behavior, notice deduplication, ordinary expiry without row closure, exact report deadline, repeated failure, and committed publication refusal after ownership changes.

Final-schema transaction tests verify caller-owned claim rollback (including bypass-token spending), failed mystery settlement rolling back ownership and allowance/history with both state machines, and publication award failure restoring a retryable own appearance without duplicate affection. Existing suites retain escape boundary/reclaim/transfer coverage, Double Date/Crown/token precedence, ring and conservation behavior, mystery eligibility/settlement, legacy schemas, durable delivery acknowledgement, and recovery/cleanup behavior.

Static comparison verified all 11 retained functions in the compatibility module match baseline source exactly, including reservation, mystery progression, recovery, and cleanup. All 58 distinct SQL statements across the original roll and delivery modules are preserved after extraction, normalizing whitespace. Import and diff review confirmed adapter changes are import-only and feature modules do not import the compatibility facade or Discord runtime. New and legacy modules passed a cold-import smoke check without bot startup.

## Final verification

After all implementation commits:

- Full suite: **1,845 passed, 1 skipped, 0 failed** (1,846 total), repeated after the adapter integration suite; final duration 44.9 seconds.
- Catalog typecheck: passed with `node_modules/typescript/bin/tsc --project tsconfig.catalog.json`.
- Syntax: all 11 added/changed JavaScript files passed `node --check`.
- Public export comparison: all 29 roll exports and seven delivery exports are preserved. Lifecycle compatibility exports reference the same extracted function objects.
- Cold imports, dependency review, and `git diff --check`: passed.
- All 16 relative Markdown links in the refactor documentation resolve.
- The eight original unrelated documents retain their SHA-256 hashes.

Implementation commits: `a07f99c` (shared dependencies), `89b1f52` (lifecycle operations), and `de4aa6b` (adapter imports). Each implementation commit passed its full suite, focused checks, catalog typecheck, and syntax/diff checks. Validation logs are ignored local `roll-lifecycle-*.log` files.

The approved design and plan were recorded before production extraction. Final review confirmed only intended feature, compatibility/adapter, test/typecheck, and stage documentation paths changed. No schema or dependency files changed.

## Limits

Validation uses synthetic SQLite fixtures and fake Discord transport from existing tests. No production database, Discord login, push, PR, merge, or deployment was performed. Existing delivery acknowledgement/retry semantics are preserved; this refactor adds no exactly-once transport guarantee.
