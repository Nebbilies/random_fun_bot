# Season brainstorm

## Requested behavior

- Remind current players to select a soulmate. Gameplay continues during the reminder window.
- Start and announce the next season at the first scheduled claim reset after the reminder.
- Carry over the soulmate with one tenth of their affection. Reset the rest of each player's game progress.
- Add a select menu below the `!profile` embed for current and past season stats.

## Agreed decisions

- Each Discord server has its own season and rollover. An operator initiates a rollover through the portal in v1.
- Existing progress is Season 0. It continues until each server's first announced rollover, when Season 1 begins.
- Save one final profile summary per player and season. Freeze marriage count, rank by marriage count, soulmate and affection, the top five owned characters by affection, and the top five franchises by owned character count. `!profile` opens on the current season.
- Keep the selected soulmate if the player still owns them at rollover. Keep their marriage and round the affection down after dividing by ten. A player without a valid soulmate carries over no characters.
- Allow one cooldown-free soulmate switch per player during the reminder window. Normal gameplay continues up to rollover.
- Expire outstanding actions at rollover. Count effects that already completed toward the closing season.
- Preserve shared guild item discoveries. Reset player inventory, capacity upgrades, and buffs.
- Let operators set a guild's target length in the portal for Season 1 onward. The default is 30 days. The target gives a review date and every rollover still requires a manual trigger. Season 0 can close on the operator's schedule. A guild with no prior progress starts at Season 1 when play begins.
- Schedule the reminder at the start of the next claim window and the rollover at the following scheduled claim reset. Show both times before confirmation. Use the configured guild announcement channel for the reminder and start announcement, and check posting permissions before scheduling.
- Delay rollover if the bot cannot post the reminder. After a successful reminder, apply an overdue rollover before gameplay resumes and post the start announcement.
- Add players to the season roster when they first play or carry in a soulmate. Seed Season 0 from existing gameplay records. Ping roster members still in the guild at reminder time, and include late joiners in the final archive.
- Spend the one reminder waiver only on a valid soulmate switch that would otherwise be blocked by cooldown. Clear the switch cooldown at rollover.
- Recompute passive benefits from carried affection and unlock any item milestones it meets in the new season. With the current rules, the only reachable item milestone is one random eligible Common item at 100 affection. The old total must be at least 1,000 to carry that much.
- Prune completed-season gameplay records once recovery is safe. Reuse freed SQLite pages and handle physical file compaction separately.
- Deliver the rollover item through normal affection rewards, including automatic inventory delivery, charges, expiry, and the standard notification.
- Allow cancellation before the public reminder posts. Once it posts, keep the cutoff fixed and block claim schedule changes that would move it. Retry missing ping batches and show delivery status in the portal.
- Archive players who have left the server, and release their soulmate when the bot can confirm their absence at cutoff.

## Production observations

On November 24, 2026, a read-only SQLite inspection on the VPS found a 391 MiB database with no freelist pages or outstanding WAL bytes at the time of the check. The results below are aggregates and contain no Discord identifiers.

| Measure | Observed value |
| --- | --- |
| Current ownership | 1,328 marriages across 33 owners in one guild |
| Recent activity | 30 distinct players with an affection context in the previous ten days |
| Catalog coverage | 21 of the current top 25, 44 of the top 50, 84 of the top 100, and 159 of the top 200 currently owned |
| Top 100 ownership history | 90 of today's top 100 appear in current marriages or recorded ownership losses |
| Currently owned soulmates | 10 across 16 stored selection records |
| Largest gameplay storage groups | 132.5 MiB across vault, mystery, and reward tables, and 75.5 MiB across affection tables, including indexes |
| Other core gameplay storage | About 1 MiB across marriages, ownership losses, wishes, inventory, and buffs, including indexes |
| Recent payloads | About 69.6 MiB of payloads in recent affection, reward, vault, and mystery records, plus 42.8 MiB in catalog mutation snapshots written in the same ten-day window |

Current-rank ownership coverage gives a calibration point for an automatic trigger. A moving leaderboard, divorce, and trade all change how live counts behave. The ten-day payload sample measures stored field bytes for records timestamped in that window. Estimating net file growth requires a comparable earlier database measurement. SQLite can reuse freed pages after deletes. File shrinkage needs a separate compaction decision.

## Existing behavior that shapes the design

- Claim availability changes across guild-configured time buckets. The default interval is three hours. The portal's immediate claim reset clears allowance usage. A season cutover needs a persisted deadline tied to the scheduled boundary. See [rollAllowanceService.js](../features/rolls/rollAllowanceService.js#L25), [gameConfigSchema.js](../lib/gameConfigSchema.js#L15), and [reviewGame.html](../web/reviewGame.html).
- A soulmate must be currently owned. Switching normally has a twelve-hour cooldown. Losing ownership clears the active selection, and recorded ownership losses feed Chronicle of Return. See [characterAffection.js](../lib/characterAffection.js#L32), [affectionSchema.js](../lib/affectionSchema.js#L81), and [ownershipHistorySchema.js](../lib/ownershipHistorySchema.js#L18).
- The 2,100 affection cap allows up to 210 to carry over. Existing affection rules can therefore grant one bonus roll, the first three soulmate perks, and one Common item on day one. The milestone delivery flow can grant inventory automatically when space is available. Affection milestone keys currently lack a season, so reward and interaction identifiers must distinguish awards across seasons. See [affectionRules.js](../lib/affectionRules.js#L2), [characterAffection.js](../lib/characterAffection.js#L19), [affectionRewards.js](../lib/affectionRewards.js#L126), and [affectionSchema.js](../lib/affectionSchema.js#L66).
- The current profile shows marriage count, rank by marriage count, the active soulmate, the five owned characters with the most affection, and the five franchises with the most owned characters. A per-player profile summary can preserve those values without copying the full game state. See [profileCardData.js](../lib/profileCardData.js#L9) and [profile card design](profile-card-design.md).
- In-flight rolls, mystery events, vaults, rewards, trades, and item actions can finish after the last player command. The cutover needs a rule for those actions and a way to prevent older interactions from writing to the new season. Some stored receipts support recovery and idempotency, so their cleanup needs to account for replay paths and foreign keys. See [gameRecovery.js](../lib/gameRecovery.js#L10), [catalogRuntimeRecovery.js](../lib/catalogRuntimeRecovery.js#L25), and [tradeRuntime.js](../features/trade/tradeRuntime.js).
