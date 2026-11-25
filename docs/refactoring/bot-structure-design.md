# Bot structure: design proposal

Date: 2026-11-11
Baseline: `cc546f0` on `main`.
Framework phase: 2 (Design Proposal).
Status: self-reviewed; approved by the user on 2026-11-11.
Related context: [Brainstorm](bot-structure-brainstorm.md).

## Recommendation

Use feature folders with explicit responsibilities inside each feature. Extract application startup and event routing into `app/`. Introduce `features/trade/` as the first complete feature. Keep the root entry point, existing command paths, and existing library entry points compatible during this slice.

Use ordinary ES modules and functions. Each file should own a cohesive responsibility; there is no one-function-per-file rule, mandatory class hierarchy, generic repository, or dependency-injection framework.

## Options considered

| Option                                          | Benefit                                                             | Cost                                                                                       | Decision      |
| ----------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------- |
| Global commands/services/repositories folders   | Familiar layered structure                                          | One trade change spans distant folders; runtime and presentation still need explicit homes | Do not choose |
| Feature folders with internal responsibilities  | Related behavior stays together; dependency direction remains clear | Requires naming and import discipline                                                      | Recommended   |
| Adopt a bot framework and reorganize everything | Standardized command/listener infrastructure                        | Dependency migration and broader behavior risk exceed this slice                           | Defer         |

## Application modules

Conceptual structure; the implementation plan will specify exact file changes after approval:

```text
index.js
app/
  bootstrap.js
  commandRegistry.js
  utilityCommands.js
  recoveryWorker.js
  events/
    messageCreate.js
    interactionCreate.js
    messageReactionAdd.js
features/
  trade/
    tradeService.js
    tradeRepository.js
    tradeSessions.js
    tradePresentation.js
    tradeRuntime.js
  landmine/
    landmineMessageHandler.js
  voicePing/
    voicePingRuntime.js
commands/
  trade.js
  me.js
  give.js
  cancel.js
lib/
  characterTrade.js
  tradeRuntime.js
```

The landmine and voice-ping modules are mechanical extractions required to give bootstrap one purpose. They do not establish a broader redesign of those features.

`index.js` remains the executable entry point and retains the exported `yoshiko` value. `bootstrap.js` constructs dependencies, validates startup, registers handlers, and starts the client. Extracted handler modules do not log in, open a catalog, or install timers merely when imported.

Handlers accept the dependencies they use and a readiness accessor. Tests can invoke the same handlers registered in production, without importing the executable entry point or using a Discord token. Bootstrap accepts a small set of construction/start dependencies where necessary to test ordering; it does not become a general-purpose application container.

The command registry owns canonical handler resolution, aliases, modifier-family resolution, and the distinction between early game commands and later legacy commands. It retains the original input token and does not eagerly import every prefix command. Utility commands retain their current startup loading and guild registration behavior. Handler imports use module-relative URLs so extraction cannot redirect them to `app/commands`.

The message handler preserves the current sequence: readiness and message eligibility, early game dispatch with maintenance gating, non-prefix mystery answers, non-prefix trade answers, landmine handling, then legacy prefix dispatch. The interaction handler preserves current branch precedence, acknowledgement rules, and retired/expired control handling.

The recovery worker reuses `runGameRecovery` and the existing observer. Its interface exposes startup/periodic work at a testable seam; ordered recovery operations are not redesigned. Birthday scheduling and voice-ping startup retain their current position after game readiness. Utility registration remains a separate ClientReady listener and GuildCreate listener.

## Trading modules

| Module                 | Responsibility                                                                                                            | Exclusions                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Existing command files | Entry points for trade, me, give, cancel                                                                                  | SQL and payload construction                          |
| `tradeRuntime.js`      | Adapt Discord messages/interactions, drive the conversation, schedule timeouts, connect workflow results to responses     | SQL and component construction                        |
| `tradeService.js`      | Validate and settle transfers atomically; evaluate game conditions using existing availability helpers                    | Discord objects and presentation                      |
| `tradeRepository.js`   | Feature-specific ownership/protection/escape queries and ownership writes                                                 | Transaction ownership and game decisions              |
| `tradeSessions.js`     | Authoritative live-session identity, lookup, picker generations, ending sessions, exact-identity cancellation preparation | Discord imports, payload construction, SQL            |
| `tradePresentation.js` | Construct Components V2 payloads and response text from supplied data                                                     | Database access, collectors, timers, sending messages |

The existing `characterMarriage`, name search, ownership display, availability, configuration, and harem presentation modules remain shared dependencies. Their implementations are reused rather than duplicated into trading. Presentation receives already-projected character rows; it does not run ownership-display queries itself.

The runtime may pass the existing command context at the Discord entry point. Transfer settlement receives explicit IDs and timestamps and returns the existing result statuses. This keeps business operations usable from tests without constructing Discord messages.

The service owns the synchronous transaction and ownership-operation clock. Repository functions execute on that same connection and neither commit nor open nested top-level transactions. Preserve the current refusal-result rollback behavior; the generic `catalogDb.transaction` helper does not provide that behavior and must not replace it blindly.

Do not introduce an abstract repository interface for a hypothetical second database. The concrete SQLite module is sufficient. Keep integration tests against real SQLite as the primary proof of atomicity.

## Session and cancellation seam

The session module owns live identity and logical state. Discord channel/message handles and collectors belong to runtime-owned associations. Session termination invalidates logical state and releases pending-transfer availability synchronously. Timer cancellation and best-effort UI updates are connected through a narrowly scoped termination callback registered by the runtime; the callback does not define whether a session remains live.

`characterInteractionCancellation` imports cancellation preparation from the session module, removing its dependency on the Discord runtime. Preparation only captures matching session identities. The existing caller invokes the returned callback after commit, which ends those still-live sessions. Rollback leaves sessions and their controls live. The runtime callback schedules best-effort card edits after logical termination and must not throw into committed ownership handling.

Continue using the existing per-database pending-transfer availability registry. Do not add a second independently maintained reservation index. Preserve exact marriage identity matching and current cancellation text.

## Compatibility and incremental adoption

- `lib/characterTrade.js` and `lib/tradeRuntime.js` become compatibility re-exports of the new implementations. Production callers can migrate selectively while existing consumers retain their imports.
- There is exactly one session store and one implementation behind both old and new paths.
- Root command files remain discoverable. Canonical aliases can share handlers without changing modifier tokens or usage messages.
- Remove the unused bootstrap import of `checkTimeouts` to break its entry-point cycle; do not enable or redesign that inactive scheduler.
- Preserve database/file locations, config handling, startup observations, intents, partials, schedules, and `node index.js`.
- Cover the new modules in the existing JavaScript typecheck configuration.

## Verification design

Before production edits, record a baseline and add focused regression coverage for the extraction seams. Where the required module does not exist yet, the new test should fail for that missing seam before implementation.

Test the registered event functions directly with simulated Discord objects. Test startup readiness with deferred recovery and a fake client. Prove invalid restart state prevents registration/login/timers. Retain recovery overlap, failure release, reporting accumulation, utility-registration, retired-controls, and expired-controls assertions.

Test command resolution and routing precedence with game/legacy commands, aliases, modifiers, unknown input, maintenance state, and conversation replies. Preserve existing landmine/voice behavior through focused extraction checks rather than adding gameplay features.

Retain existing transfer integration tests and add focused proof for post-commit versus rollback cancellation, single session identity through compatibility exports, stale controls, and isolation from executable startup. Replace source-slicing assertions with behavior tests; do not weaken the original regression conditions by asserting only that a wrapper exists.

Final verification includes focused tests, the complete existing test suite, catalog typechecking, and a diff review for unintended gameplay, dependency, schema, and deployment changes. No live bot login, production database, deployment, or commit is required.

## Completion criteria

1. Startup, routing, recovery scheduling, and legacy incidental features have explicit owners outside the entry point.
2. Trading has explicit persistence, game-operation, presentation, and session responsibilities.
3. Lower-level transfer/cancellation modules do not import the executable entry point or Discord runtime.
4. Existing public import paths and observable behavior remain compatible.
5. Tests prove ordering, atomicity, session invalidation, and recovery behavior through executable interfaces.
6. No other feature internals are reorganized.

## Self-review

Self-approved for scope, coherence, and readiness for user review. The proposal reuses existing helpers and dependencies, preserves transaction and recovery contracts, accounts for bootstrap source-based tests and the inactive import cycle, and includes compatibility paths for incremental adoption. Implementation verification has not occurred.

User approval of this proposal is still required before phase 3 (Implementation Plan). That plan will receive its own self-review before the remaining approved framework phases proceed.
