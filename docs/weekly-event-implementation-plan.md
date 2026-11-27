# Weekly Event implementation plan

Status: Phase 3 approved by the user. Implementation is on `feature/weekly-event`.

Use the [approved design](weekly-event-design.md) and the [brainstorm and portal settings](weekly-event-brainstorm.md) as acceptance criteria. Develop on `feature/weekly-event`. Write failing tests for each slice before implementing it. Verify through the bot and portal entry points after the focused tests pass.

## 1. Install the schema and implement the weekly clock

- Add `lib/weeklyEventSchema.js` and register it with the existing catalog migration and schema validation in `lib/catalogDb.js` and `lib/catalogFinalSchema.js`. Add the same schema for fresh catalogs and upgrade existing catalogs under the catalog write lock. Leave Weekly Events off until enabled. Start with empty contest history.
- Add a store and lifecycle module under `features/weeklyEvents/`. Persist one contest per server and opening time, live totals, deterministic tie order, franchise membership observations for distinct characters, final standings, prize entitlements, and notification delivery. Scope active state to the current season. Keep historical results through season pruning and remove live scoring detail once standings are final and recovery no longer needs it.
- Reuse the effective game timezone and an injectable clock. Test Sunday midnight, timezone and schedule changes, enable and disable, weighted selection, manual repeat overrides, and cutoffs around a restart. Test final scores, ties, eligibility retries, and late prize activation against the original deadline.
- Connect `app/bootstrap.js`, `app/recoveryWorker.js`, and `features/seasons/seasonRollover.js`. Run season settlement before weekly settlement when both are due. Keep the weekly membership lookup and announcement sends outside SQLite transactions. Retry pending results and posts independently. Ensure failure in one server leaves the other servers and regular recovery available.

## 2. Settle scores at the existing gameplay writers

- In `lib/characterRolls.js`, `lib/rollDelivery.js`, and `features/rolls/rollLifecycleService.js`, trace reservation, publication, acknowledgement, and failed or refunded rolls. Capture the `findWishMatchers` result from `lib/characterWishlist.js` at the finalized roll outcome. Count once for the roller, including a match on their own wishlist. Cover both ordinary and mystery roll paths and their retries.
- In `features/rolls/rollLifecycleService.js`, `lib/characterRolls.js`, `lib/itemActions.js`, and `lib/items/masterKey.js` and `lib/items/pickpocketsHook.js`, score confirmed opposing losses from theft, escape transfers, and forced divorce. Attribute each committed loss to its actor and count every affected opposing character in a bulk operation. Use `lib/characterOwnershipHistory.js` outcome and provenance where available. Check failed, shielded, self-directed, consensual, and Kaimetsu paths for zero points.
- In `lib/characterAffection.js`, score each committed affection increase at award settlement. Use the existing award source identity and exclude season seeding. In `features/rolls/rollLifecycleService.js`, record successful reclaims in the existing close-escape transaction. In `lib/mysteryCoordinator.js` and `lib/characterRolls.js`, score the durable mystery winner transition, including a win with no available claim.
- Audit all successful ownership gains for Franchise Collector. Cover marriages in `lib/characterMarriage.js`, claim settlement in `features/rolls/rollLifecycleService.js`, direct acquisitions and swaps in `lib/itemActions.js`, gifts and trades in `features/trade/tradeRepository.js`, and transfers in the theft items. Use effective franchise membership at acquisition. Test both recipients in a trade, ownership from before opening that is lost and regained, repeated acquisition of the same character, ordinary escape reclaims, and characters with several franchise memberships.
- Keep each score update inside the transaction that finalizes its outcome. Reuse durable outcome identities for replay. Test failure, duplicate delivery, and simultaneous actions at cutoff using the existing roll, ownership, affection, and mystery fixtures.

## 3. Apply the six prizes

- **Extra charge.** Capture the bonus in the earned reward outcome within the prize week, then pass it through `lib/vaultRewards.js`, `lib/affectionRewards.js`, and any direct earned-item path in `lib/itemActions.js` to `lib/itemStorage.js`. Use existing overflow and expiry handling. Test delayed delivery, multiple eligible items, charge persistence, and excluded items. Keep the default eligible item list documented and covered by a roster check so new qualifying items can be added deliberately.
- **Affection.** Apply the approved percentage and minimum in `lib/characterAffection.js` at award settlement with the existing modifiers, cap, and milestone calculation. Test small awards, near-cap awards, and replay of an already settled award.
- **Wishlist.** Apply the multiplier at character selection in `lib/characterRolls.js`, using the final eligible pool from the existing roll logic and the winner's wishes. Cover pool restrictions, selection when none of the eligible characters are wished, and the ordinary path without a prize.
- **Automatic reclaim.** In the escape publication and lifecycle paths, persist one check per eligible escape and route a success through the same transactional reclaim completion used by the owner. Keep the manual opportunity after a failed check. Check normal and forced escape origins, stale ownership, competing claims, and recovery.
- **Bonus vault.** Add a free vault origin in `lib/vaultSessions.js` and `lib/vaultRuntime.js`, tied to the durable mystery win. Reuse the existing vault reward flow and odds. Bind the opening deadline to the first published card and reconcile uncertain sends without extending it. Update `lib/catalogRuntimeRecovery.js` and season cleanup where they assume a paid roll origin. Test duplicate wins or deliveries, downed channels, unresolved vaults at rollover, and coexistence with Consolation Chit. Verify free vault expiry never refunds a roll.
- **Claim reset.** Hook the normal-claim spend branch in `features/rolls/rollLifecycleService.js` and use the claim period and per-player allowance storage in `features/rolls/rollAllowanceService.js` and `features/rolls/rollAllowanceRepository.js`. Consume the attempt even when the check fails. Restore only the current player's normal claim when it succeeds. Cover Claim Conservation, Engagement Ring and alternative claim resources, repeated claims in one window, and the next window.

## 4. Connect the portal and `!weekly`

- Add the tuning registry in `lib/gameConfigSchema.js` and use the validation and revision flow in `lib/gameConfig.js`, `web/reviewConfig.js`, and `web/assets/reviewConfig.js`. Expose the approved values and distinguish inherited settings from server overrides. Validate the effective theme pool and eligible item IDs. Weekly schedule saves stage the next boundary without activating a new claim or roll cycle.
- Add server controls and status through `web/reviewGame.html`, `web/assets/reviewGame.js`, and an admin route registered in `web/reviewCharacterTags.js`. Use the existing portal authentication, request checks, and guild validation. Show the current and pending schedule, one-week theme override, announcement channel, and delivery status.
- Add `commands/weekly.js` and register the prefix command in `app/commandRegistry.js`. Render the applicable theme name, scoring condition, prize, cutoff, leaderboard, and caller's rank and score. Cover disabled, awaiting first boundary, active, and pending-result states through the command entry point.

## 5. Verify the feature

- Run focused scheduler, migration, recovery, scoring, reward, command, and portal checks using a controllable clock. Exercise a full cutoff with the previous prize expiring, the new prize becoming available, and the next contest starting. Cover a simultaneous season rollover, downtime, and two servers with different settings.
- Run `npm test`, `npm run typecheck:catalog`, and `git diff --check`. Exercise the portal and prefix command in a disposable environment before declaring verification complete.

## Franchise Collector details

- All ownership gains qualify regardless of the acquisition method, including gifts, trades, claims, Chronicle of Return, and item transfers.
- A character that belongs to several franchises counts once in each of its effective franchises at acquisition. The player's score is still their largest single franchise total.
- Count only characters gained during the contest. A character already owned at opening counts if ownership ends and the player gains it back during the contest. An ordinary escape reclaim keeps the current ownership, so it contributes zero. Later loss leaves a point already earned intact.

## Phase 3 self-review

Checked file ownership against the catalog migration path, roll reservation and claim lifecycle, item and affection writers, mystery settlement, durable vault sessions, recovery worker, prefix registry, and existing portal controls. The slices follow the approved scope and include failure and replay checks wherever a gameplay effect can be retried. The Franchise Collector checks cover distinct weekly ownership gains, including ownership lost and regained after opening.
