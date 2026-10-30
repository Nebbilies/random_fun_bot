# Item expiry implementation plan

## Scope and authority

Implement [the agreed item-expiry design](./item-expiry-design.md). This document is a plan, not authorization to change runtime code.

Keep character-game commands as prefix/message commands. Do not introduce slash commands or redesign the inventory UI merely to add expiry.

### Non-negotiable behavior

- Default lifetimes: Common 2 days, Rare 4 days, Epic 7 days, Legendary 14 days, `???` 30 days.
- Configure whole days from 1 through 365, globally with per-server overrides. Changes affect future acquisitions only.
- Stamp a fixed deadline on successful inventory insertion, including administrator grants and Alchemist rewards. Pending rewards do not age.
- Existing entries receive their full configured lifetime from a single persisted rollout instant, not from historical acquisition dates.
- At `now >= expiry deadline`, an entry disappears from inventory, stops consuming capacity, and cannot start another use or passive trigger.
- A valid use started before the deadline may finish after it. This covers command/button activation, confirmation, delivery, and armed Recast. Existing action timeouts still apply.
- Never undo committed buffs or permanent effects because their source item expired.
- One started use protects only its own cost. Remaining charges expire; cancellation, timeout, or refund cannot revive an expired entry.
- Display remaining time as `(2d 16h)`. No unsolicited expiry notifications.

## Architecture and invariants

### Separate ownership visibility from action provenance

Use two distinct access patterns:

1. **Live inventory access:** only entries whose item deadline is in the future; used for display, capacity, new uses, passive triggers, and ordinary replacement/cost selection.
2. **Started-use access:** a durable action/hold reference authorizes completing the specific use that began before expiry. It may read its retained source row after that row is no longer live inventory.

Do not globally bypass expiry for an item merely because it is held. An expired held item is invisible and has no usable leftover charges, while the particular action still has its reserved cost.

Retain expired source rows while a durable action or Fortune hold needs them. This avoids prematurely breaking Fortune's `ON DELETE RESTRICT` references. Delete them only after all live references have been settled. Retention is internal, not an extra inventory slot.

### Time and concurrency

- Store `expires_at` as integer epoch milliseconds; calculate days as `days * 86_400_000`.
- Capture one `now` per operation and thread it through helpers. Provide deterministic clock inputs for tests.
- Do not create one long `setTimeout` per item. Availability is checked against persisted deadlines, so 30–365-day lifetimes and downtime work correctly.
- Atomically validate and establish a started-use reservation before asynchronous Discord work. Merely viewing inventory/help or sending an unsupported/rejected command is not authorization. Accepting a supported interactive-use command and durably creating its bounded selection/confirmation session is the valid-use start, matching the requirement that expiry is checked at `!use` rather than during its interaction flow.
- Reservations must prevent duplicate costs/effects from concurrent commands, buttons, or passive consumers. Preserve existing idempotency keys and transaction boundaries.

## Phase 1 — Schema and rollout compatibility

**Primary files:** `lib/itemStorage.js`, `lib/catalogFinalSchema.js`, `lib/vaultFortuneSchema.js`, `lib/characterIdentitySnapshots.js`, `lib/characterMigrationSettlement.js`, plus the schema/version/upgrade entry points identified by tracing their callers.

1. Add the persisted inventory `expires_at` field and appropriate lookup/expiry indexes. Transitional nullability is allowed only inside migration; runtime entries must have a valid deadline.
2. Add a versioned, transactional, once-only backfill:
   - Persist one rollout timestamp.
   - Resolve each legacy entry's item tier and effective guild lifetime at migration time.
   - Set its deadline to rollout timestamp plus that lifetime, preserving ID, acquisition timestamp, charges, and holds.
   - Abort with diagnostics on unknown item definitions or invalid configuration rather than silently granting immortality or deleting data.
   - Reopening the database must never reset or extend deadlines.
3. Introduce durable started-use provenance for confirmation flows that do not currently hold their source. Reuse existing action/escrow storage where compatible; otherwise add a dedicated reservation relation keyed to the existing action ID.
4. Update canonical schema definitions, upgrade/version checks, fixtures, and any schema fingerprint expectations together. Do not assume adding an `ALTER TABLE` in runtime initialization satisfies final-schema checks.
5. Update exact inventory snapshot fields and escrow producers/validators to preserve `expires_at`. Explicitly support old snapshot shapes only on documented upgrade paths; do not broadly weaken validation.
6. Preserve preexisting confirming actions and Fortune/Hostage holds through upgrade. They already began before rollout; migration must not strand their source or fabricate duplicate reservations.
7. Check initialization order: configuration and item definitions must be available for backfill without creating a storage/config/Fortune import cycle.

**Acceptance:** old and fresh databases converge on the supported schema; migration is atomic and repeatable; held sources and exact snapshots remain valid; foreign-key checks pass.

## Phase 2 — Configuration and deadline stamping

**Primary files:** `lib/gameConfigSchema.js`, `lib/gameConfig.js`, `lib/itemRoster.js`, `web/reviewConfig.js`, `web/assets/reviewConfig.js`, `lib/itemStorage.js`.

1. Add a rarity-lifetime configuration group using numeric day values, for example `itemExpiryDays.common`, `.rare`, `.epic`, `.legendary`, and `.???`, consistent with registry path handling.
2. Supply the agreed defaults and explicit integer validation from 1 to 365. These are day counts, not `Ms` descriptors subject to Node's approximately 24.9-day timer limit.
3. Preserve existing inheritance, reset-to-inherited behavior, authorization, atomic section saves, and revision-conflict handling.
4. Label fields by rarity, show the unit as days, and state: “Applies to newly acquired items only.”
5. Stamp `expires_at` inside `addItemToInventory()` only on successful insertion using the resolved item tier and effective guild config. Keep existing caller compatibility while adding an injectable time option.
6. Audit insertion paths: vault delivery/overflow, Alchemist output, `/api/game/give-item`, and migration reward settlement. All new acquisitions use the shared stamp; failed/full attempts and pending rewards receive no deadline.
7. Never refresh the deadline on charge spending, escrow release, refund, configuration edits, or restarts.

**Acceptance:** all acquisition paths get the correct fixed deadline; guild overrides work; 30 and 365 days are accepted; changing settings leaves existing entries untouched.

## Phase 3 — Live inventory queries and capacity

**Primary files:** `lib/itemStorage.js`, `lib/vaultRewards.js`, `lib/vaultFortune.js`, and all direct readers/writers of `user_inventory`.

1. Make live inventory reads explicitly time-aware (`expires_at > now`). Keep raw source lookup separate and internal to authorized continuation/recovery.
2. Count only live rows for capacity and insertion. Expired rows retained for an action must not block a new acquisition or overflow acceptance.
3. Filter usable entries by positive charges, non-expiry, and absence of a conflicting reservation/hold.
4. Select matching duplicates by deadline ascending, then ID ascending for deterministic ties. Preserve existing exact-name-before-partial-name matching behavior.
5. Update inventory replacement, sacrifice/crafting lists, overflow choices, Fortune availability SQL, and any bypassing direct queries. Revalidate selected ordinary costs at their commit boundary.
6. Inventory expiry protects only the already-started source use; it must not silently grandfather every additional cost selected later (for example Alchemist ingredient entries). Keep cost eligibility checks distinct from source continuation.
7. Ensure all release/refund paths preserve the original deadline and leave post-deadline entries unavailable immediately, even before physical cleanup.

**Acceptance:** expired rows neither appear nor count toward capacity; retained held rows remain accessible only to their authorized action; stale replacements cannot consume the wrong entry.

## Phase 4 — Preserve started uses across expiry

**Primary files:** `lib/itemActivation.js`, `lib/itemActions.js`, `lib/itemActionStorage.js`, `lib/itemActionRuntime.js`, `lib/vaultFortune.js`, `lib/vaultFortuneRuntime.js` where present.

1. Establish the source's eligibility/reservation at the actual valid-use start, not merely when the dispatcher returns `pendingAction`.
2. `createItemAction()` must atomically check source expiry and reserve its use. Carry this durable authority through selection and confirmation.
3. Replace `activateItemAction()`'s current source lookup through `getUsableInventory()` with action-owned source validation. Validate ownership, item identity, reservation, remaining reserved cost, action state, and the action's own timeout—but do not reject because the inventory deadline passed.
4. Avoid treating the action's own reservation as an unrelated escrow refusal in charge-decrement helpers. Use explicit action-authorized consumption rather than a general “ignore escrow/expiry” flag available to arbitrary callers.
5. Hostage delivery may consume the reserved charge after expiry. Cancellation/undelivered recovery releases it without restoring live inventory after expiry.
6. Lens activation checks expiry at its own vault button entry point. Presentation/acknowledgement may finish after expiry. Failed-presentation refunds retain the original deadline.
7. Recast arming checks expiry once and holds its charge. Its existing armed state survives the deadline, restart, reward preparation, and choice delivery. Finishing or cancelling never returns a usable expired entry.
8. Immediate legacy item execution must validate and commit synchronously/transactionally with consumption before asynchronous follow-up. Preserve delivery retry semantics: never replay an already committed effect.
9. Release reservations on rejection, cancellation, timeout, and terminal completion. Failed validation must not leave a fresh usable reservation. Add recovery for failures between reservation and prompt delivery.
10. Verify multi-charge behavior: completion spends only the authorized charge; any expired remainder is invisible and eligible for cleanup after holds end.

**Acceptance:** starting just before expiry and confirming afterward succeeds once; starting at/after expiry fails without costs; cancellation and restart do not revive items or lose valid actions.

## Phase 5 — Passive consumers and recovery

**Primary files:** `lib/characterRollRuntime.js`, `lib/mysteryCoordinator.js`, `lib/items/masterKey.js`, `lib/items/pickpocketsHook.js`, `lib/itemActions.js`, `lib/vaultFortune.js`, `index.js`.

1. Audit the entire repository for `user_inventory`, `getInventory`, `getUsableInventory`, and charge-decrement calls, including web/admin paths. Classify each as live inventory, fresh trigger, or authorized continuation.
2. Apply the live deadline predicate to Golden Whistle, Mirror Shield, Binoculars, Fortune availability, and every other automatic consumer found by the audit.
3. Couple passive eligibility, cost spending, and effect commitment atomically. An already-triggered effect completes normally after expiry.
4. Add bounded garbage collection for expired rows without live reservations or restrictive references. Cleanup must not cancel actions, disarm Recast, fire discovery events, or emit player messages.
5. Integrate cleanup with existing startup/reconciliation infrastructure and opportunistic post-release cleanup. Do not add a second competing recovery loop or require timers for correctness.
6. Recovery must reconcile live actions/holds before deleting their source records. Historical references must follow the existing schema's retention constraints rather than being blindly cascaded away.

**Acceptance:** expired passive items never trigger; delayed cleanup cannot alter gameplay eligibility; active effects and armed Recast survive offline periods correctly.

## Phase 6 — Inventory/catalog presentation and stale controls

**Primary files:** `commands/inv.js`, the existing item-list renderer located through `test/itemList.test.js`, and shared item presentation helpers.

1. Add a pure remaining-lifetime formatter using at most two nonzero units, for example `(2d 16h)`, `(4h 12m)`, and `(35s)`. Use seconds below one minute and avoid displaying a positive lifetime as zero; expired entries are filtered out rather than labeled usable.
2. Render the suffix per inventory entry beside its name/charges, preserving existing discovery and ownership visibility rules.
3. Show current configured rarity lifetime in the existing item catalog/tier presentation without revealing undiscovered item names or descriptions.
4. Thread the same captured `now` through embed rendering, capacity, and button generation so a single response is internally consistent.
5. Return an expiry-specific response for a stale selected entry when its provenance is still identifiable. If a row has already been purged and expiry cannot be proven, say “This item has expired or is no longer available” rather than inventing a diagnosis. Never select a replacement copy silently for an ID-specific button.
6. Reuse current UI components and ownership checks. No unsolicited DMs, channel notices, or per-second message edits are required; remaining time refreshes on ordinary rendering.

**Acceptance:** `(2d 16h)` appears for the intended remaining duration; buttons never expose expired entries; stale buttons spend nothing; catalog concealment is unchanged.

## Phase 7 — Verification

Use Node's existing test runner and controlled clocks; do not wait for wall-clock expiry.

### Tests to add or extend

- **Configuration:** `test/gameConfig.test.js`, `test/gameConfigRuntime.test.js`, `test/configPortal.test.js`: defaults, all five tiers, inheritance/reset, 1/365 boundaries, rejection of 0/fractions/366, revision conflicts, and prospective-only saves.
- **Storage:** `test/itemStorage.test.js`, plus a focused `test/itemExpiry.test.js`: exact deadline boundaries, charge preservation, all insertion paths, no deadline on failed delivery, capacity with expired held rows, duplicate ordering, no refund/reset extension.
- **Schema/upgrade:** `test/finalCatalogStartup.test.js`, `test/catalogReleaseSchema.test.js`, `test/fortuneUpgrade.test.js`, `test/characterIdentityMigration.test.js`, `test/characterMigrationSettlement.test.js`: one rollout instant, repeated opens, rollback on migration failure, exact escrow snapshots, preexisting actions/holds, and foreign-key integrity.
- **Actions:** `test/itemActivation.test.js`, `test/itemActions.test.js`, `test/itemActionRuntime.test.js`: pre-deadline start/post-deadline confirmation; source vs additional cost eligibility; exact-deadline refusal; invalid attempts; duplicate starts; cancellation/timeout; restart and delivery failure; multi-charge remainder expiry.
- **Fortune:** `test/vaultFortune.test.js`, `test/fortuneRuntime.test.js`: Lens start vs continuation/refund; Recast armed across expiry and restart, subsequent reward/choice completion, eventual source cleanup without FK violations.
- **Passives/effects:** `test/itemEffects.test.js`, `test/itemBuffRolls.test.js`, `test/itemExpansionEdges.test.js`, `test/itemBehaviorAudit.test.js`: no new expired passive triggers; active buffs, soulbinding, capacity upgrades, Crown defenses/tokens, and already-triggered effects remain unchanged.
- **Presentation:** `test/finalInventoryControls.test.js`, `test/itemList.test.js`: duration formatting boundaries, deadline filtering, stale controls, other-user inventory, discovery concealment, and unchanged prefix-command behavior.

### Execution order

1. Run focused tests after each phase (`node --test test/<affected>.test.js`).
2. Run the full `npm test` suite after integrations are complete.
3. Exercise an old database fixture through upgrade, restart, expiry, and held-action settlement; run `PRAGMA foreign_key_check`.
4. Manually verify the portal's per-tier inputs/inheritance and a Discord inventory rendering/stale-control interaction in a safe environment, if credentials/runtime access are available. Otherwise document that limitation.

## Delivery and rollout checklist

- Update the design document's status once implementation is explicitly authorized; keep the design and glossary aligned with delivered behavior.
- Update configuration documentation and player-facing item help with defaults, fixed deadlines, compact remaining time, and the started-use exception.
- Back up production storage and record the rollout instant before deployment. Trial migration on a copy first.
- Deploy schema, stamping, eligibility, and continuation handling together. Do not enable destructive cleanup before started-use protection works.
- Confirm legacy inventory has exactly one valid deadline per row, no migration restamping, no orphaned holds, and no capacity inflation from raw retained-row counts.
- Report focused/full test results, manual checks performed or unavailable, and any upgrade limitations.
- Rollback requires a schema-compatible application version or an explicit database restore/forward fix; do not promise that old runtime code can safely open the upgraded schema.

## Suggested implementation sequence

1. Schema + migration + configuration foundation, with upgrade tests.
2. Deadline stamping + live inventory queries + capacity and duplicate selection.
3. Durable started-use protection + Hostage/Fortune continuation and refund handling.
4. Passive-path audit + cleanup/recovery integration.
5. Compact UI/catalog presentation + stale-control feedback.
6. Full regression suite, fixture upgrade rehearsal, and rollout documentation.

Treat steps 2–4 as one release boundary: expiry must not ship with only command-level checks or without preserving valid in-progress uses.
