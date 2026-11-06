# Affection and soulmate — phase-2 design proposal

Status: accepted design; implemented on `feat/character-affection` after the user explicitly approved implementation, split commits, validation and a pull request. See [affection-validation.md](./affection-validation.md) for actual verification and limitations. Production deployment/database operations remain separately unauthorized. The user selected a compact meter toward the next reward for the initial display; a paged reward path is out of scope.

## 1. Purpose, scope, and precedence

Give players progression with owned characters, including a selected soulmate with automatic player-wide perks. Reuse the existing character identities, SQLite transactions, prefix commands, Components V2 cards, ownership rules, item catalog, and pending-item dialog. No new dependency, XP currency, numbered-level system, active perk loadout, generic event engine, or second reward-delivery subsystem.

Product authority is the completed interview in [affection-brainstorm.md](./affection-brainstorm.md), with terminology in [GLOSSARY.md](../GLOSSARY.md). This proposal consolidates those decisions and chooses engineering seams; it does not revive earlier, superseded ideas. In particular:

- Franchise scores are **12 / 10 / 5**, not 4 / 3 / 2; use the **lowest award among shared franchises**.
- First Windfall is **100 affection at 8%**. All seven base perks are available at 900; the complete track caps at 2,100.
- Every normal character shares the normal reward track. Only the selected, currently owned soulmate supplies soulmate perks.
- Claim Conservation **also preserves Engagement Ring's enabling prepared use**, with the same check. It does not refund Ring activation or extend expiry.
- Later normal rewards follow Epic / Epic / Legendary every 100 affection, ending at 2,100. They are one-time milestones, not endlessly repeating rewards.

This supersedes the self-owned escape rule in [character-escape-design.md](./character-escape-design.md), its blanket soulbound roll exclusion, and Cupid's Misfire's existing self-divorce behavior. Other current escape timing, item costs, delivery/recovery, and mystery rules remain unless explicitly changed here. The current source has durable roll recovery beyond that older escape document; preserve current recovery contracts, not obsolete restart behavior.

## 2. Relationship and ownership rules

### Saved progress

Affection is a nonnegative integer on `(guild, player, canonical character identity)`, capped at **2,100**. Unlocking a reward does not spend affection. A single award can cross multiple thresholds; unlock all crossed rewards once, then discard any amount above the cap. At maximum there are no additional rewards or banked excess. A future extension can resume from the old cap, not recover discarded points.

All relationships start at zero when the feature launches, including existing marriages. Do not reconstruct marriage-age progress, historic rolls, or earlier reclaims. Create progress lazily; a currently owned character without a stored progress row displays zero.

Ownership loss retains affection and earned payouts. Another owner starts or resumes their own independent progress. Reacquisition restores the former player's normal passive contribution but never repeats a payout. Character rank and external source linkage are not relationship identities.

### Soulmate selection

One selection per player per guild. The character must be currently owned and not busy in an escape, pending trade/gift, or item challenge. Use existing availability rules and revalidate at confirmation, not just when opening the chooser.

Every successful initial selection, switch, or ownership-loss replacement starts a **12-hour voluntary switching cooldown**. Loss of the selected character clears the selection and allows a replacement regardless of the previous cooldown. The replacement starts its own 12 hours. Reacquisition never automatically reselects that character. Selecting the already-active soulmate only opens its profile; canceling or rejecting a confirmation changes nothing.

No implicit selection on marriage or acquisition, and no new deselection command as a cooldown bypass. Ownership loss removes the old selection in the same transaction as the ownership mutation. A selected character may later become busy without losing selection; the restriction governs new selections, not already-active perks.

### Benefits

Normal passives require current ownership, including when that character is the soulmate. Soulmate perks require both selection and current ownership. Evaluate current benefits from stored progress joined to ownership; do not maintain independent consumable perk allowances.

Switching or ownership loss changes current benefits immediately without resetting roll usage, normal claim history, item counters, or deadlines. Already-awarded items, pending rewards, and activated temporary effects remain earned under their normal consumption/expiry rules.

## 3. Affection awards and eligibility

### Award rules

| Qualifying event | Recipient relationship | Base affection |
| --- | --- | ---: |
| Player rolls a character they own | Roller and that character | 100 |
| Successful owner reclaim on another player's roll | Owner and reclaimed character | 20 |
| Successful reclaim of a Siren's Call escape, including Whistle | Owner and reclaimed character | 20 |
| Successful manual or Whistle reclaim on a newly marked ordinary roll | Original roller and their current, owned soulmate at reclaim | 5 |
| Roller and selected soulmate share a qualifying franchise with the rolled character | Roller and selected soulmate | 12 / 10 / 5 below |

Only the roller's own requests grant indirect soulmate affection. Someone else's related roll does not. Siren activation is an item action, not a character roll for its instigator; it grants neither indirect affection nor a Windfall opportunity. Acquiring, trading, gifting, or directly marrying a character is not an additional affection source.

For appearance awards from a single source roll and player–character pair, do not add award categories. First resolve the franchise category, then use the highest qualifying category. Distinct pairs remain distinct: rolling an owned non-soulmate can award 100 to that character and a qualifying related award to the selected soulmate. If the rolled character is the soulmate, the direct 100 supersedes its smaller related award. The later 5-point roller reclaim bonus is a separate earning event and explicitly stacks with appearance affection.

The roller reclaim bonus requires `soulmateReclaimVersion: 1` in both the ordinary roll's saved terms and permanent request outcome. Only newly reserved ordinary rolls carry this marker; existing rolls, including pending ones, are not retroactively marked. Resolve the recipient and Unbroken Bond from the roller's current selected, owned soulmate when the owner successfully reclaims. Initial selection after the roll can qualify; switching does not move earlier appearance affection. Missing eligibility grants no bonus and cannot be reconsidered after the reclaim commits. Siren's Call has no paid roller envelope and does not grant this bonus. New roller awards use base 5 (10 with Bond); historical base-8 receipts retain their saved amounts and replay unchanged. Owner reclaim base 20 is unchanged. See [soulmate-reclaim-affection-design.md](soulmate-reclaim-affection-design.md) for migration, receipt, delivery, and feedback details.

There is no daily affection cap or repeat-character penalty. Separate legitimate rolls may each earn full awards; retries of one roll may not. Item-filtered rolls qualify normally.

### Franchise calculation

Retain all canonical memberships from `characterFranchiseRelation()` / `effective_character_franchises`, including direct curated and anime-derived membership. Within each franchise, count distinct **published** `characters.id`; a character can count once in each of several franchises. Do not count aliases, anime rows, staging candidates, or retained identities without publication.

| Published franchise size | Award |
| --- | ---: |
| 1–5 | 12 |
| 6–10 | 10 |
| 11+ | 5 |

Intersect the selected soulmate's and rolled character's franchise IDs. Evaluate the award for every shared franchise, and take the **minimum**. Sharing a 12-point and a 5-point franchise gives 5, never 12 or 17. Non-shared memberships do not affect that award. Do not sum franchise sizes or divide a character's membership weight. Use whole-catalog sizes, never the gender-filtered, temporarily available, or Passport-concentrated pool.

Snapshot the relevant matching inputs and counts at selection. Use bounded indexed membership/count queries, not an all-character pairwise scan on every roll. Any internal cache must be revision-scoped and discardable; stored eligibility, not a cache, governs a pending event. The design requires no new AniList request, genre inference, franchise import, or recategorization.

### Genre metadata and saved rules

As of the 2026-11-06 hotfix, shared genres and missing soulmate genre metadata grant no affection. Indirect appearance affection requires a shared franchise; the separately earned roller reclaim bonus does not. Direct own-character appearances and owner reclaims retain their existing awards.

New rolls save snapshot version 2 with franchise-only indirect awards. Previously captured version 1 rolls retain their original rules during validation and recovery, including any captured one-point award. Existing affection and rewards are retained. This changes the JSON rule version without changing the database schema or capture envelope version.

After version 2 rolls have been captured, a rollback binary must also accept version 2 snapshots; the previous version-1-only validator cannot validate them.

### Snapshot versus earning

- At character selection, capture roller, own-character ownership, selected-and-owned soulmate, matching facts, candidate base awards, and the applicable pre-event Unbroken Bond chance.
- At successful reclaim, capture the retaining owner's active perks before applying the reclaim award. Manual and Whistle reclaims share the same committed outcome.
- For newly marked ordinary rolls, also capture the original roller's current selected, owned soulmate and pre-award Bond chance at that successful reclaim. Commit both recipients' awards and milestone entitlements in the same transaction.
- Appearance affection is earned only after successful character presentation and a noncanceled appearance. A hidden mystery intro is insufficient. The eventual selected-character reveal qualifies even for a losing/unclaimable result. A prank/vault has no character appearance affection.
- A saved award stays assigned to the original relationship despite a later switch or ownership loss, unless the appearance is canceled. It cannot restore lost passives.
- Newly crossed perks cannot boost the event that unlocked them. In particular, a 100-point own-character appearance can unlock Windfall from zero but cannot make that same request free retroactively.

Keep selection, Discord acknowledgement, publication/cancellation, and earning as separate facts. Existing `published_at` or `roll_delivery.phase='bound'` alone is not proof of an eligible appearance. For durable ordinary cards, use the canonical delivery acknowledgement plus successful publication outcome. For an owner-appearance result, use its acknowledged terminal appearance outcome. For mystery, persist a character-reveal acknowledgement distinct from the intro and from claim availability. Extend existing recovery to complete those acknowledgements and pending awards, not to reselect or repeat mystery gameplay.

A transport failure does not earn affection until presentation is acknowledged. If send succeeds but acknowledgement is lost, recovery may resend outside Discord's nonce window: Discord delivery cannot be exactly-once. Permanent source/pair receipts still guarantee at-most-once progress and payouts. Cancellation gating applies before initial earning; an appearance already validly shown and credited does not lose affection because its later claim/escape is canceled by an ownership change. A later best-effort status edit failure cannot undo committed progress.

## 4. Normal reward track

All characters, soulmate or otherwise, use the same cumulative affection total and normal milestones. Normal non-soulmates generally progress through their own appearances and reclaims, not the soulmate's indirect matches; do not promise soulmate-paced progression for every character in a harem.

| Total affection | Normal reward |
| ---: | --- |
| 25 | One Four-Leaf Clover copy |
| 50 | One Hourglass of Haste copy |
| 100 | One random Common copy |
| 200 | +1 hourly roll-capacity contribution while owned |
| 300 | One Love Letter copy |
| 400 | One random Rare copy |
| 500 | One Golden Whistle copy |
| 600 | One random Rare copy |
| 700 | Six-minute normal claim-wait reduction contribution while owned |
| 800 | One random Rare copy |
| 900 | One Franchise Passport copy |
| 1,000 | One random Epic copy |
| 1,100 | One random Epic copy |
| 1,200 | One random Legendary copy |
| 1,300 | One random Epic copy |
| 1,400 | One random Epic copy |
| 1,500 | One random Legendary copy |
| 1,600 | One random Epic copy |
| 1,700 | One random Epic copy |
| 1,800 | One random Legendary copy |
| 1,900 | One random Epic copy |
| 2,000 | One random Epic copy |
| 2,100 | One random Legendary copy |

One item copy has its normal configured starting charges; Golden Whistle defaults to three. Each item milestone pays once per relationship. The first own-character appearance from zero crosses 25/50/100 and earns three separate copies. A doubled 100-point award can cross two later hundred-point milestones; grant each once.

### Roll capacity

For current owned progress, sum one contribution per character with at least 200 affection, capped at **+5**. Effective capacity is:

`floor(configured base allowance × active Rush multiplier) + capped affection bonus`

Without Rush the multiplier is one. Base seven, Rush 2×, and affection +1 gives 15, not 16. Preserve spent usage as benefits change, clamp displayed remaining at zero, and use the same capacity calculation for status, requests, daily/refill output, and item messages. Existing hourly resets and refills remain resets of usage, not banked bonus rolls.

### Normal claim availability

Sum six minutes per currently owned character with at least 700 affection, capped at **60 minutes**. Preserve the configured fixed claim buckets and their reset timestamps.

If the current bucket is unspent, the normal claim is available. If spent, compare the next scheduled reset with the previous normal claim time plus the configured interval shortened by the current affection reduction, and, when live, the Ring's existing shortened interval. Use the earliest time; do not add Ring and affection reductions. Never calculate a negative waiting interval. Missing prior claim timestamps retain the safe scheduled-reset behavior.

Preserve resource precedence: **Double Date free claim → Sovereign Crown token → Piñata token → normal claim**. Determine the resource and whether the Ring is actually necessary before ownership changes. Reclaims bypass the entire resource path. On a nonconserved normal claim, mark the bucket spent and update its last-normal-claim timestamp. On a conserved normal claim, leave **both** previous values untouched; do not reset or refresh them.

If Ring alone enables the normal marriage, a successful Claim Conservation check also preserves that prepared Ring use. Otherwise spend it only when it actually enabled the nonconserved marriage. No Ring use is spent when a bypass token, natural reset, or affection reduction already suffices. Ring activation's inventory charge is separate, and expiry never refreshes.

Use the same read-only eligibility calculation for mystery-win Chit availability, status commands, UI, and the final claim transaction. Status inspection does not consume counters or prune/create state.

## 5. Soulmate checkpoints

Only the active, currently owned soulmate supplies every checkpoint its saved affection has reached. Same-effect rates replace, rather than add to, earlier rates. Different effects remain cumulative and use independent checks.

| Total affection | Unlock or upgraded chance |
| ---: | --- |
| 100 | Windfall 8% |
| 150 | Item Conservation 8% |
| 200 | Unbroken Bond 8% |
| 250 | Windfall 10% |
| 300 | Claim Conservation 8% |
| 400 | Item Conservation 16% |
| 500 | Fortune's Favor 8% |
| 600 | Unbroken Bond 16% |
| 700 | Negation 8% |
| 800 | Claim Conservation 16% |
| 900 | Echo 8% |
| 1,000 | Fortune's Favor 16% |
| 1,100 | Negation 12% |
| 1,200 | Echo 16% |
| 1,300 | Windfall 15% |
| 1,400 | Item Conservation 20% |
| 1,500 | Unbroken Bond 20% |
| 1,650 | Claim Conservation 20% |
| 1,800 | Fortune's Favor 20% |
| 1,950 | Negation 16% |
| 2,100 | Echo 20% |

### Windfall

One saved cost check per valid player-requested roll, including ordinary, own-character, escape, mystery, vault, and prank results. Require at least one available roll **before** selection/refunds. Paused, empty-pool, duplicate, invalid, or exhausted requests get no new check or cost. Item-funded escapes/vaults with no ordinary roll cost do not qualify.

Snapshot the active chance before same-request effects, but commit a result only with an accepted reservation. Successful Windfall makes the current debit zero. It neither starts another roll nor adds allowance. Separately requested consecutive rolls have independent chances, with no extra daily limit. Keep its decision if delivery later fails.

Apply any existing Rolling Fever refund to already-spent usage, then debit the current request by zero or one. Never refund a later bucket or subtract from usage below zero. Prank, vault, and character/mystery debit sites must share this cost calculation and saved receipt. Failed delivery/recovery never rolls Windfall or charges again.

### Unbroken Bond

Double a qualifying affection award once, using the chance captured at that event's eligibility snapshot. This covers direct appearances, shared-franchise matches, and reclaims, including awards to other owned characters. Never multiply a milestone payout, recursively boost a boosted award, or activate newly unlocked Bond on the same event. Apply the capped resulting affection and all crossed milestones atomically.

### Claim Conservation

After a valid marriage is secured in its transaction, preserve the one identified claim resource with one saved check using the claimant's pre-consequence active soulmate chance. Failed, stale, protected, or losing reactions receive no new check. Direct acquisitions that spend no claim, and owner reclaims, have nothing to conserve.

Preserve exactly the resource that existing precedence would spend; do not choose a cheaper resource or check each token in turn. Preserve temporary expiry and counters unchanged. The Ring exception in section 4 uses this same check, not Item Conservation or a second chance.

### Negation

Validate the eligible hostile action and original target before any new check or existing defensive expenditure. Snapshot the defending owner's active protection at that action's resolution, before it can remove its own funding soulmate. Resolve once. A successful check blocks the action, preserves Mirror Shield and armed Crown, and normally spends the attack source subject to the attacker's Item Conservation. A failed check proceeds through that item's existing defenses without broadening their scope.

| Action | Negation resolution and blocked result |
| --- | --- |
| Master Key / Pickpocket's Hook | After selecting and validating the hostile target, before Shield/Crown; no transfer on success |
| Opposing Cupid's Misfire | At the married selection, before Shield; exhaust Misfire but prevent divorce, then retain ordinary escape behavior |
| Severed Fate | At validated confirmation, before defenses; no divorce |
| Heart for a Heart | At validated confirmation, before defenses; neither the hostile divorce nor actor sacrifice occurs |
| Hostage Note | At validated challenge opening, before Shield/Crown; stop the whole challenge and normally charge Note; no new check at its later exchange/gamble |
| Siren's Call | At validated activation, before Crown; normally charge Siren but create no escape; later escape marriage never gets another check |

Exclude ordinary escape marriages, Kaimetsu, Grand Masquerade/mass effects, soulbind removal, voluntary sacrifices as such, and consensual transfers. Redirecting to a Crown decoy is not a second attack or second Negation check. A stale target fails validation rather than following a changed owner.

Legacy Key/Hook paths currently check Shield too early in some invalid-target cases. Integration must validate first, as accepted, rather than insert a random roll into that unsafe order. An invalid target cannot spend defenses just to reach the new check. No universal defense hook currently covers every eligible action; use one shared Negation decision interface from explicit, validated action seams, not a blanket hook on every ownership deletion.

### Item Conservation

One check per eligible **inventory use-charge expenditure**, using the user's active chance at valid effect commitment, immediately before consequences. Save the snapshot/result with the action before effect order can remove that user's soulmate. Do not check when a menu merely opens or a charge is held.

Covered paths include successful/blocked manual uses, confirmed item-action source charges, Whistle after successful automatic reclaim, Shield at a valid block, Chit at activation, Double or Nothing on Gamble, Lens's committed use, Recast's first private presentation, Binoculars' secret-answer use, and Crown activation. Preserve one charge only: no copy, older charge restoration, or lifetime refresh.

Exclude whole-entry ingredients, replacement discards, sacrifices, transfers, expiry deletion, and later consumption of funded buffs/armed effects. Passport's targeting counters, Misfire exhaustion, and armed Crown redirection get no further check. Claim Conservation's explicit Ring exception remains separate.

For held/delayed uses, store the check at the logical commitment point and debit only where the existing lifecycle requires payment. Lens's provisional debit/refund and Hostage's confirmed-delivery cost must track **actual debited amount**, which can be zero after conservation. Recovery/refund may restore only that debit and its original expiry; it cannot invent a charge after a conserved use. Recast arming only holds a charge; the check belongs to its first presented choice, never reopening it. A conserved but now-expired entry remains expired; conservation is not a lifetime extension.

Binoculars is another delayed charge path, not a passive-counter expenditure. Save its use eligibility/conservation decision when the validated secret-answer invocation commits before the DM attempt, alongside the existing reserved source. A definite failed DM releases the hold without a charge; confirmed delivery settles the source with the saved zero/one debit. If delivery is ambiguous after interruption, preserve the existing charge-once/no-secret-resend recovery policy, but settle using that same saved conservation decision rather than sampling the recovery-time soulmate. Settlement atomically releases the hold, applies the saved zero/one debit, and records the existing session-use/terminal result; concurrent or repeated settlement returns that result. Pre-feature pending Binoculars without saved eligibility retain their existing settlement behavior, with no reconstructed conservation chance. Never resend a secret or turn a failed presentation into an extra charge refund.

Do not add randomness to the low-level generic inventory decrement/remove functions: those also serve excluded ingredients/discards and lack semantic source identity. A shared semantic use-charge operation must receive a validated durable event/cost identity and the already-captured chance. This localizes conservation while keeping exclusions explicit.

### Fortune's Favor and Echo

Initial sources are vault and Consolation Chit random item rewards only. Explicitly exclude all affection milestones, crafting, gifts, trades, fixed grants, and bonus copies.

Freeze eligibility/chances at vault A/B/C selection, or genuine Chit activation. Keep the source's captured item definitions/pools with its reward terms; do not use a new pool or new perk percentage during overflow/recovery. Existing Lens/gamble/Recast choices finish first. Then:

1. If there is no earned item (lost gamble), there is nothing to upgrade or duplicate.
2. Favor checks once. Common may become Rare, Rare Epic, Epic Legendary. Select uniformly from the eligible next-tier definitions captured for this reward. If that tier is empty, keep the original. Legendary and ??? stay unchanged.
3. Echo independently checks once and creates at most one extra copy of that **final** item, including an unchanged Legendary/??? result. Do not recurse or run Favor on the extra copy.
4. Deliver original and bonus as independently identified copies. With one free slot, acquire one and keep the other pending. Declining one never removes the other. Each copy gets its own acquisition-time expiry.

Do not apply Favor before a gamble to change gamble eligibility, expose post-selection upgrades through Lens, or let a newly armed Recast attach to overflow. Chit still bypasses Lens/gamble/Recast. Extend its integrity validator to distinguish saved original, post-Favor outcome, and optional Echo child; its current original-equals-final invariant cannot remain unchanged.

## 6. Milestone item delivery and missing pools

Create one permanent milestone entitlement for `(guild, player, character, milestone key)` in the same transaction that raises affection. Fixed grants capture their defined item and configured starting charges. Random grants select uniformly among the earned rarity's resolved reward-eligible kinds, snapshot the definition/charges, and freeze the result.

If that rarity has no eligible items, store an **owed, not-yet-selected** entitlement. Do not downgrade it, lose it, block affection progression, or generate a fake inventory entry. Retry selection with the then-current eligible tier when the owner opens their own affection overview/detail or later earns affection. At cap, profile access still works. Public profile viewers do not select or deliver another user's entitlements. No background poller or new compensation resource.

After selection, use existing direct item insertion and the current pending-item accept/replace/decline dialog. A tier debt and a selected full-inventory item are distinct stored states, but not different progression systems. Recover each pending copy without reselecting it. Acquire what fits; retain the rest. Each inventory entry occupies its normal slot, uses its own normal charges, and establishes guild discovery only on acquisition. Its lifetime starts at insertion using existing acquisition-time expiry policy, not when the milestone was earned.

Decline is terminal for that entitlement. Ownership loss, switching, reacquisition, multiple cards, a bot restart, or source-record cleanup never creates another payout. Existing inventory replacement remains transactional; do not discard an old entry unless the selected reward is inserted successfully.

## 7. Engineering design and durable state

### Options

| Option | Advantage | Why not selected |
| --- | --- | --- |
| Add affection counters/randomness independently in each command/item | Small first patch | Duplicates ownership, snapshots, replay protection and cost policy; misses automatic/administrative writers |
| Build a generic event-sourcing/reward engine | Broad abstraction | Unnecessary rewrite; introduces another scheduler/delivery system and makes existing item/mystery behavior harder to preserve |
| Add a focused affection module and shared semantic perk decisions; extend current reward/runtime seams | Reuses current durable state and UI, keeps rules local | Requires deliberate integration at several real event seams and exact-schema upgrade work |

**Recommendation: option 3.** Use deep modules with a small transactional interface; callers provide event identity and validated context, not individual threshold math or SQL updates. Pure calculations accept snapshots and injected random draws; existing adapters provide SQLite/catalog/Discord behavior. No new provider, queue, or framework.

### Proposed modules and responsibilities

Names identify intended locality, not an implementation task list:

- `lib/characterAffection.js`: relationship progress, selection/confirmation, effective benefits, event/pair application, crossed milestone entitlements, and profile projections. Own the 2,100 clamp, thresholds and replay invariants here rather than in commands.
- `lib/affectionRules.js`: immutable accepted initial-release reward/percentage definitions and matching calculations. This release need not build a configurable track editor or additional portal page. Continue honoring existing item rules, rarity eligibility, schedules, capacities, and expiry configuration.
- `lib/affectionSchema.js` plus a bounded startup upgrade: authoritative DDL/validation for the additive feature state.
- Existing roll, marriage, item-action, vault reward, and delivery modules remain the transaction owners. They call focused transaction-neutral operations to capture eligibility, decide a semantic perk once, earn an appearance/reclaim award, or deliver a milestone. Do not nest new `BEGIN` calls inside their write transactions.
- New prefix commands and a small standard-rich-embed renderer consume profile/selection results; legacy Action Rows can provide paging/confirmation, while existing Components V2 roll/reward views remain where useful. Renderers never implement payout SQL or reroll an effect to render a message.

Conceptually, the affection interface exposes current benefit reads, capture of a roll context, earning its saved appearance/reclaim award, confirmation of a soulmate choice, and retry of owed owner rewards. A shared semantic perk-decision interface returns a stored result for a stable event/effect/subject identity, with a chance/context version. It does not accept arbitrary user-supplied chance or reward data.

### Proposed persisted records

Exact column names belong to the implementation plan, but these state distinctions and uniqueness constraints are required:

| Record | Required identity and contents |
| --- | --- |
| Affection schema marker | Feature version plus activation/capture version; separate from catalog character IDs |
| Relationship progress | Primary key guild/player/character; integer total 0–2,100; no ownership cascade |
| Player soulmate state | Primary key guild/player; nullable selected character; selected-at/switch deadline and confirmation version sufficient for stale-menu rejection |
| Accepted roll context | Stable guild/command source key; roller, original roll reference, outcome kind, saved ownership/matching/perk eligibility, rule version and presentation/cancellation state |
| Award receipt | Unique logical roll source/player/target-character; qualifying base and credited result, Bond decision/context and resulting progress; survives roll cleanup |
| Semantic perk/use receipt | Unique logical source/effect/subject/cost ordinal; captured chance, outcome including negative/no-perk, and committed cost/result linkage |
| Milestone entitlement | Unique guild/player/character/milestone key; earned rarity or fixed item, owed/selected/settled state, frozen outcome, and durable existing reward-row linkage |
| Reward copy linkage | Parent reward, copy ordinal, final frozen item, direct provenance, independent acquisition/overflow/decline settlement |

Keep these as a small feature schema and extensions to existing reward accounting, not a generic append-only history of all gameplay. Logical records can combine where their lifecycle/uniqueness matches. Do not duplicate current inventory or vault sessions. Index relationship owner reads, selected-character invalidation, pending owner entitlements, and source/pair/copy lookups.

Use canonical UUID foreign keys to `character_identities` for saved relationships, not transient rank or ownership rows. Persist enough context to render/validate a saved result without its live roll. Do not cascade receipts or milestone keys on roll deletion; only normal presentation data follows existing cleanup. Permanent minimal receipt/settlement evidence must survive source presentation cleanup, even if larger terminal snapshots are later compacted. No destructive compaction is required in the first implementation.

### Event identities, transactions, and random outcomes

Use existing immutable source identities: guild plus command message ID for accepted rolls; durable item action/invocation IDs for manual actions; mystery/reward IDs for Chit; parent reward plus copy ordinal for Echo; the source escape key for reclaim. Neither inventory ID alone, marriage row ID, Discord card ID, remaining charges, nor player/character alone identifies a unique use.

A conserved source item can be used legitimately again, so its next explicit invocation needs a different action ID even though charges did not change. Replayed interactions retain their original invocation. Persist and consult terminal invocation receipts **before** repeating an effect or rejecting solely because its source inventory entry was already spent. Consolidate legacy direct activation paths that do not yet have a replay-safe invocation receipt; do not make conservation itself a retry loop.

Within the caller's synchronous SQLite write transaction:

1. Resolve the stable invocation identity and validate immutable actor/guild/source scope.
2. Before consulting mutable inventory or target ownership, return a matching committed receipt for a duplicate, including a previously negative perk decision. A scope-conflicting/corrupt receipt is an error, not permission to execute again.
3. Only for an uncommitted invocation, revalidate current availability and authoritative ownership, then capture pre-consequence eligibility and the rule version.
4. Make and save each allowed random decision once, using a distinct effect identity. Perform mutation and actual cost accounting atomically.
5. For earned affection, group by relationship and apply the highest qualifying category without category addition; record the receipt, clamp progress, and create all newly crossed item entitlements atomically.
6. Commit, then perform Discord I/O. Follow-up acknowledgements/recovery may finalize the saved presentation/award/delivery, never reselect or reroll.

Resolve all simultaneous appearance qualifiers before creating the appearance source/pair award receipt. Own-character terminal appearances cannot later be escape reclaims. Owner reclaims award the retaining owner; a newly marked ordinary roll also awards the roller's current eligible soulmate. Each relationship can receive at most one appearance award and one separately keyed reclaim award from an originating roll. The owner and roller share the canonical reclaim source but have distinct user/character pairs. Duplicate reactions cannot reopen the successful transition or add another Bond check. Presentation may combine these permanent receipts without merging their earning identities.

No Discord call runs while holding the write transaction. Propagate transaction-neutral operations to automatic paths, including Whistle and Chit, rather than duplicating award logic in command/render handlers.

### Reliable ownership invalidation

The existing ownership-history triggers already cover marriage `DELETE` and owner/guild/character-changing `UPDATE` using portable SQL. Add corresponding focused selection-invalidation triggers to clear only the old owner's matching soulmate selection. Do not delete progress, deadlines, or entitlements. This covers item direct SQL, gifts/trades, escapes, sacrifices, mass effects, and administrative connections without relying on a JS callback at every writer.

Continue deriving normal bonuses with current-ownership joins, so the same mutation removes them without a cached counter becoming stale. A transfer can keep the marriage row ID; validate owner and character as well as ID. This feature does not redesign every game's existing ownership-tenure semantics. Application transactions still recheck active benefits; raw SQL triggers do not calculate probability or create rewards.

## 8. Roll outcomes and recovery integration

Add an explicit own-character appearance outcome to the existing roll terms and validators. It is a nonclaimable, nonescape result, not a fake successful reclaim. Preserve character card/report controls and applicable selection-item counters. Do not create an owner heart action or allow someone else to marry from this card.

Soulbound exclusion becomes owner-aware in the common eligibility relation, including item-filter fallback pools: its current owner may roll it, others may not. Ownership at selection determines the own-appearance candidate and saved snapshot. Skip Misfire on own-character selections without consuming the armed effect. For other owners, validate, apply Negation before current defenses, consume Misfire as specified, and save its outcome. Validators/renderers must accept the new `negated` outcome as well as existing blocked/divorced results without relaxing unrelated identity checks.

Integrate appearance earning in the committed publication/reveal paths rather than after a best-effort card edit. Add recoverable acknowledgement of unclaimable/terminal mystery reveals so a crash cannot silently lose an owed affection award while the mystery gameplay result remains final. Do not reopen an expired claim, replay a minigame, or award from its intro. Current durable paid-reservation handling remains the source of truth for costs/windows.

For canceled or failed-to-present appearances, close or retain the new eligibility record consistently with the current roll's actual lifecycle. Do not delete pending award/reveal evidence while presentation remains recoverable. For reclaims, apply progress in the shared `claimRollInTransaction` successful-owner branch before commit. Automatic Whistle captures its Item Conservation chance **before the reclaim and its affection/milestone consequences**, then spends or conserves the charge using that saved chance and the same parent reclaim identity. A perk newly unlocked by the reclaim cannot conserve the Whistle that produced it.

## 9. Reward-delivery integration

Extend `vaultRewards.js`/current reward provenance to describe milestone deliveries and one optional Echo child. Retain existing public functions/UI behavior where possible. Use a durable reward-grant/parent linkage with copy ordinals so source uniqueness does not confuse one grant with its two copies: existing `reward_sources` permits only one row per `(source_kind, source_id)`, so two Echo delivery rows cannot simply reuse that key. The parent vault alone owns Lens/gamble/Recast decisions; a child is already final, not a second vault.

Use the existing delivery row model per final copy, linked to the parent and copy ordinal; each has independent overflow/decline state. Do not encode two acquired copies in a single one-item `delivered` flag. When one slot is available, deliver ordinal zero first and leave the child pending. Multiple milestone entitlements also each get a distinct delivery identity, with existing UI reused for each owed selected copy.

Existing `reward_sources` currently accepts Chit-specific provenance and a uniqueness contract for one source. Extend that validation to explicit recognized milestone/Echo kinds and stable scoped source IDs; never treat an unknown source as an ordinary vault. Preserve both pre-perk vault/Recast decision evidence and post-perk final items: the current Fortune validator's equality between a Recast selection and delivered reward cannot survive a Favor upgrade unchanged. Update Fortune/Chit publication/integrity checks and runtime guards alongside the new lineage. Preserve discovery masking and reveal-before-item-announcement rules; Chit cannot announce its item before its character reveal acknowledgement.

Check capacity after actual source charges are spent or conserved, including Chit/Lens/Recast. Conservation can keep a slot occupied that would otherwise be freed. This is a legitimate overflow outcome, not a reason to discard the bonus or debit a conserved charge anyway.

## 10. Schema, launch, and operational safety

Current production format is authoritative **catalog v12** with exact schema-object/row validation and separate additive feature markers. Follow that established extension pattern: add an affection feature marker/version rather than changing character identities or casually bumping `user_version` and breaking v12 runtime dispatch.

- Capture the exact current pre-affection v12 definition as an accepted predecessor. Extend fresh final-schema DDL and exact validation to include affection state, receipt/copy lineage, indexes and triggers.
- Extend the existing bounded upgrade chain so known older Fortune/expiry/Phase-2-item/gender predecessors can advance through their **exact** intermediate definitions, then apply the affection extension. Preserve the historical definitions explicitly: they are currently derived by removing feature DDL from the final template, so blindly appending affection objects would otherwise alter predecessor recognition. Marker presence alone never proves validity; refuse partial/unknown/malformed mixtures.
- Own one `BEGIN IMMEDIATE` upgrade transaction, recheck under the lock, and use the existing bounded SQLite busy-timeout approach for simultaneous bot/portal starts. Do not roll back a caller-owned transaction. A rollback-only rehearsal must leave the source unchanged.
- Fresh creation, writable open, read-only open, offline conversion/rehearsal, schema inventory, and startup recovery guards must agree. Read-only access must never install state; recognized pre-affection databases receive an actionable upgrade-required error. Preserve the existing supported legacy tooling rather than running affection against legacy integer-ID catalogs.
- Empty new feature tables mean zero progress; do not backfill players. Existing old pending events without the required eligibility snapshots stay under old behavior for those missing-snapshot effects. Independent post-launch actions such as a new reclaim still use their own valid snapshot.
- Preserve existing ownership, wishes, catalog ranks/tags/aliases, inventories/expiry, armed effects, pending rewards, claim/roll usage, report lifetimes and runtime recovery obligations. Do not change active source settings or clear pending events to simplify migration.
- Extend startup inspection to validate new pending contexts, source scopes, reward lineage and owed states. Corrupt versioned feature state must be reported for inspection rather than interpreted as legacy or rerolled. Unselected tier debt is valid pending work, not a maintenance blocker by itself.

No production migration, SSH session, database copy, service restart, or rollout is part of this documentation phase. Future deployment needs a fresh consistent SQLite backup including WAL, coordinated bot/portal code, a rehearsed upgrade, and explicit authorization. An old executable's exact-schema guard may reject the upgraded database: rollback requires a verified compatible code/database pair, not manual deletion of feature tables or receipt evidence.

## 11. Commands and presentation contract

Use the dynamic guild prefix; `!` below is only an example.

| Command | Behavior |
| --- | --- |
| `!affection` / `!aff` | Own affection overview, current soulmate, effective capped bonuses, and owed/pending items |
| `!affection @player` | That player's server-scoped overview, read-only |
| `!affection <name or #rank> [@player]` | Detailed saved relationship progress; defaults to caller |
| `!soulmate` / `!sm` | Current soulmate/status or clear guidance if none |
| `!soulmate <name or #rank>` | Caller-only lookup, ambiguity chooser, then explicit confirm/cancel |

Reuse `findCharacters`/the existing character index, including curated aliases, and existing player-target parsing. A rank is resolved at command time to a canonical ID; later rank changes never move a confirmation to another character. Support the exact accepted name/#rank grammar without inventing new aliases, slash commands, or a second selection resource.

Selection confirmation shows candidate, saved affection, checkpoint perks, and the 12-hour cooldown; final mutation revalidates actor, guild, candidate identity, ownership, busy state, cooldown, and the expected prior selection. Prevent two stale confirmations from silently overwriting each other. Existing Components V2 chooser/confirmation patterns supply the UI; exact collector lifetimes can reuse current controls rules.

Public affection profiles distinguish current ownership, former ownership/saved progress, and active soulmate. The active `soulmate` reply omits the redundant "Currently owned" wording, since it already represents a selected, owned character. Non-soulmate single-character cards hide inactive soulmate-perk lists and activation explanations for brevity; active soulmate cards retain all active-perk descriptions. Explicitly mark former ownership and inactive normal bonuses rather than implying saved progress grants current benefits. Public navigation cannot select rewards, run another user's owed-item retry, confirm a selection, or invoke inventory mutation.

Compact card feedback identifies awarded affection and relationship; milestone notices identify newly crossed rewards. Show the actual credited delta at cap, not discarded points as if saved. Render saved committed effects instead of drawing random chances again. Perk outcomes may be included in the existing action/result feedback; do not add a separate message per ordinary perk failure.

**Initial visual scope — compact next-reward meter:** show the relationship's affection total, a compact progress meter toward the next reward, and that reward's label/required total. Do not build a paged reward path, full roadmap, or separate level/XP display. Retain the accepted ownership labels, active-perk/bonus summary, and pending-item information; the meter is the progression visualization, not a replacement for that status information. Detailed styling can be refined later without introducing a second progress system. At the affection cap, show that all current rewards are unlocked rather than an unreachable next target.

### Selected `soulmate` reply layout

The user selected the compact Option 3 from [affection-display-proposals.md](./affection-display-proposals.md), with no "Currently owned" wording, an always-visible active-perk description list, and no bottom perk-count line. Remove the show/hide button; no reward-path controls.

A standard rich embed is recommended for this simple layout and the requested non-square character thumbnail. The user approved warm gold `0xF2C66D` as the distinct active-soulmate accent, while regular affection cards retain pink `0xe91e63`. Apply the special accent to the active soulmate whether reached through `soulmate` or character-detail `affection`, never to an unselected/former character. Content: author = player's soulmate, title = character name, description = franchise, thumbnail = original character image, fields = affection/meter, next reward(s), active perks, and normal contribution; footer = switching availability and dynamic-prefix affection hint. Do not crop the source portrait into a square. Discord controls displayed thumbnail size; no author-specified image width/height or pixel-identical rendering is promised. This reply needs no message components; if legacy controls are later necessary, they can accompany the embed without `IS_COMPONENTS_V2`. Other existing/new views can retain Components V2 where useful. Validate actual portrait rendering separately during live Discord acceptance.

### `affection` overview presentation refinements

The separate collection overview is illustrated in [affection-overview-proposal.md](./affection-overview-proposal.md). The user requested no visible "highest affection first" wording, a compact heart-icon value such as `♥ 820` in each relationship row instead of `820 affection`, and effective bonuses without cap text in this summary. These are presentation changes only: the agreed +5 hourly-roll and 60-minute claim-reduction caps still apply. Keep ownership/former-state distinctions and compact next-reward meters. The proposed five-row paging/filter details remain subject to confirmation; do not infer approval of unrelated navigation from these refinements. In single-character detail, retain the portrait, heart-icon total, next-normal-reward meter and normal contribution; hide all inactive soulmate-perk detail unless the character is selected, in which case use the active soulmate layout.

## 12. Verification required after implementation approval

Use the existing Node test runner, temporary synthetic SQLite fixtures, injected time/RNG, fake Discord transport, and catalog typecheck. No production data in tests. The implementation plan should map the following acceptance matrix to focused fixtures and the full regression suite.

### Progress, matching, and ownership

- Guild/player/character isolation; rank/source changes preserve identity; zero start/no backfill; cap/discarded excess; every crossed milestone exactly once, including 100/200-point jumps.
- Direct vs related award precedence and two distinct relationship awards on one roll; no genre or missing-metadata awards on new rolls; compatibility with saved version 1 awards; all three franchise boundaries; multiple memberships use the minimum; published/manual distinct counts; no available-pool/Passport denominator exploit.
- Saved eligibility survives switches/loss but never redirects; canceled/unacknowledged appearances do not earn; reveal after loss/unclaimable outcome does; failed/repeated presentation and roll cleanup cannot duplicate progress or payouts.
- Selection confirmation ownership/busy/cooldown/stale checks; ownership loss bypass/replacement starts new cooldown; no auto-reselection; raw DELETE and owner-changing UPDATE clear matching selections atomically; normal passives stop/resume, payouts never replay.
- No repeat-character/daily affection limiter; separate legitimate invocations count even if an item charge is conserved.

### Perks and quotas

- Every checkpoint transition and nonadditive replacement; only active owned soulmate; pre-event eligibility prevents same-event unlock boosts; independent effects with controlled distinct draws; positive/negative/no-perk results persist.
- Windfall across every paid-result branch, zero-allowance guard before Fever, failed/retried delivery, period boundary, two consecutive free requests, no bonus/automatic request, no effect on item-funded actions.
- Capacity cap, Rush ordering, usage retained on benefit loss, consistent daily/status/refill output; fixed claim reset boundaries and timestamp behavior; resource precedence; affection/Ring nonstacking; Chit availability; conserved normal/token/free claims; final Ring-use preservation exception and unchanged expiry.
- Negation across the explicit attack table, validation before defense cost, soulbind/protection exclusions, Crown redirection once, defending soulmate targeted, actor conservation on blocked charge, Heart no sacrifice, Hostage opening only, Siren no escape, Misfire exhaustion vs own-character skip, mass/unbinding/ordinary escape exclusions.
- Conservation on every semantic source-charge path, prepaid/ingredient/discard exclusions, source-soulmate sacrifice snapshot, held/expired sources, no-effective-benefit successful uses, Lens provisional refund, Hostage unstarted cancellation, Recast reopen/recovery, Binoculars definite-failure versus ambiguous-DM recovery, and capacity after actual zero/one cost. Never manufacture a refunded charge.
- Favor next-tier uniform selection, cap/empty tier, before Echo/after existing vault decisions; lost gamble; final duplicate including unchanged top tiers; source eligibility; selection-time snapshot; old pending rewards; Chit integrity/reveal gate; separate copy lifetimes/declines/restarts.

### Rewards, commands, and operations

- All normal table thresholds, exact once-per-pair items and charges, random rarity eligibility/snapshot, owed empty-tier recovery through owner events/profile including cap, no mutation via public viewing, selected outcome fixed across config changes, acquisition-only expiry/discovery, independent full-inventory delivery and current pending dialog authorization.
- Dynamic prefix and aliases, #rank/name/curated aliases/disambiguation, optional target player, no slash registration, public ownership labels, same-soulmate no-op, canceled/timed-out/stale confirmation, mention suppression, Components V2 payload limits, and existing report controls. Compact meter and next-reward label must agree with saved affection at threshold crossings and the cap; no paged reward-path UI.
- Fresh schema and every recognized upgrade predecessor, rollback-only rehearsal, row/object validation, concurrent first opens, read-only refusal, foreign keys, source/copy uniqueness, loss triggers, legacy pending transition, corrupt feature-state reporting, upgrade failure rollback, and cleanup retention of permanent payout/receipt evidence.
- Run focused suites, `npm test`, `npm run typecheck:catalog`, and `git diff --check` under the project's supported Node version. Report actual results; live Discord rendering/notifications and deployment remain separate acceptance work. No tests have been run for this design document alone.

## 13. Author self-review and approval gate

**Author self-review complete; accepted by the user as the phase-3 planning basis, not authorization to implement.** Reviewed the entire document against the final brainstorm, glossary, project conventions, and current source. Two independent local read-only architecture investigations and two read-only document reviews informed this review; they authorized no product changes.

Resolved findings and design hazards:

- Receipt-first recovery: immutable invocation scope is checked first, then an existing committed result is returned **before** mutable inventory/ownership validation. A spent last charge or transferred target cannot make a completed invocation execute again or appear to have failed.
- Binoculars: explicitly capture its conservation decision before the secret DM attempt and reuse it for both successful delivery and ambiguous-interruption recovery. Definite failures release the hold without charging, and missing pre-feature snapshots retain old settlement behavior. No secret resends or invented refunds.
- Whistle: capture conservation chance before reclaim affection unlocks; newly earned perks cannot pay for their triggering automatic use.
- Presentation: initial cancellation prevents earning, but later claim/escape cancellation cannot claw back affection already validly credited. Mystery reveal acknowledgement is independent of winner/claimability.
- Rewards: preserve pre-perk gamble/Recast evidence separately from post-Favor final items, update Chit/Fortune validators, and separate grant-source identity from independent copy delivery identity.
- Schema: retain authoritative v12 and exact historical predecessor definitions rather than accidentally modifying predecessor signatures when extending final DDL. Loss triggers retain relationship/payout records and invalidate selection across direct SQL writers.
- Final rules checked explicitly: franchise 12/10/5 minimum among shared matches, no-genre exception, first Windfall 100/8%, both accepted tables, 2,100 cap, all crossed rewards, owner-only soulbound rolls, source-charge-only Item Conservation, and Claim Conservation's same-check Ring-use exception.

Documentation checks passed: accepted threshold sequences match **23 normal milestones** and **21 soulmate checkpoints**, including four Legendary and eight late Epic payouts; local Markdown links resolve; `git diff --check` is clean. No gameplay tests or typecheck were run during the documentation-only phase. Subsequent implementation verification is recorded in affection-validation.md; no production database or service was touched during implementation.

No known unresolved mechanics decision blocks reviewing this proposal. Following review, the user selected the compact next-reward meter without a paged reward path, then selected Option 3's compact layout with always-visible perks, no ownership label in the active soulmate reply, and no perk-count/show-hide controls. A standard rich embed is recommended for the original portrait thumbnail; final native rendering remains subject to Discord acceptance. These presentation scope updates change neither reward table nor mechanics. The user subsequently approved warm gold `0xF2C66D` and requested `/plan`, authorizing the phase-3 implementation plan in [affection-plan.md](./affection-plan.md). The user subsequently authorized implementation, validation, feature commits and a PR. That does not authorize live deployment or production DB/service actions.
