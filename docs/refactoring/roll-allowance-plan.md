# Roll allowances and cooldowns: implementation plan

Date: 2026-11-11. Baseline: `79995d1`.
Status: user-approved plan; self-reviewed before production edits.

## Preparation

Preserve the existing feature branch and eight untracked documents. Check for incoming-path collisions, fetch and fast-forward `main` in `.idea`, then create `refactor/roll-allowances`. Establish the test/typecheck baseline on Node v22.23.2 with existing dependencies.

## Commit 1: extract roll allowance operations

Add a failing behavior test importing the new service. Extract the existing public allowance operations and shared calculations into the service and move their SQL into the concrete repository. Re-export public functions from the old module and import shared helpers for existing lifecycle callers. Preserve function signatures, defaults, results, error messages, and arithmetic. Add feature modules and service tests to catalog typechecking.

Characterize reset boundaries, unusual offsets, legacy daily eligibility, read-only normal/token eligibility, global adjustments, and compatibility between service operations and lifecycle usage. Run focused regressions, typechecking, and the full suite before committing this slice.

## Commit 2: delegate roll allowance storage

Establish lifecycle rollback/refund regression coverage before editing those call sites. Add transaction-neutral repository functions for refunds and successful claims. Route reservation/debit/refund/claim SQL through the repository at its current execution points. Keep branch decisions and resource-selection order unchanged. Point the four relevant Discord commands at the service and retain their current parsing and messages.

Verify real roll/claim transactions, injected SQLite failures, duplicate invocations, buff spending/refund order, ownership rollback, and command behavior. Run focused checks, typechecking, syntax checks, and the full suite before committing this slice.

## Commit 3: record verification

Commit the approved design, implementation plan, and validation evidence. Check the resulting diff and confirm that only intended files are committed and the eight original untracked documents remain untouched.

## Stop conditions and exclusions

Report unexpected baseline failures or new behavior risks before expanding the scope. Do not change schemas, dependencies, other feature internals, or unrelated type errors. Do not push, open a PR, merge, or deploy.

## Self-review

Self-approved: the sequence matches the accepted plan, the seams were approved in advance, each implementation commit has its own verification, and the final state remains compatible with existing callers.
