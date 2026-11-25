# Waifu roll and marriage design

Status: Phase 2 design approved by user. Implementation followed the approved Phase 3 plan.

## Agreed behavior

- Use existing-prefix message commands: `w` for female characters, `h` for male characters. Other, unknown, and missing genders belong to both pools. Normalize gender case and whitespace.
- Both commands share 7 rolls per user per server per hour. Refill on the hour, without carryover.
- Each user has 1 claim per server per three-hour period. Periods start at 00:00, 03:00, 06:00, 09:00, 12:00, 15:00, 18:00, and 21:00 in Vietnam (UTC+7). No carryover.
- Choose uniformly among eligible unowned catalog characters. An empty pool consumes no roll. Delivery failures consume the reserved roll.
- Cards contain the character image when available, name, `Rank: #xxx`, and `Likes: xxxx`. Likes are catalog favourites. The only button is Report tag. The bot adds a Unicode heart reaction.
- Anyone may claim within 60 seconds, including the roller. The first eligible reaction processed wins immediately, without a confirmation prompt.
- Announce `<@user> has married <character> 🎉` in a separate message. Escape character text and allow only the winner's mention.
- Duplicate active rolls are allowed. A successful marriage permanently closes all existing rolls for that character in that server, so divorce cannot reopen old cards.
- A successful marriage spends the claim for the period when the marriage transaction executes, even if the roll predates a reset.
- Quotas and published active windows survive restarts. Recover only remaining time; never extend deadlines. Do not enumerate existing hearts to award offline claims.
- A user without a claim receives their next reset time, at most once per roll, without blocking other users.
- Divorce changes ownership only; it does not refund a claim.

## Existing foundations

`lib/catalogDb.js` uses standard-library SQLite, currently schema version 4. Characters already have gender, rank, favourites, and image metadata. `lib/characterMarriage.js` enforces one owner per character per server through a unique database constraint. Existing marriage lists and divorce already consume this ownership data.

`commands/char.js` demonstrates Components V2 cards and report responses. Reuse the image picker and `reportCharacterTag` storage operation; give rolls their own compact renderer instead of changing character lookup cards. `index.js` already routes character commands before unrelated random bot behavior, but does not yet enable reaction events or partial objects.

## Options

| Approach                                                              | Advantages                                                | Problems                                                              |
| --------------------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------- |
| In-memory counters, timers, and collectors                            | Small initial implementation                              | Loses allowances and claim windows on restart; does not satisfy scope |
| SQLite periods and persisted roll records, with shared event handlers | Reuses installed storage; atomic claims; restart recovery | Requires a schema migration and explicit Discord failure handling     |
| Separate queue/cache service and scheduled resets                     | Supports a larger distributed deployment                  | Adds infrastructure without a current need                            |

Recommendation: SQLite periods and persisted roll records. No new dependencies or separate service.

## Storage and boundaries

Keep rules in a small game service, Discord rendering and events in a separate adapter, and `w`/`h` as thin command entry points. Reuse the existing marriage operation inside the claim transaction. Do not add quota restrictions to unrelated ownership helpers.

Add an atomic, additive schema migration for:

- User allowance records keyed by server/user, holding roll period plus usage and the last consumed claim period. Old period values imply fresh allowances; no scheduled reset job is necessary.
- Roll records containing server, channel, character identity/name, originating command message ID, published message ID, publication/expiry times, and delivery/claim state. The originating message ID prevents duplicate handling from charging the same command twice.
- Notice deduplication keyed by roll/user, so recovery does not repeat quota notices.

Use persisted roll records for claim eligibility; Discord message content is never authority. Store timestamps in UTC milliseconds and derive period IDs using the fixed UTC+7 offset. A window is expired when `now >= expiresAt`.

Retain roll records through the existing one-hour report-control lifetime. Remove expired records and notices opportunistically after that lifetime. Preserve existing marriages and catalog data. Both writable and read-only database version guards must accept the new version. Older application versions will reject the upgraded database; deployment rollback requires a pre-migration database backup or compatible code.

## Roll flow

1. In a short synchronous transaction, validate the shared allowance, find an eligible character, and reserve one roll. Empty pools and exhausted allowances return without spending. Select uniformly from the eligible database pool; do not use the startup lookup index because it omits gender and can become stale.
2. Load an image using the existing picker and publish the compact card. Do not hold a database transaction during network requests.
3. Persist the returned Discord message identity and its 60-second deadline, based on publication time, then add the heart. Register the message before adding the heart so incoming user reactions can resolve it.
4. If sending fails, keep the spent roll and mark delivery failed. If adding the heart fails, close the roll and report the delivery issue. A claim already completed during that network operation remains valid.

Ownership may change while the image or message is being delivered. Recheck before publication where possible; every claim still checks current ownership. An already-published stale card cannot award a second marriage or consume a losing user's claim.

## Claim flow and concurrency

Enable guild message reactions and the partial handling needed for messages absent from cache. Use a shared reaction handler instead of per-message claim collectors, allowing published windows to work after restart. Ignore bots, other emoji, unrelated messages, and expired/closed rolls. Use the persisted guild/channel/message identity to validate routing.

Process eligibility and ownership in a single synchronous SQLite write transaction, with no network awaits:

1. Verify this roll is open and unexpired, and the character remains in the catalog and unowned.
2. Derive the current claim period and check the user's allowance.
3. Insert the marriage using the existing ownership constraint, spend the claim, and close all rolls for that character in that server.
4. Commit before announcing the result.

Failed eligibility or a lost ownership race spends no claim. This protects both different users claiming one character and one user claiming different characters concurrently. Reaction removal never reverses a marriage. Divorce never reopens closed roll records.

For exhausted claims, persist a notice marker before sending the reset notice. This gives at-most-once notice attempts, including across restarts. A failed notice does not alter claimability.

## Recovery and Discord limits

On restart, persisted published rolls remain valid until their original deadlines. Listen for fresh reaction events; do not scan reaction lists to reconstruct winners. A heart left while offline must be removed and added again to produce a new reaction event. Do not reset the 60-second timer during recovery.

SQLite and Discord cannot participate in one transaction. A crash after Discord sends a card but before its message ID is saved can leave an unclaimable card; the roll stays consumed under the accepted delivery-failure rule. A crash or send failure after the marriage commits can omit the announcement; ownership and spent claim remain correct and visible through the existing marriage list. Do not undo a marriage merely because its announcement failed. Log failures for diagnosis. Guaranteed announcement delivery and reconstruction of offline reaction order are outside this scope.

Report buttons use the persisted roll-to-character mapping and the existing report operation, with private acknowledgements. They retain the existing one-hour lifetime independently of the 60-second claim window. Expired reactions are ignored; no countdown or extra fields are added to the card.

## Verification requirements for later phases

- Fake-clock tests for hourly and three-hour boundaries, UTC+7 midnight, no carryover, cross-reset claims, and exactly-at-deadline expiry.
- Gender pool tests for female, male, other, mixed case, whitespace, and missing values; owned exclusion and empty pools.
- Shared `w`/`h` allowance tests, server/user isolation, repeated command delivery, failed-send charging, and restart persistence.
- Claim race tests for competing users, competing characters, duplicate cards, repeated reactions, divorce after claim, and missing catalog entries.
- Adapter tests for compact card fields, sole report button, heart seeding, success text, mention restrictions, and notice deduplication.
- Recovery tests with reopened SQLite databases and uncached messages; existing reactions must not become reconstructed claims.
- Existing catalog, marriage, command, and type checks. Live Discord verification is required to prove permissions, heart reactions, Components V2 rendering, and restart behavior beyond mocks.

## Author self-review

Approved as a design proposal: all agreed rules are covered; existing storage, image, report, and marriage operations are reused; no dependencies or slash commands are introduced. Claims and quota spending share one atomic boundary. No destructive schema change is proposed. Discord/database crash gaps and rollback limitations are explicit. The user approved the design before Phase 3 planning.
