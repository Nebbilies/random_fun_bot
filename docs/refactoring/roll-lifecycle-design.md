# Roll publication, claims, and closure: design proposal

Date: 2026-11-11.
Framework phase: 2 (Design Proposal).
Inspection baseline: local `4a701d6` on `refactor/roll-allowances` (Stage 2 / PR #46). This proposal does not assert that remote main has merged that PR.
Status: user-approved design; self-reviewed. Implementation baseline: `dc7c8b1` after PR #46 merged.

## Objective

Give roll publication, claiming, and terminal state transitions a cohesive home under `features/rolls/`. Preserve gameplay, exported contracts, SQLite transaction ownership, and Discord behavior. Stage 1 established feature-oriented responsibilities; Stage 2 extracted allowances. This stage makes the lifecycle use those allowance modules without depending on the legacy entry point.

Related documents: [architecture design](bot-structure-design.md), [allowance design](roll-allowance-design.md), and [allowance validation](roll-allowance-validation.md).

## Scope and meaning of closure

Included operations are `publishRoll`, `failRoll`, `claimRoll`, `claimRollInTransaction`, and `refreshEscapeRoll`, together with their roll lookup, snapshot validation, escape settlement, claim-notice, and reportability helpers. Closure means the existing transitions to terminal roll states, including reclaim, successful marriage, cancellation, failure, and escape expiry. Preserve closure of other open rolls for the same guild and character.

An ordinary claim returning `expired` does not currently close its stored row. Preserve that distinction: this extraction must not introduce a new expiry sweep or normalize all expiry paths.

Excluded work:

- Reservation, character selection, randomness ordering, prank/mystery/vault selection, and reservation debit/refund behavior.
- Mystery event progression, winner selection, claim-window publication, consolation decisions, and runtime orchestration.
- Discord cards, messages, reactions, reports, timers, reward delivery, and command parsing or response text.
- Restart orchestration and the policies/transaction contracts of `recoverRolls` and `cleanupRolls`, including retention and legacy-vault abandonment evidence.
- Schema changes, dependencies, new frameworks, unrelated type fixes, and gameplay changes.

Existing ownership, affection, item, and mystery integrations still execute at the same lifecycle points. Their implementation and reward policies are reused. Narrow shared helper moves described below are required dependency work, not a redesign of those features.

## Options and decision

| Option                                     | Benefit                                                           | Cost                                                               | Decision    |
| ------------------------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------ | ----------- |
| Extract publication, claims, and closure   | Cohesive state-transition rules; builds on allowance transactions | Requires small shared read/settlement seams                        | Recommended |
| Extract all roll lifecycle and reservation | Larger immediate reduction in the legacy file                     | Couples this stage to selection, buffs, mystery and vault branches | Defer       |
| Extract Discord presentation/runtime first | Improves navigation of rendering and handlers                     | Leaves lifecycle decisions and storage coupled                     | Defer       |

Use ordinary ES modules and existing concrete SQLite helpers. Avoid generic repositories, new classes, a dependency container, a configurable state-machine engine, or one file per function. The public interface remains the existing operations, IDs, options, results, and errors.

## Module responsibilities

Names below describe the proposed design. The implementation plan will enumerate exact edits after approval.

| Module                                      | Responsibility                                                                                                                                                                           |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `features/rolls/rollLifecycleService.js`    | Public publication, failure, claim, escape-refresh, lookup, notice, and reportability operations; validation, branch ordering, resource selection, and existing transaction entry points |
| `features/rolls/rollLifecycleRepository.js` | Concrete lifecycle row projections, conditional state writes, existence/schema reads, and notice persistence; no gameplay decisions or transaction control                               |
| `features/rolls/rollSnapshot.js`            | The existing durable roll/mystery snapshot loading and cross-validation operation, reused by lifecycle, mystery publication, and recovery                                                |
| `lib/mysterySessionState.js`                | Mechanical extraction of `getMysterySession` and the existing transaction-neutral `finishMystery` implementation so both lifecycle and the remaining mystery operations can reuse them   |
| `features/rolls/rollDeliveryCapture.js`     | Existing synchronous delivery capability check, captured-window validation, and reservation capture; no Discord imports or transport operations                                          |
| `lib/characterRolls.js`                     | Existing reservation, mystery orchestration, recovery and cleanup; compatibility exports for extracted public operations                                                                 |
| Existing runtime and delivery modules       | Existing Discord behavior; consume extracted operations without changing transport or acknowledgement ordering                                                                           |

The lifecycle repository owns SQL moved with lifecycle operations, including the existing legacy Double Date counter initialization. Allowance SQL continues to use the Stage 2 repository. Ownership and affection operations continue through their existing modules. Mystery-session lookup and terminal settlement retain their SQL in the narrowly extracted mystery helper; moving all mystery SQL into a new architecture is outside scope.

The snapshot module uses lifecycle repository reads, the shared mystery-session lookup, and existing character snapshot validation. It does not import `lib/characterRolls.js`. Move snapshot calculations once and preserve schema detection on each inspection; explicit upgrades can occur on an existing connection.

`getRollAffectionFeedback` can remain in the legacy module. Moving presentation-facing award lookup is unnecessary for this lifecycle seam.

## Dependency direction and minimal shared moves

The current import chain includes `characterRolls` importing `rollDelivery`, which imports `characterRollRuntime` and `characterRolls`. The reservation path needs only synchronous capture, not the transport graph. Point that import at `rollDeliveryCapture` and preserve the old delivery exports through re-exports. Share the existing window validator between capture and delivery loading rather than maintaining two copies. Keep acknowledgement, binding, nonce handling, sends, and retries in `lib/rollDelivery.js`.

The lifecycle module needs mystery terminal settlement and session reads. Importing those from the compatibility module would create a backward dependency. Extract the existing small helper cluster instead. Keep `publishMysteryIntro`, `advanceMysterySession`, `openMysteryClaim`, `endMysterySession`, and `cancelActiveMysteries` in their current module, importing the shared helper where required. The terminal helper does not begin a transaction or call the lifecycle service.

The intended direction is:

```text
Discord runtime / delivery adapters / compatibility exports
    lifecycle service
        lifecycle repository
        allowance service and repository
        snapshot validation and mystery-session state helpers
        existing ownership, affection, item, availability, and config modules

Existing reservation
    synchronous delivery capture
```

No new feature module imports the compatibility facade or Discord runtime. The mystery helper is a concrete synchronous dependency, not a callback registry. Existing runtime call sites may use the new lifecycle imports directly; other callers can retain compatibility imports. No additional command or runtime restructuring is required.

## Behavioral and transaction contracts

- Preserve exported names, parameters, defaults, validation order, error messages, result shapes, row aliases, and null/false outcomes. Preserve default clock behavior, including the existing internal `Date.now()` calls in `failRoll`; do not standardize clocks during extraction.
- `publishRoll`, `failRoll`, `claimRoll`, and `refreshEscapeRoll` retain their existing synchronous transaction wrappers. `claimRollInTransaction` remains transaction-neutral and requires the caller's active write transaction. Repository and shared state helpers never begin, commit, or roll back transactions.
- Continue using `BEGIN IMMEDIATE` through the existing transaction helper. Do not introduce async work into database transactions. Preserve the current behavior in which a returned refusal can commit intentional state changes; only thrown errors trigger rollback.
- Ownership changes, allowance/history writes, buff spending, claim-conservation decisions, roll closure, mystery settlement, and affection writes participate in the same connection and existing transaction. Reuse the ownership-operation clock around escape divorce exactly where it is currently applied.
- Preserve publication cancellation when a character becomes reserved or the original marriage changes. Complete or cancel captured affection at the same points and retain own-appearance closure behavior.
- Preserve captured deadlines and snapshots, legacy configuration fallbacks, exact `now < protectedUntil` and `now >= expiresAt` comparisons, and final-schema validation failures. Invalid snapshots must not silently become current catalog data.
- Preserve owner reclaim precedence, original marriage identity checks, availability checks, mystery-exclusive claim checks, and the current order of ownership and resource mutations.
- Preserve Double Date, Crown, token, then normal-claim resource precedence; legacy counter materialization; ring consumption conditions; and claim conservation. Reuse Stage 2 eligibility and cooldown calculations.
- Preserve duplicate/repeated invocation outcomes without adding a new idempotency scheme. A second claim must not repeat ownership changes, allowance writes, buff spending, or affection awards. Retain conditional SQL predicates and notice deduplication.
- Delivery acknowledgement remains committed before publication, so a publication failure cannot discard the durable message binding. This stage adds no exactly-once Discord guarantee and changes no retry policy.

## Verification design

Use Simple TDD at the public operation seams: one failing behavior test for an extracted import or missing behavioral contract, minimal extraction, then the relevant regressions. Use real SQLite fixtures with explicit times and deterministic randomness; avoid mocks of repository internals. Keep existing compatibility-path tests and add direct-path coverage.

| Area                            | Required evidence                                                                                                                                                                               |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Publication                     | Pending-only and repeated publication; captured versus legacy windows; own appearance; changed ownership/reservation; snapshot failure; rollback of state and affection writes                  |
| Claims and closure              | Normal success; repeated and competing claims; protected boundary and expiry boundary; reclaim and escape transfer; closure of other open cards; failure/repeated failure; notice deduplication |
| Resources and atomicity         | Existing allowance regressions plus injected failures after ownership/resource changes; rollback of buffs, usage/history, roll state, mystery settlement, and affection where enabled           |
| Caller-owned transactions       | Invoke `claimRollInTransaction` inside a real outer transaction and force its rollback; prove the module neither commits nor begins a nested transaction                                        |
| Mystery integration             | Exclusive winner checks and unchanged claimed/unavailable/failed terminal settlement, including affection reveal/cancellation flags                                                             |
| Delivery and compatibility      | Capture remains in reservation's transaction; legacy and final-schema fixtures; acknowledgement survives publication failure; old/new import paths; import smoke tests without bot startup      |
| Unchanged surrounding workflows | Existing reservation, commands, published terms, pending delivery, escape recovery, mystery, affection, and legacy-vault cleanup suites                                                         |

Relevant existing suites include `characterRolls`, `characterEscapes`, `rollAllowanceTransactions`, `itemBuffRolls`, `rollPublishedTerms`, `rollDeliveryPublishedTerms`, `forcedEscapePublishedTerms`, `soulmateReclaim`, `mysteryRolls`, `mysterySnapshotIntegrity`, `pendingRollRecovery`, and `escapeRuntimeRecovery`. Reuse their fixtures where useful without building a new generic fixture framework.

The implementation plan must establish a fresh full-suite/catalog-typecheck baseline before production edits, using Node v22.23.2 and existing dependencies. Finish with focused and full tests, catalog typechecking covering new modules/tests, syntax checks, import/diff review, and stage-specific validation evidence. No tests were run for this documentation-only proposal; prior Stage 2 results are not Stage 3 validation.

## Acceptance and review gate

The stage is complete when lifecycle decisions have one implementation, extracted lifecycle SQL has one owner, dependencies do not point back through the facade, compatibility imports remain usable, and SQLite regressions prove preserved state and transaction behavior. Reservation, mystery orchestration, retention/recovery policies, and Discord behavior remain in their existing homes.

The user approved this design, the implementation plan, and separate validated commits. No push, PR, merge, or deployment is included. Report newly discovered failures or required scope changes before expanding the work.

## Self-review

Self-approved as a design proposal and subsequently approved by the user. Checked against the inspected implementation:

- The extraction has a concrete caller benefit: publication and claims can be understood and exercised through one lifecycle interface.
- Each added helper addresses an existing shared dependency; there is no hypothetical alternate database or runtime abstraction.
- Snapshot validation, terminal mystery settlement, and delivery capture move without rewriting their policies.
- Closure is explicitly separated from retention and restart orchestration, keeping the stage focused.
- Transaction-neutral and transaction-owning entry points remain distinct; return values are not treated as automatic rollback signals.
- Verification covers both import paths and the risky ownership/resource/settlement ordering, rather than asserting file layout alone.
- No unresolved product decision is required to present this proposal. The user approved this proposal before phase 3 under the agreed engineering framework.
