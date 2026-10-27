# Fortune items — Phase 1 implementation plan

Status: Awaiting user approval. No production changes or tests authorized by this plan until approval.

Design authority: `docs/fortune-items-phase-1-design.md`, approved in conversation. Sequence is Lens -> slot selection -> Double or Nothing -> Recast -> inventory/overflow. A lost gamble leaves Recast armed; a won gamble uses the upgraded tier.

## Technical decisions

### Durable storage and costs

Use a focused Fortune storage/service module (`lib/vaultFortune.js`) with durable Lens state, source-item holds, armed Recast state, and per-reward Recast decisions. Keep the main reward state machine authoritative for delivery; Fortune decisions gate its existing delivery operation, not a second award path.

A held source inventory entry remains in inventory and occupies its slot, but is excluded from all use, replacement, removal, and gambling-cost selection. Recast arming reserves the source without decrementing charges. Lens decrements its charge on candidate commitment but retains the held source row (even at zero charges) until reveal acknowledgement or expiry. On acknowledged reveal, remove an exhausted row or release a still-charged row. On undelivered expiry, increment that same held row once and release it. This prevents a refund needing a new inventory slot or undoing later uses. Inventory presentation must explicitly label a temporarily held entry; never silently expose a zero-charge row as usable.

Use immediate SQLite transactions and uniqueness constraints for one armed effect per guild/player, one Lens activation per vault, and one Recast decision per reward. Preserve IDs and recorded charge counts; do not merge unrelated copies. Snapshot all supported reward tiers in new sessions and mark new sessions with a Fortune capability version; old snapshots remain untouched.

### Discord delivery and privacy

Lens candidates are edited into the durable public vault card. Persist candidate state and pending-delivery intent first. An acknowledgement marks the saved reveal as presented. Recovery fetches the canonical message and checks its versioned Lens content/controls before refunding an apparently unacknowledged reveal. Definitive failure to find a reveal permits the agreed expiry refund. Transient/unverifiable fetch failure defers settlement rather than guessing that the item was never shown. Expiry ends selection even while refund reconciliation is pending.

Private Recast choices use ephemeral responses reached through an owner-only public Open Recast choice button on the canonical vault reward card. Initially attempt to present that private choice from the triggering interaction. If that interaction is unavailable or publication fails, retain the durable pending choice and resume button; never disclose the original/alternative list publicly as part of the Recast prompt. Restart recovery restores the public resume control; a new interaction can reopen the private choice without reliance on the old token.

Persist alternatives once before any presentation. Hold the armed charge while publication is pending; consume it and start the captured decision window on confirmed presentation. A click on a valid already-published private control can also confirm presentation transactionally after a crash. Bind private controls to guild/player/vault/decision identity; verify the live canonical public reward binding as well. Keep the original choice deadline when reopening.

There is no perfect atomic commit between Discord and SQLite. An uncertain send must not redraw or double-charge; recover the same decision. Record this remaining acknowledgement limitation in release documentation rather than claiming exactly-once message delivery. A Recast pending-publication state must remain recoverable without holding open the overall game process.

### Compatibility and rollout

Coordinate authoritative DDL, schema versioning, conversion, and restart validation. Inspect `lib/catalogDb.js`, `lib/catalogReleaseSchema.js`, `lib/characterIdentityMigration.js`, and `scripts/migrateCharacterIdentities.js` before selecting the exact versioned upgrade hook. Add an explicit tested offline upgrade path for an existing final-schema database; never mutate a validated v12 database silently on normal startup. Empty creation and legacy conversion must produce the same target schema. Do not run migration against a real database during this task.

If the repository's supported release workflow cannot safely provide this upgrade without a broader migration redesign, stop and report that blocker instead of expanding scope silently.

## Files and ordered work

### Slice 1 — Baseline and configuration/catalog

- Run the existing focused item/vault/config/restart tests and record pre-existing failures.
- Add `lib/items/fortunesLens.js` and `lib/items/fortunesRecast.js`; register in `lib/items/index.js`.
- Update `lib/gameConfigSchema.js` and `lib/itemRuntimeConfig.js` for stable IDs `fortunes_lens` / `fortunes_recast`, Rare membership, reward eligibility, one-charge defaults, validated starting/max charges and descriptions.
- Reuse `itemActions.doubleDecisionMs` as agreed rather than introduce an independent Recast timer.
- Verify registry-driven portal editing, global/guild inheritance, and invalid-value rejection. No new dependency.

### Slice 2 — Durable schema and held entries

- Add Fortune tables/constraints through `lib/catalogRuntimeSchema.js` and the supported release upgrade boundary above.
- Update `lib/catalogFinalSchema.js`, `lib/catalogReleaseSchema.js`, and relevant conversion/validation code as required by schema inventory.
- Extend `lib/itemStorage.js` escrow checks and audit direct inventory queries (including `lib/vaultRewards.js` and item-action cost paths) so held entries cannot be removed or spent elsewhere.
- Add `lib/vaultFortune.js` APIs for scope-safe arming, Lens activation, reveal acknowledgement/refund, Recast preparation/presentation/selection, and recovery inspection.
- Update `lib/catalogRuntimeRecovery.js` and startup preflight to validate held-row provenance, supported states, captured pools, deadlines, and uniqueness. Never reroll missing state during repair.

### Slice 3 — Lens end to end

- Extend `lib/vaultSessions.js` captured Fortune capability, all-tier pools, and persisted candidate reads.
- Extend `lib/vaultRuntime.js` vault card/button rendering, owner authorization, Lens activation, A/B/C outcome selection, expiry, and canonical-message recovery.
- Route selected saved outcome into the existing reward service exactly once.
- Handle failed sends, restart before/after publication, no second activation, and charge restoration through held entries.

### Slice 4 — Recast end to end

- Update `lib/itemActivation.js` to reserve Recast without the generic success decrement; direct Lens use gives guidance to the vault button.
- Ensure `commands/use.js` supports unambiguous `fortunes_recast` and `recast`; ambiguous `fortune` must not activate an arbitrary item. Preserve argument-based existing item commands.
- Update `commands/inv.js` only as needed to label holds/armed state and prevent conflicting controls.
- Refactor the public reward transition in `lib/vaultRewards.js` minimally: after kept/won outcomes, route through Recast preparation before existing inventory delivery. A gamble loss bypasses Recast without clearing arming.
- Carry the original session's captured pools/rules through upgraded rewards; prevent upgraded outcomes dropping the snapshots.
- Add persisted pending-presentation and decision handling, timeout Keep, zero/small alternative pools, per-owner concurrency, and terminal idempotency.
- Extend `lib/vaultRuntime.js` private prompt/resume controls and restart recovery. Existing overflow remains downstream of the terminal Recast choice.
- Wire new interaction IDs and periodic recovery through existing routing in `index.js` and/or the current dispatcher after inspection.

### Slice 5 — Extensible item-release changelog

- Add `lib/itemReleases.js`: maintained dated release entries listing added item IDs, validated against the roster. Select only the latest entry; no automatic announcements from catalog edits.
- Format names with Markdown escaping and guild discovery masking. Generate singular/plural counts, two-item conjunctions, longer lists, and separate clauses for mixed rarity groups.
- Update `lib/itemList.js` and `commands/itemlist.js` to show the changelog independently of rarity filter/page and refresh discovery on interactions. Respect Discord component/text limits as release lists grow.
- Set the initial record's fixed date from the actual release preparation date; do not infer it from the uploaded handoff filename. Document where a future release is added.

## Proposed test seams — approval requested

1. **Item activation and inventory APIs:** arming, charge holds, repeat activation, ownership scope, capacity and release. Catches cost errors; not Discord delivery.
2. **Vault session/reward APIs with real SQLite:** saved draws, ordering, same-tier alternatives, timeout, duplicate/concurrent actions, and overflow. Catches transactional gameplay errors; not Discord transport.
3. **Vault interaction and recovery entry points with a fake Discord transport:** visible Lens cards, private Recast prompts, forbidden/stale controls, retries, deleted versus transient failures, and original deadlines. Catches orchestration; not actual Discord server behavior.
4. **File-backed reopen, schema conversion, and restart preflight:** durable state/cost recovery and legacy snapshot compatibility. Catches restart/upgrade regressions; no live-database operations.
5. **Config service/portal API and resolved item definitions:** defaults, validation, inherited settings, charge tuning and captured terms. Catches configuration contract errors; no browser styling audit.
6. **Itemlist command/rendering:** fixed dates, future releases, all discovery combinations, mixed rarities, escaping, filters/navigation, and bounded content. Catches announcement behavior; not manual visual review in Discord.

Use `node:test` and the installed SQLite facilities. Work vertically: one failing behavior test -> minimal implementation -> rerun, then the next behavior. Do not bulk-write all tests against an imagined API. Extend existing test files where they already cover the seam; add focused `test/vaultFortune.test.js` and runtime/recovery tests as needed.

## Verification and handoff

- Run targeted item, vault, itemlist, config/portal, schema and restart suites after each relevant slice.
- Run `npm test` and `npm run typecheck:catalog` using background terminals if lengthy. Report unrelated baseline failures separately from regressions.
- Review changed SQL/direct inventory paths, state transitions, snapshot compatibility, authorized routing, message limits, and failure-injection coverage.
- Update design/plan status and add rollout/upgrade notes and future changelog instructions.
- Report modified files, tests, remaining limitations, and deployment steps. No commits, bot startup, live Discord actions, or live DB migration without explicit authorization.

## Self-review

The plan addresses the original four risks with held inventory rows, restart-safe public resume/private choice controls, reconciled Lens acknowledgement, and explicit schema rollout. It retains existing public service boundaries and overflow handling rather than implementing parallel delivery. Privacy does require a resumable public button when the original interaction is unavailable; alternatives remain private. Uncertain Discord acknowledgements cannot offer mathematical exactly-once presentation, but saved draws, costs, terminal choices and inventory awards remain transactional/idempotent.

No production files or tests changed during planning. Exact migration mechanics must be confirmed by reading the current release boundary before implementation; unsafe upgrade discovery is a stop-and-report condition.
