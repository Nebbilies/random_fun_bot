# Fortune items — Phase 1 design proposal

Status: Design proposal approved by the user. Implementation plan awaiting approval; no production implementation yet.

## Scope

Implement Fortune's Lens and Fortune's Recast (Rare, reward-eligible), plus an extensible discovery-aware item-release changelog in the existing prefix `itemlist` command. Do not implement phases 2 or 3. No commits without explicit permission. Preserve unrelated local work.

Use the engineering framework, with approval gates after this proposal and the implementation plan. Implementation is test-first; verification follows.

## Agreed behavior

### Fortune's Lens

- Default one charge per inventory entry, validated and configurable through the portal.
- An owner-only Use Fortune's Lens control targets one live unopened vault in the correct server. Reject stale/expired/unauthorized interactions without cost.
- Allow one activation per vault. Atomically save three independently drawn slot outcomes and consume one charge before publishing the reveal. Duplicate items across slots are allowed.
- Draw using the vault's captured normal tier weights and reward-eligible roster. Publish all three outcomes on the public vault card; existing A/B/C controls select exactly one persisted outcome.
- Never redraw on duplicate clicks, delivery retries, or restart. Unchosen outcomes are discarded.
- Revealing candidates does not establish guild item discovery.
- Preserve the original vault expiry. If the reveal was successfully displayed, timeout does not refund the item. If it was never successfully displayed before expiry, restore the consumed charge exactly once. Restore a consumed entry if necessary, without treating it as an unrelated new reward; recovery must preserve charges if other copies or charges were used in the meantime.

### Fortune's Recast

- Rare, reward-eligible, default one configurable charge per entry.
- Arm through the existing prefix use flow before the qualifying vault reward. One armed effect per owner/server; repeated activation must not spend additional copies while already armed.
- Armed state has no expiry and survives restart. Apply to the first eligible reward the owner resolves after activation, not whichever vault was created first.
- Order: Lens (if used) -> slot selection -> Double or Nothing (if applicable) -> Recast -> inventory delivery/overflow.
- If Double or Nothing loses, leave Recast armed and unspent. If it wins, Recast uses the final upgraded reward's tier. Never offer a second gamble after Recast.
- Before inventory delivery, privately offer Keep or a choice of up to three distinct alternatives from the final reward's captured same-tier reward-eligible pool, excluding the original item definition.
- Alternatives may already be owned and may include Recast itself. Newly acquired items cannot activate themselves during this reward flow.
- If one or two alternatives exist, show all; if none exist, keep the original and leave Recast armed.
- Consume the armed charge when the choice prompt is presented, not at initial arming. Hold its source entry/charge unavailable for conflicting use while armed, so the promised charge cannot disappear before consumption. Reservation must respect inventory and replacement rules.
- Reuse the configurable vault item-decision duration. Timeout keeps the original. Persist original reward, alternatives, captured terms, deadline, presentation state, terminal choice, and delivery linkage.
- After selection, use existing durable replace-or-decline overflow handling. Delivery retries cannot reroll, charge twice, or award twice.

### Item-release changelog

- Display only the latest maintained item-release entry in itemlist. No automatic releases from arbitrary catalog edits.
- A release entry has a fixed release date and added item IDs. Format its date as DD/MM/YYYY; do not calculate a new date on each command.
- Derive names, counts, and rarity grouping from those entries. Support future single-item and mixed-rarity releases, not only this pair.
- Apply permanent guild-wide discovery masking independently to each name; undiscovered names display as **???**.
- Initial wording: **Changelog DD/MM/YYYY**: Added **two** new *Rare* items: **???** and **???**.
- Keep the announcement visible independently of the current catalog rarity filter; navigation refreshes discovery as the current itemlist does.
- Use the actual release date when preparing the release; the handoff filename is not authority for a release date.

## Snapshot and compatibility policy

- Preserve the existing reservation-time snapshot policy: capture reward pools, weights, and relevant rules when a vault is created, not on each interaction. Include same-tier Recast pools for every supported tier.
- Old vault sessions continue under their old rules without Fortune behavior. Recast remains armed until an eligible new session resolves.
- Do not alter normal vault tier odds, roll allowances, claim rules, or other item mechanics.
- Durable changes must be coordinated with authoritative schema, upgrade tooling, restart validation, and recovery. Normal startup must not silently repair a final-schema database.

## Recommended architecture and alternatives

Extend the existing durable vault session/reward boundary rather than implement a separate in-memory Fortune flow. Reuse inventory transactions, scope/message-binding checks, Components V2, configuration registry, and overflow delivery.

Rejected alternatives:
- Memory-only candidates/armed state: breaks restart and exactly-once guarantees.
- Drawing Lens rewards on each click: permits rerolls and makes previews unreliable.
- Delivering first and recasting inventory afterward: bypasses the agreed decision order and complicates overflow and acquisition history.
- Hardcoded changelog sentence: cannot support future releases or mixed rarities.

Private Recast presentation requires durable canonical message binding and recoverable delivery; private prompts must not depend solely on an expired Discord interaction token. The implementation plan must select a feasible delivery route and make failure handling explicit before coding.

## Risks and self-review

- Discord publication and SQLite commits cannot form one atomic transaction. A successful send followed by a crash before acknowledgement creates an uncertain-delivery boundary. Persist delivery intent and reconcile a canonical message where possible; do not promise stronger delivery guarantees than Discord supports. Exact handling belongs in the implementation plan.
- Arming without spending still requires reserving the source charge. Avoid item loss or double availability during replacement, transfers, and restart.
- Lens refunds can encounter a full inventory or a missing source entry. Preserve the player's item without silently deleting another entry; specify durable restoration behavior in planning.
- Recast happens after Double or Nothing, so it can substitute upgraded Epic/Legendary rewards. This is intentional and user-approved, not a bug.
- Existing saved snapshots may lack new settings or all-tier pools. Version/gate new behavior instead of guessing.
- Existing multiword item query parsing needs inspection for usable Fortune item IDs/aliases.

Self-review result: gameplay order, costs, discovery, restart durability, and phase boundaries are consistent with the approved answers. Delivery ambiguity, charge reservation, and refund restoration need explicit technical solutions in the implementation plan. No implementation or tests performed for this proposal.
