# Items Phase 2 — implementation plan

Status: self-reviewed and approved in conversation; implemented on `feat/items-phase-2` in focused commits. Final verification and review results are recorded in `items-phase-2-validation.md`. No live database or Discord operations performed.

Design authority: `docs/items-phase-2-design.md` and subsequent conversation. User requested this plan after the design checkpoint. Keep unrelated local work intact, including pre-existing glossary edits and item-expansion documents.

## 1. Fixed behavior

- Consolation Chit is Common, passive and defaults to one use. At a genuine mystery-event win resolution, if the winner has no available claim, atomically spend one usable Chit and determine one random item. Reveal the character before pinging the winner with the direct item reward. No vault opening, vault modifiers, unavailable-prize-only trigger, or later claim-window trigger.
- Claim availability includes a normal available claim, applicable cooldown reduction and usable existing bypass tokens. Checking availability must spend nothing. Double Date does not clear an existing cooldown.
- Chronicle of Return is Epic, defaults to one use, and creates fresh ownership after owner-only selection and confirmation. Eligibility uses that owner's latest recorded loss in this guild, within a captured configurable seven-day window. Reject owned, unpublished and busy/held characters. Leave normal claims, cooldowns and buffs untouched.
- Both are reward-eligible by default; charges/eligibility and balancing settings remain portal configurable. Chronicle descriptions reflect the live configured history period, whereas an existing confirmation retains its captured period.
- Item-list changelog becomes a top-level TextDisplay above the catalog container, using a `###` heading, implementation-date release entry and independently discovery-masked Common/Epic names.

## 2. Engineering findings and decisions

### Chit activation boundary

`advanceMysteryEvent()` in `lib/mysteryCoordinator.js` funnels genuine outcomes into `lib/characterRolls.js::advanceMysterySession()`, which owns the transaction. Integrate Chit there, after existing expected-state/snapshot validation. Losing Doors can have a winner ID and enter countdown: require the explicit validated winner outcome, not a non-null ID alone.

Store a versioned resolution decision even when no Chit activates: claim available, no usable Chit, no reward pool, or activated reward identity. Recovery replays presentation, never re-evaluates eligibility or randomness. Legacy sessions without this decision retain their existing flow; do not retrospectively compensate already-resolved wins.

An activated Chit replaces the failed prize opportunity. Retain the character reveal but do not open a later claim window for that compensated event if claim availability changes during the reveal delay. Without an activation, preserve existing claim behavior except for the token-eligibility correction. Expiry or downtime cannot create another activation.

### Neutral reward delivery, not a compensation vault

Reuse `vault_rewards` inventory/overflow state and existing canonical-message recovery, but add explicit durable source provenance and a modifier-free in-transaction creation API. Do not call `revealVaultReward()` from a mystery transaction: it owns another transaction and invokes Double or Nothing, Lens and Recast behavior.

Add a small `reward_sources` sidecar with unique `(source_kind, source_id)` and a foreign key to the reward. Chit source IDs reference one mystery session; use a deterministic colon-free reward ID distinct from real vault IDs. Store immutable scope, spent inventory ID as historical evidence (not a live FK), selected outcome and captured balancing terms. Existing untyped vault rows remain compatible. Validate non-vault records explicitly; do not let malformed provenance silently fall back to vault policy.

Extract only inventory insertion/terminal overflow delivery into a private neutral helper. Ordinary vault resolution keeps its existing modifier sequence. Direct rewards and their overflow retries never invoke modifiers.

### Complete history at the SQL ownership boundary

Add a latest-loss relation keyed by `(guild_id, former_owner_id, character_id)`, storing a safe integer millisecond timestamp, with a picker index by guild/owner/time. Reference retained `character_identities`, not published `characters`. No backfill and no window-based deletion: an increased configured window can expose older recorded losses.

Use AFTER DELETE and ownership-identity-changing AFTER UPDATE triggers on `marriages`. Do not track INSERT or timestamp-only updates. Upsert the maximum loss time so older delayed operations cannot move history backward. Triggers cover gifts, trades, thefts and private item SQL as well as public divorce helpers, and roll back with failed ownership changes.

To honor existing injected operation clocks, use a single-row SQL clock context with a scoped synchronous helper and SQL millisecond wall-clock fallback. The scope validates `now`, joins an existing write transaction or owns one only if necessary, restores nested contexts and never awaits. SQLite writer serialization prevents cross-connection clock leakage. Startup rejects an unexplained committed clock override rather than silently clearing it. Raw administrative SQL still records losses using fallback wall time.

This is preferable to a JS-only hook that can miss direct writers, or a registered SQL JS function required on every tool connection. Track latest losses only, not a new general audit ledger.

### Additive schema rollout

Keep final catalog version 12 and use explicit extension markers, following the existing bounded Fortune/expiry upgrade pattern. Extend the shared first-start writable upgrade boundary, not a lazy runtime initializer. Recognize exact supported predecessor schemas; apply history/provenance additions under `BEGIN IMMEDIATE`, recheck under lock and validate before commit. Fresh creation and supported offline conversion must produce the same schema. Unknown or partial schemas fail closed. Read-only opens never migrate.

## 3. Ordered vertical slices and file changes

### Slice 0 — baseline and fixtures

- Capture `git status` and preserve unrelated changes.
- Read current tests/fixtures, run focused item, config, mystery, ownership, vault and startup baselines; record existing failures.
- Use temporary/in-memory databases only. Never start the bot, contact live Discord or migrate a real database.
- Use existing `node:test`, `node:sqlite` and Discord builders; no new dependency.

### Slice 1 — shared claim eligibility

Files: `lib/characterRolls.js`, `test/mysteryRolls.test.js`, relevant allowance/claim tests.

- Add a read-only shared claim-availability helper while preserving the existing public cooldown-status API unless audited callers require otherwise.
- Account for both Crown and Pinata bypass tokens and applicable Ring cooldown behavior.
- Use it for Chit resolution, `openMysteryClaim()` and the normal claim rejection condition. Preserve successful claim consumption ordering.
- Red/green tests: active cooldown with/without each token; normal available claim; Ring; Double Date during an existing cooldown; no eligibility-check writes.

### Slice 2 — authoritative persistence and upgrades

New focused modules: `lib/ownershipHistorySchema.js`, `lib/itemRewardSourceSchema.js` (names may align with existing naming, responsibilities fixed).

Existing files:
- `lib/catalogFinalSchema.js`: authoritative DDL, exact predecessor models/detectors, final validation and rebuild support.
- `lib/vaultFortuneUpgrade.js`, `lib/catalogDb.js`: ordered bounded additive upgrade on writable open, rollback-only diagnostic support, repeated/concurrent open safety.
- `lib/catalogRuntimeSchema.js` / `lib/catalogReleaseSchema.js`: update only where their actual creation/conversion responsibilities require the new fragments.
- `lib/characterIdentityMigration.js`: prepare empty extension relations before final rebuild expects their column layouts; install loss triggers after copying retained marriages.
- `lib/catalogRuntimeRecovery.js`: supported provenance, loss-context invariants and recovery obligations.

Install empty history and source metadata, constraints, indexes, markers and clock context. Existing marriages must not create historical losses during install or conversion. Keep legacy integer-identity schema acceptance unchanged; Chronicle requires supported final history storage rather than pretending legacy storage is complete.

Critical tests: fresh schema; current pre-Phase-2 final schema; supported pre-Fortune/pre-expiry chain; dry-run rollback; idempotent and concurrent startup; unknown/partial schema refusal; read-only diagnostics; retained/unpublished marriages survive conversion and produce zero backfilled history.

### Slice 3 — ownership loss tracking end to end

New: `lib/characterOwnershipHistory.js` for scoped operation clock, latest-loss lookup and eligible-history query.

Clock integration audit:
- `lib/characterMarriage.js`: optional operation time for divorce and fresh marriage creation without breaking existing callers.
- `commands/divorce.js`: pass confirmed operation time.
- `lib/characterTrade.js`: transfer/swap mutation callbacks.
- `lib/items/masterKey.js`, `lib/items/pickpocketsHook.js`: direct theft writes, including Crown substitutions.
- `lib/items/bloodPact.js`: pass operation time into sacrifices.
- `lib/characterRolls.js`: successful escape takeover, not current-owner reclaim.
- `lib/itemActions.js`: action activation and Hostage settlement clock scopes, covering Kaimetsu, Chaos, forced divorce, Hostage and Masquerade.
- `lib/itemActivation.js`: scope legacy effect mutation transaction where needed so direct item execution and dispatcher paths are both correct without transaction nesting.

Trigger tests cover raw DELETE/UPDATE, old/new guild/owner/identity scoping, repeated losses, unchanged-owner timestamps, rollback, nested clock restoration and fallback SQL writes. API regressions cover every production loss path above and the no-loss cases (escape attempt, expiry, whistle reclaim). Retain history through unpublication/republication and rank changes.

### Slice 4 — item catalog, portal settings and descriptions

New item definitions: `lib/items/consolationChit.js`, `lib/items/chronicleOfReturn.js`; register in `lib/items/index.js`.

- `lib/gameConfigSchema.js`: IDs/tier membership, one-charge/reward-eligible defaults; `itemEffects.consolation_chit.tierWeights` = 69.9/17.5/10/2.5/0.1; `itemEffects.chronicle_of_return.historyWindowMs` = 604800000. Validate finite nonnegative weights, positive total eligible pool, positive bounded safe-integer window via existing registry conventions. Empty individual Chit tiers are valid; existing vault validation remains unchanged.
- `lib/itemRuntimeConfig.js`: effect defaults/resolved settings consistent with config.
- `lib/itemRoster.js`: live Chronicle period description, passive Chit description, one-config-snapshot definition resolution. Validate both injected random draws when reusing weighted selection.
- `lib/itemActivation.js`: manual Chit use explains passive behavior and spends nothing; Chronicle routes through durable actions, not generic decrement.
- `web/reviewConfig.js`, `web/assets/reviewConfig.js`, `web/reviewConfig.html`: verify registry-driven portal exposure; edit only any actual label/group/formatting gaps. Do not add duplicate hardcoded settings UI unnecessarily.
- `docs/game-config-contract.md`: paths, defaults, limits, inheritance/reset and activation-time capture semantics.

Test descriptions after portal changes, inherited guild/global settings/reset conflicts, empty tiers, all-empty rejection, rarity membership, reward eligibility and configured charges. Do not freeze tunable default values into unrelated behavior tests.

### Slice 5 — modifier-free direct rewards and passive Chit

New: `lib/mysteryConsolation.js` with caller-transaction-owned activation and scope-safe read/inspection helpers.

- `lib/vaultRewards.js`: source-neutral `createDirectItemRewardInTransaction()`; extract minimal insertion/delivery helper; validate duplicates against immutable scope; preserve existing public transaction ownership.
- `lib/characterRolls.js::advanceMysterySession()`: atomically commit validated win, Chit decision, usable source debit, selected reward/source linkage, direct insertion or durable overflow and existing puzzle-win recording. Pass existing randomness through; capture trigger-time configuration rather than reservation-time mystery configuration.
- Select one usable non-expired/non-escrowed Chit. Spending it may free the slot needed by the reward. A newly awarded Chit does not recursively activate.
- Store enough resolved reward terms to preserve the determined item/charges across config edits and overflow retries. Keep existing acquisition-time inventory expiry policy.
- Do not activate from `openMysteryClaim()`, claim reactions, terminal cleanup or presentation recovery.
- `lib/legacyVaultAbandonment.js`, `lib/vaultSessions.js`, `lib/vaultRuntime.js`: discriminate validated non-vault sources where same-ID/null-source-message heuristics assume a real vault. No fake vault session and no collision with real IDs.

Tests: each genuine event win versus wrong Doors/no winner; resolution-time eligibility changing before reveal; no Chit/no pool; expiry/escrow; spent-on-roll; overflow decline/accept/replace; random draw/config snapshot stability; simultaneous/repeated resolution; injected SQL failure rolls back win/cost/reward together; armed Recast/Lens/Double or Nothing untouched.

### Slice 6 — character reveal, winner ping and recovery

- `lib/mysteryRuntime.js`: unified reveal acknowledgement for Doors and other winners; retain durable canonical character-message identity before permitting reward publication. Compensated wins show the character as unclaimable and do not open a replacement claim opportunity.
- Persist reveal progress even when the session becomes terminal; current active-only `persistRuntime()` is insufficient on its own.
- Extend recovery inspection/scans to terminal sessions with an outstanding Chit reveal obligation. Recover the reveal before the reward, never rerun activation. Preserve saved character snapshots if the live catalog changes.
- `lib/vaultRuntime.js`: source-aware direct reward rendering, queue/canonical binding reuse and publication gate. Initial Chit message intentionally mentions only the winner via explicit `allowedMentions.users`; edits/normal vault messages stay non-pinging. Overflow wording says recipient/winner, not roller. No vault buttons/modifiers.
- `lib/catalogRuntimeRecovery.js`: validate genuine-winner source linkage, reward/state/provenance, reveal acknowledgement and recoverable terminal obligations; corrupt paid state blocks rather than rerolls.
- `index.js`: wire required recovery/interaction helpers into existing startup and bounded periodic recovery, maintaining reveal-before-reward ordering. Reuse existing reward overflow routing where possible.

Failure tests: before/after character send and acknowledgement; before/after session terminalization; reward send success/ack loss; definitive deletion versus transient fetch failure; reopen with completed mystery but pending reward; unauthorized/cross-guild/channel/message overflow controls. Assert message ordering and allowed mentions, not just reward content.

### Slice 7 — Chronicle selector and atomic return

- `lib/itemActions.js`: add action kind; capture history window at creation and preserve it through selection updates; implement confirmation branch before generic currently-owned target handling.
- `lib/itemActionRuntime.js`: dedicated paginated formerly-owned selector and return preview, readiness check and kind-specific selection verb. Server-side lookup validates submitted stable IDs. Reuse source holds, canonical bindings, cancel/expiry, terminal delivery and recovery. No eligible targets ends without cost and releases the source.
- Eligibility query requires `0 <= now - latestLoss <= capturedWindowMs` (inclusive boundary), current catalog presence, no current marriage and both `isCharacterBusy()` and `isCharacterHeld()` rejection. Picker and confirmation share eligibility predicates; confirmation is authoritative.
- Inside the existing action transaction: revalidate scope/deadline/held source/latest loss/availability; create new marriage with confirmation time; consume exactly one reserved use; save result. Any failure rolls back all effects. Retain the loss row; a later real loss updates it.
- `lib/itemCharacterPresentation.js`, `lib/itemCharacterReveal.js`: reuse existing fresh ownership result cards; add only any required Chronicle mapping.
- `lib/characterIdentitySnapshots.js`, `lib/characterMigrationSettlement.js`, relevant migration payload validation: explicitly recognize the supported new action shape where necessary, retaining old-format validation rather than loosening allowlists globally.

Tests: same guild and former owner only; initial no-history case; deployment-existing ownership lost afterward; every loss reason; latest-loss replacement; exact window/future time; config changes after confirmation creation; no rank cap; archived/owned/held/busy targets; empty picker/cancel/timeout/stale/forged controls; inventory source expiry/escrow; concurrent returns; unique fresh marriage/date; unchanged claims/tokens/Ring/Double Date; durable result after reopen and failed announcement.

### Slice 8 — changelog and documentation

- `lib/itemReleases.js`: add latest release with `consolation_chit` and `chronicle_of_return`, using actual implementation date, not attachment date. Format `### Changelog — DD/MM/YYYY` then one Common and one Epic clause with guild-masked names.
- `lib/itemList.js`: return top-level changelog TextDisplay before the catalog container. Preserve filter/navigation controls and disabled rendering.
- `commands/itemlist.js`: retain shared text budget including heading/newlines and refresh discovery/config on render.
- Tests: `test/itemReleases.test.js`, `test/itemList.test.js`, command coverage for initial send/navigation/filter/expiry, both/one/neither discovered, mixed rarities and long-budget cases.
- Update `docs/item-release-changelog.md`, `docs/character-marriage-design.md`, `docs/character-marriage.md` to explain post-introduction latest-loss records without claiming old marriage restoration or retroactive history.
- Update design/plan status only when actually implemented/verified; add rollout and validation notes. Glossary already distinguishes Chronicle return from escape reclaim.

## 4. Test strategy and execution

Use vertical red-green development: first a failing test at each existing public service boundary, implement the smallest supported slice, rerun, then expand. Avoid bulk tests against imagined private APIs.

Primary existing suites to extend/protect:
- Claim/mystery: `mysteryRolls`, `mysteryCoordinator`, `mysteryRuntime`, `mysteryRuntimeRecovery`, `mysteryPublishedTerms`, `mysterySnapshotIntegrity`, competitive/Doors/Treasure Hunt tests.
- Ownership/actions: `characterMarriage`, `characterTrade`, `characterEscapes`, `itemActions`, `kaimetsuAtomic`, `itemActionRuntime`, `itemActivation`, `itemExpiryConsumers`.
- Rewards: `itemStorage`, `vaultRewards`, `vaultRuntime`, `vaultSessionRecovery`, `migrationOverflowRetention`, Fortune and legacy-abandonment tests.
- Config/catalog: `gameConfig`, `gameConfigRuntime`, `configPortal`, `itemRuntimeConfig`, `itemDescriptions`, `itemRoster`, item list/release tests.
- Schema/restart: `finalCatalogStartup`, `fortuneUpgrade`, `catalogRuntimeRestart`, `runtimeRestartSafety`, offline conversion fixtures.

Add focused `characterOwnershipHistory`, `mysteryConsolation` and Phase 2 upgrade tests where existing suites lack a seam. Use real temporary SQLite for atomicity, constraints and file reopen; fake Discord transport for ordering, ping authorization and uncertain delivery. Do not assert statistical percentages with flaky sampling; inject draws and assert weighted boundaries/empty-tier normalization.

Run focused suites after each slice, then `npm test` and `npm run typecheck:catalog`. Use background terminals for long runs. Record baseline failures separately, repeat affected tests after fixes, and review the final diff for unaccounted direct ownership/inventory writers and schema snapshots.

## 5. Risks, safeguards and rollout

- Discovered bug: mystery claim publication currently ignores usable claim tokens. Fix through shared eligibility with consumption regressions, not by changing cooldown semantics globally.
- Exactly-once gameplay is achievable through saved transaction results; exactly-once Discord delivery/pings is not guaranteed across arbitrarily delayed send-success/ack-loss. Reuse nonce/canonical-message recovery and never duplicate awards, costs or draws.
- SQL clock context must never leak across operations. Require idle startup state, safe nested restoration and rollback tests. No async callback inside the scope.
- Additive history begins at deployment; no older losses can qualify. Do not install triggers before conversion copies/rebuilds that could manufacture losses.
- Existing exact schema validators mean old binaries may reject the upgraded schema. An operational rollback should use a compatible build with items disabled while preserving loss tracking; do not drop real history as an automatic downgrade.
- No live migration during development. Normal writable startup performs only the reviewed recognized additive upgrade; read-only tools report that writable startup is needed. Preserve unknown schemas for investigation rather than repairing them.
- If implementation reveals an unsupported paid state, unsafe migration, previously unknown data-loss path or material behavior degradation, stop that slice and report it rather than silently broadening scope.

## 6. Plan self-review and approval boundary

Self-reviewed against the approved design, all interview amendments, current source and two read-only integration investigations. Corrected the initial survey's too-late claim-publication activation seam to the authoritative genuine-win transaction. Accounted for losing Doors winner IDs, extra claim tokens, compensated-event terminal behavior, nested transactions, Chit-only odds, source ambiguity, terminal mystery recovery, complete direct-SQL loss writers, deterministic clocks, retained identities, conversion trigger ordering, dynamic versus captured settings, discovery masking and Components V2 text budgets.

No Phase 3 behavior or new dependency. Reuses existing actions/overflow/recovery rather than a general item engine or second compensation vault. No further product grilling is required. Approval authorizes test-first implementation of this plan, followed by verification; it does not authorize commits, live bot actions or live database migration.
