# Bot structure: brainstorm

Date: 2026-11-11
Baseline: `cc546f0` on `main`.
Framework phase: 1 (Brainstorm).
Scope decision: the user selected routing/bootstrap plus trading first.

## Objective

Make startup and command dispatch understandable independently of game implementation. Use trading and gifting as the first feature with explicit command, workflow, persistence, presentation, and live-session responsibilities.

Success means a maintainer can find where a command is routed, where a transfer is validated, where ownership is written, and where a Discord card is built without reading an entire runtime file.

## Current evidence

- `index.js` creates the Discord client and catalog, validates restart readiness, registers events, runs ordered recovery, starts periodic work, routes prefix and utility commands, and implements landmine and voice-channel behavior.
- Prefix routing has two stages. Character-game commands run before mystery/trade answers and landmines. Other prefix commands run after landmines. A registry must preserve that ordering.
- Marriage, franchise, and leaderboard command modifiers are meaningful input. Resolving a handler must preserve the original command token in `args[0]`.
- Utility slash commands load at startup and register on both ClientReady and GuildCreate. Character-game commands must remain prefix commands.
- `commands/trade.js`, `me.js`, `give.js`, and `cancel.js` already delegate to `lib/tradeRuntime.js`.
- `lib/characterTrade.js` combines SQL, validation, atomic transfer operations, and ownership-clock handling.
- `lib/tradeRuntime.js` combines live sessions, timers, Discord collectors, payload construction, user lookup, character selection, and workflow.
- `lib/characterInteractionCancellation.js` imports the Discord-dependent trade runtime to prepare post-commit cancellation.
- `lib/checkTimeouts.js` imports `index.js`; `index.js` imports it even though its invocation is commented out. This creates an unnecessary entry-point import cycle.
- Bootstrap/recovery tests extract source fragments from `index.js`. Those assertions must become tests of the extracted functions, preserving the original regression coverage.
- Trading already has real SQLite tests and simulated Discord interactions. Existing tests cover aliases, permissions, ambiguous names, fuzzy-name acceptance, obsolete pickers, ownership protections, and schema compatibility.

## Constraints and edge cases

### Startup and routing

1. Final-schema restart validation runs before event handlers, timers, recovery writes, or login.
2. Runtime detachment precedes normal ingress. Startup recovery completes before cache preparation and readiness.
3. Message, reaction, and interaction handlers remain inactive until game readiness.
4. Periodic recovery stays non-overlapping, releases its guard after failure, and preserves reporting totals and timing.
5. Collector-owned controls retain the delayed expired-response fallback; the global handler must not race a live collector into a second reply.
6. Retired reward controls retain their removal notice and cannot settle rewards.
7. Bots, DMs, unknown commands, aliases, command modifiers, guild prefixes, and maintenance draining keep their current routing semantics.
8. Extracted relative imports resolve from their new module locations. Existing data paths, database defaults, and the `node index.js` entry point remain valid.
9. Legacy voice-channel and landmine behavior is moved intact. Its redesign is outside this scope.

### Trading and gifting

1. Keep one pending transfer per participating user within a guild and one per channel.
2. Preserve the expected participant at each step and the final confirmer for each transfer kind.
3. Character IDs remain opaque; legacy numbers and final-schema UUID strings must not be coerced into each other.
4. Revalidate ownership, exact marriage identity, permanent locks, escapes, and other reservations at settlement.
5. Both sides of a swap commit together, including ownership-clock/history effects and crown invalidation.
6. Preserve the current ordering that releases the session's own pending reservation before settlement; otherwise the transfer can block itself.
7. Stale pickers and confirmations cannot act on ended or superseded sessions, including after an awaited Discord acknowledgement.
8. Transfer settings are captured at session creation; later guild configuration changes do not change a live session's terms.
9. Live sessions remain process-local and disappear on restart. No new persistence or recovery contract is introduced.
10. Ownership-triggered cancellation snapshots exact identities during the transaction, changes sessions only after commit, and never sends Discord requests inside the transaction.
11. Failed Discord edits cannot reverse a committed transfer or re-enable canceled controls.

## Scope limits

This slice does not reorganize other feature internals, migrate all source into `src`, change the database schema, add dependencies, introduce sharding, persist trade conversations, change command text or gameplay, deploy, or commit changes.

## Decision record

The user chose routing/bootstrap plus trading as the first slice. Phase 2 compares organizational options within that scope. No production code has been changed.
