# Roll publication, claims, and closure: implementation plan

Date: 2026-11-11. Baseline: `dc7c8b1` (merged PR #46).
Status: user-approved plan; self-reviewed before production edits.

## Preparation

Preserve existing branches, the two Stage 3 documentation changes, and eight unrelated untracked documents. Fetch and inspect incoming-path collisions; stash only the Stage 3 docs, fast-forward main, create `refactor/roll-lifecycle`, restore and verify docs, and remove the task stash. Establish full-suite and catalog-typecheck baselines using Node v22.23.2 and installed dependencies. Report unexpected failures before production edits.

## Commit 1: isolate roll lifecycle dependencies

Use Simple TDD at approved public seams: one failing behavior test, minimal extraction, then regression checks. Add shared snapshot schema/row reads in the lifecycle repository. Extract durable snapshot loading, mystery-session lookup and transaction-neutral terminal settlement, and synchronous delivery capture/window validation. Preserve original exports. Reservation imports capture directly; mystery orchestration and Discord transport stay in place. Verify snapshots, settlement, capture rollback, compatibility, and dependency direction.

## Commit 2: extract roll lifecycle operations

Move publication, failure, claims, escape refresh, lookup, notice, and reportability into the lifecycle service. Move their concrete SQL into the lifecycle repository, including conditional writes, scoped mystery-state reads, and legacy Double Date initialization. Reuse allowance and ownership/affection/item helpers. Preserve exported contracts, validation order, clocks, results, transaction wrappers, resource precedence, and ordinary expiry behavior. Keep compatibility exports and leave reservation, mystery progression, recovery, cleanup, and feedback lookup in their existing module. Verify real SQLite behavior and outer-transaction rollback.

## Commit 3: connect roll lifecycle adapters

Change lifecycle/snapshot imports in the runtime and delivery adapter without changing handler bodies or acknowledgement/transport ordering. Include new modules and focused service/transaction tests in catalog typechecking. Verify publication, ownership changes, repeated/competing claims, exact protection/expiry boundaries, reclaim/escape transfer, resource precedence, rollback, mystery integration, durable acknowledgement, and legacy/final-schema compatibility. Keep each commit passing with focused regressions, catalog typecheck, syntax checks, and a full suite before committing.

## Commit 4: record roll lifecycle verification

After all code changes, repeat full tests, catalog typecheck, syntax, import and diff review. Record actual baseline/final evidence in the validation doc and update the stage index. Validate links and preservation of unrelated documents. Commit only intended paths, then review final committed diff and working-tree state.

## Constraints and self-review

No schema, dependency, gameplay, unrelated type, Discord behavior, retention/recovery policy, or mystery-orchestration changes. No push, PR, merge, deployment, or live bot login. Report new failures or required scope expansion before changing the approach.

Self-approved: concrete existing seams, shared implementation moved once, compatibility and transaction ownership preserved, behavior/rollback tests at approved interfaces, and final validation after all production edits. The user explicitly authorized separate commits.
