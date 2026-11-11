# Bot structure: validation record

Date: 2026-11-11. Baseline: `cc546f0`.

## Initial environment and baseline

- Reused an existing Node v22.23.2 executable, matching the project pin. The host default is Node v24.19.0.
- The assessment worktree's lockfile matches the existing feature checkout. A local ignored node_modules junction reuses those installed dependencies.
- Catalog typechecking passed before production edits.
- The sandbox blocked test subprocesses with `spawn EPERM`. Running the baseline outside the sandbox completed: 1,825 tests, 932 passed, 893 failed.
- The baseline suite was launched before the registry module was added. Existing production files were unchanged.
- Failures include SQLite `database or disk is full`, `disk I/O error`, and `cannot rollback - no transaction is active` during fixture initialization or writes.
- A focused unchanged characterTrade suite reproduced the failures.
- Inspection found C: had zero free bytes. The default test temporary directory is on C:. D: had approximately 226 GB free.
- Implementation paused and the user was asked to choose between isolated test TEMP/TMP paths on D: and freeing C: first. No system settings or unrelated files were changed.
- The user freed space on C:. The baseline rerun then passed: 1,826 passed, one skipped, zero failures (including the new standalone registry test). Test temporary-directory settings remained unchanged.

## First Simple TDD cycle

- Added test/commandRegistry.test.js at the approved command-resolution seam.
- Red: the new module import failed with ERR_MODULE_NOT_FOUND.
- Green: the focused test passed after adding app/commandRegistry.js, covering aliases, modifier resolution, distinction from legacy/unknown commands, module loading, and original token preservation.
- This first cycle preceded wiring the registry into production routing.

## Implementation and further TDD cycles

- Event-routing tests first failed on missing extracted modules, then passed after extraction. They cover readiness, early game dispatch bypassing landmines, and retired controls.
- Session cancellation tests first failed on the missing session module, then passed after extraction. Preparation preserves the live offer and reservation; only invoking the post-commit callback cancels the exact marriage identity. Repeated invocation is harmless.
- All 22 focused trade tests passed after extraction, including gift/trade settlement, participant restrictions, fuzzy and ambiguous selection, picker supersession, and cancellation.
- Bootstrap and recovery tests now invoke executable functions instead of extracting JavaScript source fragments. They preserve login, restart rejection, readiness ordering, periodic overlap/failure guards, heartbeat aggregation, and utility registration coverage. Expired-control tests also prove a live collector acknowledgement suppresses the fallback reply.
- Trading command tests use the root compatibility commands and feature-level answer handler together, exercising their shared session store. The UUID source guard also inspects the moved implementation.

## Resulting structure

- `index.js` is a four-line executable wrapper. `app/bootstrap.js` constructs dependencies and coordinates startup.
- `app/events` owns message, interaction, and reaction handling. `commandRegistry`, `utilityCommands`, and `recoveryWorker` own their named responsibilities.
- Landmine and voice-ping behavior moved into feature modules without redesigning their gameplay or schedules.
- `features/trade` owns the concrete repository, transactional service, live sessions, Components V2 presentation, and Discord conversation runtime.
- Existing command paths and `lib/characterTrade.js` / `lib/tradeRuntime.js` remain compatible.
- Ownership-triggered cancellation imports sessions directly, avoiding a dependency on the Discord runtime. Discord handles and timers remain runtime-owned.
- No package, lockfile, database schema, deployment script, or other feature implementation changed.

## Verification and scope decision

- The complete post-extraction suite passed: 1,830 passed, one skipped, zero failures.
- Catalog typechecking passes, including all extracted trade modules.
- Adding app adapters to the catalog typecheck graph exposed previously unchecked errors in unrelated inventory/item/catalog modules. The user explicitly chose to retain the focused scope. App adapters receive Node syntax checks and behavior/integration tests; this work does not claim full application static type coverage.
- Node syntax checks passed for every new app and feature module.
- Diff review checked import direction, compatibility exports, command precedence, transaction ownership, session invalidation, and startup/recovery ordering.
- The final full-suite run after formatting and compatibility-test cleanup also passed: 1,831 tests reported, 1,830 passed, one skipped, zero failures, using Node v22.23.2. Evidence: local ignored `refactor-tests-final.log`.

Framework phases 3 through 6 are complete. The implementation plan was self-approved before implementation, the extraction seams received red/green checks, and final verification passed within the user-approved scope.

## Pre-commit verification

The final checkout on `refactor/bot-bootstrap-trading` passed another complete run on Node v22.23.2: 1,829 passed, one skipped, zero failures (`pr-tests.log`). The earlier standalone command-registry smoke-test file is absent from this checkout; the production event-routing test remains. Catalog/trade typechecking and staged diff checks also passed.

Verification used no live bot login, production database access, or deployment.
