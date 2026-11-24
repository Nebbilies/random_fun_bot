# Season design proposal

## Player and operator experience

Each Discord server has its own season. Existing progress becomes Season 0 and remains playable until the first announced rollover. A server with no prior progress starts Season 1 on its first gameplay action.

In portal **Game controls**, an administrator selects a server and sets its announcement channel and target season length. The default target is 30 days from the start of Season 1 or later. The portal shows the target date as a planning aid. An administrator can schedule a rollover at any point, including during Season 0. The preview identifies the server, both season numbers, the announcement channel, the reminder time, and the proposed cutoff. Scheduling requires explicit confirmation of that preview. The portal shows delivery progress, errors, and the last completed rollover.

The bot verifies that the channel belongs to the server and that it can post there before the portal accepts a schedule. The portal and Discord bot run separately. The portal records requests in their shared SQLite database and the bot performs channel checks and message delivery using its existing Discord connection. Reuse the current portal administrator role, request validation, and revision checks. [Portal authentication](portal-authentication.md)

## Trigger and storage choices

| Choice | Effect |
| --- | --- |
| Manual scheduling with an editable target date | Gives the operator control over when the reminder reaches players. Each server can use its own schedule. |
| Fixed automatic rotation after the target date | Makes season length predictable and can schedule a rollover while the community is unavailable. |
| Chance of automatic rollover on a marriage | Makes the end of a season uncertain. It needs a precise coverage definition and tuning for each server. Current gameplay ranks can change on catalog publication, and the last-claim record is a cooldown record. |

Use manual scheduling with a target length for v1. If an automatic rule is considered later, measuring distinct first marriages of characters from a fixed season-start rank list would give a stable signal. The existing server owns 84 of the current top 100, a useful coverage observation with limited timing history. [Production observations](season-brainstorm.md#production-observations)

For storage, use the existing guild-scoped live tables, a persisted season number to separate work across rollovers, and one compact profile summary per player per closed season. A complete copy of each season would preserve more detail and compound the disk growth already visible in gameplay receipts. Rebuilding each card from an event log would require retaining that log and reconstructing past catalog and membership data. Keeping a fixed projection at cutoff preserves the agreed stats directly. Add season identity where in-flight work and retained receipts need it, and preserve the existing live ownership and inventory interfaces. [Archive decision](adr/0001-archive-season-profile-summaries.md)

## Reminder and cutoff

1. **Queued.** Calculate the next claim-window boundary with the existing guild schedule. Plan the public reminder for that boundary and rollover for the following one. The portal accepts cancellation while the reminder remains queued. If a claim schedule change before posting moves either time, refresh the queued times and show them in the portal.
2. **Reminder posted.** Publicly announce the closing season, the exact cutoff, and how to choose a soulmate with the server prefix. Ping the season roster members currently in the server. Use explicit user mentions and split them into batches when needed. Posting the public reminder commits the cutoff. Retry individual missing ping batches and expose the results in the portal. Freeze effective claim schedule changes that would move the cutoff, including inherited changes from global configuration. An immediate portal claim reset has no effect on the scheduled boundary.
3. **Cutoff reached.** The closing guild's gameplay stops writing to that season. Confirm current membership, archive its final profiles, and apply the rollover. If the bot was offline after posting the reminder, apply the overdue rollover before accepting gameplay for that guild. Announce the new season after it commits and retry a failed start announcement.

If the reminder cannot be posted at its scheduled window, move the unannounced rollover to a later claim window so players get the intended notice. Persist delivery and Discord message identifiers so retries and process restarts resume the same work. If a send has an uncertain result, resolve that attempt before posting a different cutoff. The SQLite rollover itself is idempotent. Discord retries use stable delivery identifiers and record confirmed messages to limit duplicate posts. [Claim boundary calculation](../features/rolls/rollAllowanceService.js#L25) · [Schedule activation](../lib/gameConfig.js#L185)

### Work around the deadline

| Time | Work |
| --- | --- |
| During the reminder window | Prepare the rollover, check the channel and schedule, and plan retention cleanup. Keep playing and changing the closing season normally. Final stats and soulmate eligibility remain live through the cutoff. |
| At cutoff | Briefly hold writes for this guild, verify current members, archive closing stats, expire outstanding actions, and start the new season. The write transaction contains live state changes and the durable record that those changes succeeded. |
| After commit | Resume play, deliver the start announcement and reward notices, and purge retired receipts in small batches. SQLite reuses their pages. Physical compaction is separate maintenance. |

The existing claim reset is a time calculation. A scheduled worker can drive announcements and retries, and gameplay writers also check the stored cutoff under their write transaction. An action prepared in an earlier season can never resolve against the new one. Apply the same guard to delayed callbacks, component collectors, recovery jobs, and portal writes. Retire expired controls through their usual feedback paths and release in-memory reservations. Announcements and Discord membership lookups run outside the SQLite write transaction. Other guilds stay playable while one guild waits for a definitive membership response. [Bot startup](../app/bootstrap.js#L85) · [Game recovery](../lib/gameRecovery.js#L10) · [Membership lookup](../lib/serverLeaderboard.js#L42)

## Players, affection, and reset scope

Record season participation when a player successfully takes part in gameplay, for example by rolling, marrying, trading, changing wishes, or using an item. A carried soulmate also adds its owner to the new season roster. Seed Season 0 from existing ownership and gameplay evidence. Players who join after the reminder still qualify for the closing archive. The original reminder remains available in the announcement channel.

At cutoff, check membership for the roster and closing ownership candidates. A player who has left gets a final profile summary and their character returns to the pool. Only definite absence counts as a departure. If Discord fails to return complete membership results, retry while the affected guild waits at cutoff.

From the successful reminder through cutoff, a valid `!soulmate` selection may bypass the normal switch cooldown once per player. Normal switches leave the waiver available. At rollover, clear the cooldown and keep a selected soulmate's marriage only for a confirmed current member who still owns that character. Keep the affection at `floor(oldAffection / 10)`. Losing the soulmate before cutoff or having no selection means starting with an empty harem.

Recompute passive bonuses and perks from the reduced affection. Award newly earned item milestones through the normal affection reward flow, with normal inventory delivery, charges, expiry, and notification. Under the current cap, 1,000 old affection crosses the only reachable item milestone, 100 starting affection, and grants one eligible Common item. Give it once in the new season. New gameplay can earn milestones again in that season as it crosses them. Scope milestone entitlements and reward identities so an old reward or button cannot address a new award. [Affection rules](../lib/affectionRules.js#L2) · [Reward delivery](../lib/affectionRewards.js#L126)

| Reset at rollover | Persist |
| --- | --- |
| Other marriages and affection, wishes, prior ownership losses, and character protection locks | Eligible soulmate marriage and reduced affection, compact season profiles |
| Items, expanded inventory capacity, buffs, claim and roll usage, and daily roll usage | Shared item discoveries and guild configuration |
| Open rolls and escapes, trades and gifts, mystery sessions, vaults, queued rewards, and pending item actions or reservations | Shared character catalog, rankings, moderation, and unrelated bot features |

Take the archive first. Reset only the closing guild and prevent rollover divorces from becoming Chronicle of Return history. Effects fully committed before cutoff are reflected in the closing state. Pending effects expire with the closing season. Retired operational rows are unavailable to live gameplay and recovery before bulk deletion starts. Prune in dependency order and keep only the minimum evidence that a surviving replay path needs. Verify database integrity and restart recovery after pruning. [Ownership history](../lib/ownershipHistorySchema.js#L18) · [Runtime validation](../lib/catalogRuntimeRecovery.js#L25)

## Profile cards

`!profile` stays a prefix command and starts on the current season. Keep the PNG card in its embed, label the season, and add a select menu below the embed. Only the person who opened the card can change it. Selecting a season updates the same reply. Completed seasons for that player appear newest first. Page the options when necessary so all archived seasons remain available within Discord's select limit.

The saved stats are the closing marriage count, rank by marriage count with the existing current-member filter and tie order, soulmate and affection, top five owned characters by affection, and top five franchises by owned character count. Players with no eligible rank show as unranked. Freeze the historical stat labels and retain portrait references. Render with the player's current Discord avatar and display name and the existing fallback for missing artwork. [Profile data](../lib/profileCardData.js#L9) · [Profile layout](profile-card-design.md)

Version the summary format so newer cards can read earlier snapshots. A new profile field can appear on an old card if its value can be computed from that season's saved stats. New historical stats that need their own tracking start with the first season that captures enough data. Omit an unavailable field from older cards or mark it unavailable if the layout needs the slot. Preserve zero for stats actually recorded as zero.

## Acceptance and operational risk

- Rehearse migrating existing data and rolling it over on a disposable, production-sized SQLite copy. Check guild isolation, the archive against closing state, item milestones, foreign keys, and restart correctness.
- Exercise reminder failures, missing ping batches, cancellation races, downtime, overdue cutoffs, and duplicate worker passes. Verify that only a posted reminder authorizes rollover and each guild advances once.
- Exercise gameplay and portal writes around cutoff. Old sessions, refunds, or button clicks cannot affect new-season state, even when some old rows await pruning.
- Measure cutoff transaction time, write contention, and SQLite page reuse on production-sized data. Keep bulk history deletion after the commit so its cost stays outside the cutoff pause.
- Verify the current and historical profile flow, including archive navigation, owner-only selection, unchanged stats after later catalog or membership changes, and rendering older snapshots after adding a profile field.

## Design review

Self-approved for user review and then approved by the user. Checked the Phase 1 decisions against claim timing and schedule activation, portal authentication, live profile projection, membership lookup, affection thresholds, and startup recovery. The [implementation plan](season-implementation-plan.md) follows this design.
