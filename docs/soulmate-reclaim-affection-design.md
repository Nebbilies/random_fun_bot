# Soulmate affection from another owner's reclaim

Status: Phase 2 design and Phase 3 implementation plan approved by the user on 2026-11-06. Implementation and verification completed on `feat/soulmate-reclaim-affection`, with test-first schema, earning, and presentation/delivery stages. The user authorized commits, branch publication, and PR creation for review; merge and production deployment remain pending. See the extension verification record in [affection-validation.md](affection-validation.md).

## Purpose and scope

When a player rolls another player's owned character and that owner successfully reclaims it, grant the roller's current, owned soulmate **8 base affection**. This creates a regular affection source that does not require a franchise match.

The existing 2,100 affection cap, normal milestones, soulmate checkpoints, ownership rules, roll selection, gameplay odds, resource costs, escape deadlines, and six-second item reveals remain in force. Reuse the existing SQLite transaction, affection receipts, milestone entitlements, reward delivery, and card formatting. Add no dependencies or parallel reward subsystem.

This proposal extends the earning rules in [affection-design.md](affection-design.md). Its separate reclaim bonus is an explicit exception to the older prohibition on additional award categories for one originating roll. Existing appearance categories still use their original precedence and saved eligibility.

## Confirmed product rules

| Situation | Result |
| --- | --- |
| Another owner manually reclaims a character the player rolled | Owner receives the existing 20 base affection; roller's eligible soulmate receives 8 base affection |
| Golden Whistle completes that reclaim automatically | Same affection rules as a manual reclaim |
| Rolled character shares no franchise with the roller's soulmate | The new 8-point award still qualifies |
| Appearance already awarded franchise affection | The reclaim bonus adds separately; for example, 5 plus 8 gives 13 actual affection before any doubling or cap |
| Roller changes soulmates between appearance and reclaim | The new bonus goes to the selected, owned soulmate at reclaim; earlier appearance affection keeps its original recipient |
| Roller had no soulmate when rolling but selects one before reclaim | The selected, owned soulmate at reclaim qualifies |
| Roller has no selected, owned soulmate when reclaim resolves | No roller bonus; owner reclaim and owner affection proceed normally |
| Roller’s Unbroken Bond triggers | Double the new base award from 8 to 16, subject to the existing total cap |
| Siren's Call creates the escape | No new roller bonus; existing owner reclaim affection remains available |
| Roll predates feature activation | No new roller bonus, including when reclaimed after activation |
| Escape expires, is canceled, or another player acquires the character | No new roller bonus |

Only a successful owner reclaim qualifies. Rolling one's own character continues to grant its existing appearance affection without an escape or reclaim. No historical backfill, new daily cap, or additional reward for someone other than the actual roller is introduced.

The roughly 12-week completion target applies to typical active-player progression under the observed server activity. It is not a guaranteed deadline for every player, roll pool, or server.

## Recommended engineering choices

| Decision | Options considered | Recommendation |
| --- | --- | --- |
| Roller eligibility | Extend roll-time soulmate snapshots, or read current selection at successful reclaim | Read current selection and perks at reclaim, as confirmed; no new roll-time soulmate snapshot fields |
| Activation boundary | Compare request timestamps with a global activation time, or mark newly reserved rolls | Save a versioned marker on new rolls and their permanent request outcome; eligibility does not depend on wall-clock comparisons |
| Schema compatibility | Advance the global catalog version, or extend the existing exact-shape v12 upgrade path | Extend the existing upgrade path with a narrowly recognized predecessor and a bounded award-table migration |

These choices keep the change within existing ownership, roll, affection, presentation, and catalog lifecycle modules. Technical names for the new marker and helper functions will be settled in Phase 3.

## Durable origin and activation

Newly reserved paid character rolls save a reclaim-bonus version marker in their roll terms and immutable request outcome within the existing reservation transaction. No existing request or roll is marked retroactively. This is the boundary between old and new events, including rolls that were pending during deployment.

Successful reclaim verifies the saved marker and the existing validated paid-request binding. The request identifies the original roller and originating guild/channel; the roller is not inferred from current ownership, the person reacting, or Discord message authorship. The rolled character, saved escape owner, request, delivery, and completed appearance context must agree.

A published roll whose delivery record is still reserved remains a supported recovery boundary. Preserve the existing coordinator's ability to complete its acknowledgement. Validate recorded delivery identity and any saved acknowledgement/message ID, rejecting conflicts without requiring an already-finished acknowledgement for this recoverable state.

An absent marker means the pre-feature earning rules apply. Unsupported marker versions or inconsistent marked-event bindings are errors, rather than permission to guess a recipient. Siren sources remain outside the paid-roll affection envelope. Current mystery selection requires an unowned character, so it does not introduce another owned-character reclaim path.

Previously saved affection JSON versions 1 and 2 retain their existing shapes, validators, and replay semantics. The new bonus does not require adding fields to either snapshot. Appearance affection continues to use its saved snapshot; the new reclaim bonus uses current soulmate eligibility at its own earning event.

## Atomic earning and replay protection

Manual reactions and Golden Whistle already converge on the successful-owner branch of `claimRollInTransaction`. Add the roller award at that shared transition.

Within the existing transaction:

1. Validate the open roll, deadlines, original ownership, and successful owner reclaim using current rules.
2. For a marked paid roll, validate its saved origin and identify the roller. The roller must differ from the reclaiming owner.
3. Read the roller's selected, currently owned soulmate and its current pre-award Unbroken Bond chance. No selected, owned soulmate is a valid no-bonus outcome.
4. Persist the successful reclaim, existing owner affection, new roller affection when eligible, saved perk decisions, and milestone entitlements together.

Keep Discord operations outside the write transaction. Golden Whistle's existing charge/conservation accounting remains in its enclosing transaction, so a failed transaction does not consume a charge independently of the reclaim.

The owner and roller can share the existing canonical reclaim source key: award uniqueness already includes guild, user, and character. Their distinct relationships produce separate permanent receipts. The new bonus therefore remains separate from the original appearance receipt, while existing roll-feedback reads can discover both reclaim recipients.

Apply the new award through the existing affection award logic with base 8 and soulmate checkpoint eligibility enabled. Preserve actual credited amounts at the cap, one-time milestones, pending reward behavior, and retained progress after ownership loss. Perks unlocked by this award cannot enhance the same award.

Resolve eligibility only during the single open-to-reclaimed transition. Duplicate reactions, competing manual/automatic reclaims, and recovery of a committed result cannot reopen that transition, choose a different soulmate, or reroll Bond. Receipt reads precede any mutable reevaluation on a supported replay path. A committed no-bonus result also stays final: selecting a soulmate afterward cannot earn a delayed bonus.

## Database upgrade

The current `affection_awards.base` check accepts only `1, 5, 10, 12, 20, 100`. Add 8 while preserving the meaning and contents of all existing rows.

Use the existing catalog lifecycle upgrade mechanism, retaining catalog `user_version=12` and existing capture versions. Recognize the exact current final-schema predecessor, validate it, acquire the existing first-start write lock, recheck the shape, and rebuild only the award table with the extended check. Preserve its columns, primary key, foreign-key obligations, all receipt values, and any authoritative indexes or related schema objects. Validate the final schema, foreign keys, integrity, and affection state before commit; a failure rolls the migration back.

Fresh databases and the existing supported upgrade/conversion paths must produce the same authoritative new shape. Existing supported pre-affection and other v12 predecessor paths must continue to work. Concurrent bot/portal starts must serialize and recheck under the existing upgrade lock, rather than attempting the same migration twice. Read-only access to an old shape should explain that a writable upgrade is required and must not perform it.

Rehearse on a fresh protected production copy before rollout. Compare existing receipt values and all unrelated tables, and verify startup and recovery. An older binary will reject the new schema and may not support 8-point receipts; rollback must use compatible code. Do not restore an old database after writers resume and discard newer player progress.

## Milestone reward delivery

Return both users' committed award results from reclaim handling. Collect unique affected users and flush their existing affection reward entitlements through the current reward pipeline for both manual and Whistle paths.

The roller's milestone items must be delivered to the roller, even though another user initiated the reclaim. Reuse the saved reward channel and recipient provenance, inventory-choice behavior, durable pending grants, and existing recovery. Keep the current staged item reveals. Pending or failed Discord delivery does not undo earned affection or select a replacement item.

## Compact feedback

Read the saved appearance and reclaim receipts, then group by **player and character** for this originating roll. Sum actual credited affection, retain stable first-occurrence order, and include each milestone/checkpoint once. Preserve underlying receipts individually; grouping is presentation only.

Example: the roller earned 5 franchise affection on appearance and 8 on reclaim, while the owner earned 20:

```text
@Roller · Soulmate Name
❤️ **+13** affection

@Owner
❤️ **+20** affection
```

If the roller switched soulmates between those events, display separate named character groups for the original appearance recipient and the current reclaim recipient. Never combine affection belonging to different characters. The rolled character's name is already on the card and does not need repeating in its own award block; another affected character needs a name to distinguish it.

Append compact unlock lines beneath the relevant group, using existing wording such as `🔓 **+1 hourly roll** unlocked`. A combined 5 plus 8 is not evidence of a Bond proc: derive that label from the underlying award contributions, rather than comparing the combined amount with one receipt's base.

Update the existing escape card. Existing fallback notices for cards without an updater must identify each recipient correctly and use the same grouping. Do not add routine success messages or new mention pings. Preserve existing Whistle announcements and their mention policy. Card edits remain best effort under current behavior; independent feedback-edit retry machinery is outside this change.

## Verification and acceptance

Use focused failing regression tests before production changes in each area:

- Ordinary manual and Whistle reclaims award the correct owner and roller; no franchise match is required.
- Franchise appearance awards stack separately with the bonus. Both recipients can cross milestones in the same transaction.
- Current-at-reclaim selection handles switching, initial selection after rolling, ownership loss, and no active soulmate. Earlier appearance receipts never move.
- Bond is resolved once using the roller's current pre-award chance. Duplicate/recovered reclaims cannot reroll or grant to a replacement soulmate.
- Missing markers preserve old behavior, including pre-feature pending rolls. Siren, expired/canceled rolls, self appearances, and unsuccessful claim attempts do not earn the new bonus.
- Marked malformed bindings fail atomically. A rollback leaves ownership, progress, entitlements, perk decisions, and Whistle charges consistent.
- The 8-point migration preserves prior data, retains supported predecessors, rolls back on failure, and tolerates repeated/concurrent startup. Read-only validation recognizes the upgrade requirement.
- Grouped feedback preserves actual deltas, character separation after a switch, deduplicated unlocks, and accurate Bond labels. Both reward recipients remain correct on manual, Whistle, fallback, and recovery paths.

Run the full test suite, catalog typecheck, and applicable deployment checks after focused tests. Verify no new network lookup or catalog/history scan is added to normal rolling or reclaiming; event work should use the existing indexed source and relationship lookups. Recheck startup and pending reward recovery against a protected current database copy before deployment.

Implementation belongs on `feat/soulmate-reclaim-affection`, preserving unrelated local files. Commit, PR, and deployment actions require their applicable explicit authorization.

## Pacing evidence and limits

The read-only production sample on 2026-11-06 contained 573 saved requests from 20 players: 56 rolled another user's character and 24 were successfully reclaimed. The four busiest players made 271 requests, with 27 foreign-owned appearances and 11 successful reclaims. Counts include zero-affection rolls and players without a soulmate.

At that active-player frequency, 57–60 paid roll capacity daily gives approximately 2.3–2.4 qualifying actions before Windfall savings. With current Bond/Windfall checkpoints, saved capacity manually used, and the modeled median direct/franchise contribution, base 8 estimates approximately 80–84 days from zero to 2,100. Current-at-reclaim eligibility does not change the award size; it avoids withholding a bonus solely because the selection differed at roll time.

Only about eight hours of persistent history were available. Roll pools, reclaim participation, growing ownership, items, extra milestone capacity, and player activity can change actual completion time. This is a provisional balance recommendation, not measured 12-week player telemetry. Detailed evidence is in the local [pacing report](../../soulmate-pacing-20261106/recommendation.html).

## Phase 2 self-review

Passed against the confirmed rules and inspected source paths. Reviewed current-at-reclaim semantics, separate stacking, once-only earning, cap behavior, dual-recipient milestones, Whistle accounting, Siren exclusion, saved activation boundaries, old snapshot replay, schema compatibility, combined feedback after a soulmate switch, and the limited pacing evidence. The subsequently approved Phase 3 plan retains these rules and specifies test-first delivery in three stages.
