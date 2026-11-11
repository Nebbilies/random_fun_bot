# Bot structure: implementation plan

Date: 2026-11-11. Baseline: `cc546f0`.
Framework phase: 3. Design approved by the user.

## Agreed verification seams

The approved design defines the test seams: executable event handlers and startup ordering, command resolution/dispatch, real SQLite transfer settlement, and live-session cancellation. Tests preserve behavior at these seams rather than source layout.

## Sequence and file changes

1. Establish the existing test and catalog typecheck baseline using Node v22.23.2. Reuse the unchanged lockfile's installed dependencies through a local node_modules junction. Do not run the executable bot.
2. Add a failing test for command resolution that preserves aliases, modifier tokens, and early versus legacy dispatch. Extract `app/commandRegistry.js`, keeping lazy prefix imports and existing root command paths. Prove that slice before continuing.
3. Extract `features/landmine/landmineMessageHandler.js` and `features/voicePing/voicePingRuntime.js` mechanically. Extract message, interaction, and reaction event handlers under `app/events/`. Preserve branch order and readiness checks. Add behavior tests for dispatch precedence and expired/retired controls before making each interface available.
4. Extract periodic recovery into `app/recoveryWorker.js`, utility loading/registration into `app/utilityCommands.js`, and composition into `app/bootstrap.js`. Keep `index.js` as the executable wrapper exporting yoshiko. Remove its unused checkTimeouts import. Replace source-slicing tests in botBootstrap/recoveryBootstrapIntegration with executable tests covering the same failure and ordering conditions.
5. Extract concrete SQLite reads/writes from characterTrade into `features/trade/tradeRepository.js`; move transfer validation and synchronous atomic settlement into `tradeService.js`. Preserve refusal rollback, ownership clock, result shapes, and shared availability helpers. Keep `lib/characterTrade.js` as compatibility exports. Run transfer/history/schema tests.
6. Extract authoritative session lookup, identity, picker generations, and termination into `tradeSessions.js`. Add a failing post-commit/rollback cancellation test first. Move runtime-only handles and notification behavior behind the session termination seam. Point characterInteractionCancellation at sessions, preserving synchronous post-commit invalidation and best-effort UI updates.
7. Extract payload construction into `tradePresentation.js` and Discord conversation adaptation into the feature's `tradeRuntime.js`. Keep `lib/tradeRuntime.js` compatibility exports and existing command entry points. Prove both import paths share one session implementation. Preserve collector scopes, snapshots of settings, stale controls, timeouts, and exact character identities.
8. Update tsconfig.catalog.json for new modules. Run focused tests after each slice, then the full suite, catalog typecheck, and diff checks. Record results in docs/refactoring/bot-structure-validation.md. Stop on newly discovered bugs or behavior risks requiring user decisions.

## Simple TDD

For each extraction seam, write one meaningful failing behavior test, run it to establish red, implement the smallest extraction that satisfies it, and run the relevant existing tests. Existing integration tests remain the main proof of preserved gameplay. Do not bulk-create speculative tests or weaken assertions to make file moves pass.

## Completion and exclusions

Complete when bootstrap/routing and trading match the approved responsibility split, compatibility paths remain valid, and verification passes. No dependency upgrades, schema changes, other-feature redesign, live login, deployment, or commits.

## Self-review

Self-approved: this plan matches the approved scope, orders work by testable extraction seams, preserves public imports and critical ordering, reuses existing modules, and includes baseline/final verification. The user-approved framework permits proceeding to Simple TDD and implementation after this self-review.
