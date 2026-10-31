# Items Phase 2 — design proposal

Status: approved in conversation; implemented on `feat/items-phase-2`. See `items-phase-2-plan.md`, rollout notes and validation report for implementation/verification status.

## Scope and precedence

Implement Consolation Chit and Chronicle of Return, plus the item-list release announcement. Use existing prefix commands and Components V2 where useful. No Phase 3 items, changes to ordinary vault odds, or commits. The interview decisions below supersede the attached handoff where they differ.

## Consolation Chit

- Common, one use per copy, normal reward-eligible item. Passive: manual activation explains its automatic behavior and spends nothing.
- At a genuine mystery-event win resolution, check whether the winner has a claim available. A winner without one automatically spends one usable Chit for one random item. Do not confuse a losing Doors outcome with a win.
- No Chit trigger for an unavailable character alone, losing, no winner, declining, expiry, unauthorized controls, or an allowance failure later in the claim window. This explicitly narrows the original handoff.
- Reveal the character first, then ping the winner with a direct item-reward message. No compensation vault or extra opening step. Add the reward directly if space permits; otherwise use the existing replace-or-decline flow.
- At activation capture current reward-eligible definitions and Chit-specific configured tier weights: Common 69.9, Rare 17.5, Epic 10, Legendary 2.5, ??? 0.1. Exclude empty tiers, normalize positive remaining weights, choose uniformly within the selected tier. Duplicates and both Phase 2 items are allowed. A rewarded Chit cannot recurse.
- No Lens, Recast, or Double or Nothing effects on this reward. Preserve ordinary vault behavior.
- Atomically link one outcome to one event, consume one Chit and persist the rolled reward. Repeat processing and restarts cannot reroll, spend twice, or award twice. The Chit stays spent if overflow is declined or result-message delivery fails; recover presentation without repeating activation.
- Reject configuration with no positive-weight eligible reward pool. Defensively, if no reward can be produced at runtime, spend nothing. Use usable inventory only, respecting expiry and escrow.

## Chronicle of Return

- Epic, one use per copy, normal reward-eligible item. Select a formerly owned character in this guild, preview and confirm through existing durable item-action controls.
- Default history window: seven days, validated and configurable in the existing portal hub. Item descriptions display the current configured period.
- Capture the applicable history window when the confirmation starts. At confirmation recheck elapsed time against that window and the former owner's most recent ownership loss for this character.
- Eligible targets are in the current catalog, currently unowned, and otherwise available. Reject live roll, mystery, escape, trade, gift, or item reservations rather than disrupting them. No rank limit.
- Record all post-introduction ownership losses, including transfers, thefts, trades, gifts, escapes that actually change ownership, sacrifices and forced divorces. Do not treat an escape attempt or current-owner escape reclaim as a loss.
- An owner already holding a character at deployment gains a qualifying record if they lose it after deployment. Do not backfill older losses. Keep identities and records server-scoped; latest loss is specific to the former owner and character.
- Successful confirmation atomically creates fresh ownership, spends one use and persists the terminal result. Do not restore old marriage metadata, spend a normal claim, reset cooldown, or consume claim buffs. Cancellation, timeout, no eligible target, unavailable target, or missing item costs nothing.
- Repeated returns are allowed following a new qualifying loss, spending a new Chronicle each time. Retries of a completed action do not create another marriage or spend another use.

## Item-list announcement

- Place a top-level TextDisplay before the existing Components V2 catalog container; do not use ordinary message content alongside Components V2.
- Format `### Changelog — DD/MM/YYYY`, followed by copy announcing one new Common and one new Epic item. Use the implementation date and make Phase 2 the latest release.
- Preserve per-guild discovery masking: undiscovered names are `???`, discovered names are shown. Refresh correctly on paging, filtering and control expiry; retain the total text budget.

## Design options and recommendation

1. Independent item SQL, reward collectors and local history hooks: reject. Misses direct ownership writers and duplicates restart/overflow logic.
2. Route Chit through normal vault resolution: reject. Introduces unrequested reward modifiers and cannot be nested safely inside the existing mystery transaction.
3. Reuse durable item actions for Chronicle, introduce complete loss tracking at the ownership storage boundary, and reuse source-neutral persisted reward delivery for Chit: recommend. Extend existing schema validation/additive startup upgrade support rather than a parallel persistence system. Exact helper/module boundaries and migration strategy belong to the implementation plan.

## Verification requirements

- Chit: all mystery win variants versus losing Doors/no winner; allowance at resolution versus later failure; unavailable prize alone; single event/source identity; expired/held Chits; independent weights and empty tiers; direct delivery, overflow decline/replace, message ordering and intentional winner ping; concurrent retries, crash recovery and no vault modifiers.
- Chronicle: every loss writer; latest loss, guild/owner isolation and history boundary; exact time boundary; snapshot window versus live description; fresh ownership and unchanged allowance/cooldown/buffs; current catalog and every conflicting reservation; cancellation, stale controls, concurrent acquisitions and restart-safe cost/result handling.
- Config: defaults, validation, global/guild inheritance/reset combinations and portal editability. Schema: fresh database and additive startup upgrades, exact schema validation and durable recovery.
- Item list: standalone heading order, mixed rarities, hidden/discovered names and text budget on every render.
- Run focused and regression suites, full suite and available catalog typecheck; report actual results and limitations.

## Author self-review

Reviewed against the handoff, interview and read-only code survey. Explicitly resolved two handoff changes: no unavailable-prize-only compensation, and direct reward rather than a compensation vault. Existing history-free ownership documentation must be superseded. Reward activation must happen in the durable win/failure boundary, not only a Discord callback. Ownership tracking must cover direct UPDATE and DELETE writers, not just the public divorce helper. Ordinary vault modifiers and normal claim state must remain untouched. Preserve unrelated local files and existing glossary edits. No further product decision is required before plan approval; concrete integration risks must be checked during planning and surfaced rather than silently changing these rules.
