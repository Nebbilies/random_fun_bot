# Weekly Event design proposal

Status: Phase 2 approved by the user.

The [brainstorm](weekly-event-brainstorm.md) defines the six themes, scoring, prizes, and portal defaults. This proposal covers how the bot applies those rules during gameplay, cutoff, and recovery.

## Weekly lifecycle

- Keep one contest per server and weekly boundary, with its theme, opening and closing times, season, and saved prize rules. Draw from the effective theme weights at opening, or consume the next-theme override when the new contest is saved.
- Close scoring at the announced cutoff. Save the final standings before checking eligibility. Check ranked candidates with fresh Discord membership data. If the check fails, leave the result pending and retry. The next contest can open on time. Use the first conclusive membership check when the cutoff check was unavailable.
- Commit the winner and entitlement together. A late decision grants the remainder of the original prize week. Recovery opens the contest for the current calendar window when due and skips windows missed entirely. Recovery always respects a scheduled pause, a schedule change, or a completed season rollover.
- Reconcile due contests and prizes at startup and through the existing recovery worker. Gameplay uses the saved cutoff even when background work or Discord delivery is late. Season rollover takes precedence at a shared boundary and clears the current contest and active prize for that server.
- Announce from persisted contest state. A failed post leaves scoring and prizes independent, appears in the portal, and can be retried. If the new theme is announced while the previous result is pending, announce the result once it is confirmed.

## Scoring and prizes

Use a Weekly Event module to apply scoring and prize rules at the existing gameplay transactions. Each caller supplies a finalized outcome and uses its existing transaction. The module checks server, season, theme, cutoff, and active prize. Store live totals, the time each total was first reached, and distinct character counts for Franchise Collector. Keep final standings and prize results. [Standings storage decision](adr/0002-retain-weekly-event-standings.md)

| Theme               | Gameplay integration                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Steals and divorces | Score committed losses attributed to the acting player, with the agreed exceptions. Fix charge eligibility when a qualifying reward is earned. Apply the saved bonus when delivery creates the inventory copy.                                                                                                                                                                                                                                                                                                                      |
| Affection           | Score the actual increase on the existing affection award. Apply the prize on positive awards before the cap and preserve the agreed rounding rule.                                                                                                                                                                                                                                                                                                                                                                                 |
| Wish matches        | Score once using the wishlist match result for the committed roll. Apply the prize during character selection within the existing eligible roll pool.                                                                                                                                                                                                                                                                                                                                                                               |
| Reclaims            | Score successful reclaims through the existing completion path. A successful automatic check uses the same reclaim rules. A failed check leaves the manual opportunity available.                                                                                                                                                                                                                                                                                                                                                   |
| Mystery Champion    | Score when the mystery event records a winner. Reserve each bonus vault with a stable identity tied to that win and deliver it through the existing vault flow. The vault spends no roll and can coexist with Consolation Chit. Start the opening timer when Discord posts the vault.                                                                                                                                                                                                                                               |
| Franchise Collector | Track distinct characters gained during the contest by owner and effective franchise at acquisition. Include gifts, trades, and reacquisitions after an ownership loss. Continuing ownership from before opening contributes zero. An escape reclaim retains the same ownership and contributes zero. Score the player's largest franchise total. Consume a prize attempt in the same transaction as the qualifying normal claim. A successful attempt makes a normal claim available while preserving the existing reset schedule. |

Count an outcome and commit its score together. Reuse existing action, roll, and reward identities where replay is possible. A retry must never score an outcome twice, award an extra bonus vault, or run another claim reset check for the same spend. Discord requests and message delivery run outside gameplay transactions.

## Portal and Discord

- Register Weekly Event tuning in the existing configuration portal, using global defaults, server overrides, and revision checks. Validate effective settings before a save, including a usable random theme pool for enabled servers. Use the existing game timezone and shared vault settings.
- Keep the server's enable state, announcement channel, and next-theme override in server controls. Show the current cutoff, queued schedule or theme changes, and announcement delivery status there. A weekly schedule edit never resets roll or claim allowances.
- Keep `!weekly` on the configured message prefix. Read its theme, condition, prize and leaderboard from the same saved contest. Show the caller's rank and score and the current cutoff.

## Alternatives considered

- A gameplay activity log would permit historical rescoring, but would add durable writes and storage for routine rolls and other frequent actions. Live totals committed with gameplay support the agreed scoring and final standings with less retained data.
- A timer-only implementation would simplify the normal rollover path. A restart or missed timer could leave scoring or prizes active past cutoff. Persisted boundaries let gameplay and recovery enforce the same calendar.
- Waiting to open a new week until Discord verifies the previous winner would preserve announcement order. It would make scoring depend on Discord membership availability. Open the new contest on schedule and finish the previous result when membership can be verified.

## Confirmed cutoff rules

- If a qualifying item reward becomes final before the prize expires, it keeps its bonus charge even when delivery happens later. A reward finalized after expiry receives normal charges.
- If season rollover and the weekly cutoff occur at the same instant, rollover cancels the contest and clears its prize. Resume at the next weekly boundary.

## Phase 2 self-review

Checked the proposal against the approved brainstorm and the existing [game configuration](game-config-contract.md), [membership lookup](../lib/serverLeaderboard.js), [recovery worker](../app/recoveryWorker.js), [mystery consolation flow](../lib/mysteryConsolation.js), and [vault sessions](../lib/vaultSessions.js). The design covers cutoff and replay, server and season isolation, delayed eligibility and delivery, and the portal settings. The implementation plan should identify each authoritative gameplay writer and verify compatibility with existing claim, vault, affection, and inventory outcomes.
