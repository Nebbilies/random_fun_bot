# Character escape attempts

Status: Design approved by the user on 2026-10-18; implementation complete. The user selected brainstorm, design, implement, and verify, omitting a separate implementation plan and test-first phase.

## Purpose and agreed language

Allow an owned character to appear in an ordinary character roll as an **escape attempt**. The current owner may **reclaim** the character; another player may **marry** the character after an exclusive protection period. Ownership remains with the current owner until another player's marriage succeeds. See the root glossary for these terms.

This proposal supersedes the owned-character exclusion in earlier roll and mystery designs. Other existing roll, mystery, marriage, and reporting rules continue to apply unless changed below.

## Accepted game rules

- Existing-prefix `w` and `h` commands select uniformly from one pool containing both owned and unowned characters. Keep current gender handling and exclude characters with a pending reservation or unexpired open card in the same server. There is no separate escape probability.
- Selecting an owned character starts an escape attempt, including characters owned by the roller or a player who has left the server. Do not require a server membership lookup to determine eligibility.
- An escape attempt never checks mystery odds or selects a mystery event, even for a character whose unowned roll would guarantee mystery. It spends one ordinary roll.
- Keep ownership unchanged during the attempt. Harem lists continue to show the existing owner until a successful transfer.
- From publication until just before 60 seconds, only the original owner may reclaim. From 60 seconds until just before 120 seconds, other players may marry the character and the owner may still reclaim. At exactly 120 seconds, the attempt has expired.
- Reclaiming closes the attempt and preserves the existing marriage, including its identity and marriage date. It neither requires nor spends the owner's marriage allowance.
- Another player's successful marriage uses the normal one-marriage-per-three-hours allowance. Check and debit the allowance at the time of the successful transaction. A rejected or losing reaction spends no allowance.
- Use the existing Unicode heart reaction for both actions. Reject outsider reactions during protection without queuing them. A player who reacted too early must remove and add the heart after public access opens.
- The first eligible reaction processed wins. After public access begins, the owner has no priority over another eligible player.
- If nobody succeeds, close the attempt at 120 seconds and preserve ownership.
- Cancel all unfinished escape attempts on restart, including attempts in the public window. Preserve ownership and spent rolls. Normal non-mystery roll windows retain their existing restart behavior.
- If the original marriage changes, invalidate the attempt. A divorce, remarriage to the same person, or transfer must never let an old card change the later marriage.

## Card and messages

Reuse the normal Components V2 roll card, its selected image, character name, anime, rank, likes, remaining rolls, and Report tag button. During owner protection, use a purple accent, proposed as `0x9b59b6`.

Put a separate text component above the card container:

> @Owner **Character name** tries to leave your harem! You have 60 seconds to reclaim her before anyone else can marry her!

Use `him` for male characters and `them` when gender is unknown or another value. Escape character text. Allow only the original owner's mention in this first message; do not ping the roller through the reply.

Show the protection deadline using a Discord timestamp so the available time remains visible. At the public boundary, replace the announcement with:

> **Character name** has left the harem! Anyone can now marry her!

Use matching pronouns as above. Change the card accent to the existing normal roll color (`0xe91e63`), and do not show the final deadline. Later edits permit no mentions. This announcement describes public availability; the accepted ownership and late-reclaim rules still apply. Terminal edits retain the card's current phase color.

At resolution, update the same card to show **Reclaimed**, **Married**, **Expired — ownership unchanged**, or **Canceled — ownership changed**, as applicable. Reclaim identifies the retaining owner without a new ping. A successful outsider marriage also uses the existing marriage announcement, with only the winner allowed to be mentioned. Preserve the Report tag button for its normal reporting lifetime.

Card updates are best effort. Persisted eligibility and ownership determine outcomes even if a Discord edit fails. A late public-phase edit must never overwrite a terminal card update.

## Retained behavior

The user approved these defaults with the design:

- Active mystery events continue to pause all rolls in that server. Existing prank odds still run before character selection. Escape attempts do not pause unrelated rolls or become mystery sessions.
- A character may appear again immediately after an earlier attempt ends, subject to ordinary random selection and live-card exclusion. Do not introduce a cooldown or immunity period.
- Failed card delivery or failure to seed the heart keeps the roll spent and ends the attempt without changing ownership. A successful reclaim or marriage already committed before a later Discord failure remains valid.
- On restart, cancel escape attempts in storage and leave their old Discord messages unchanged, matching existing canceled mystery behavior. Old hearts cannot award a reclaim or marriage. Do not reconstruct reactions made while the bot was offline.
- A transfer creates a new marriage identity and date for the new owner. Reclaim preserves the original identity and date.
- Report controls retain their existing one-hour lifetime. Attempt cancellation or expiry does not turn a tag report into an ownership action.

## Design options

| Option | Advantages | Tradeoffs |
| --- | --- | --- |
| Separate escape-event subsystem | Can grow independently | Duplicates roll reservation, claims, recovery, and card handling for one extra roll outcome |
| Divorce automatically at 60 seconds | Can reuse unowned marriage handling afterward | Violates the accepted rule that ownership remains until another player succeeds |
| Extend ordinary roll records and claim handling | Reuses existing storage, quotas, reaction routing, and rendering | Requires an explicit protected phase and guarded ownership transfer |

Recommendation: extend the existing ordinary roll path. Escape attempts are a distinct owned-roll outcome, with no new dependency, command, or mystery event module.

## Storage and rule boundary

Use an additive migration on the existing SQLite database. Extend the roll record with the original marriage identity and owner, the protection deadline, and enough terminal outcome information to render the result. The existing final expiry is publication plus 120 seconds for an escape attempt; an ordinary roll remains 60 seconds. Existing records have no escape identity and keep their current meaning. Update writable and read-only schema version guards together.

Snapshot the exact marriage row when reserving an owned character, inside the same transaction as selection and roll debit. A user ID alone cannot identify that marriage: divorce and remarriage to the same person must invalidate the old attempt. Recheck that identity before publication and again during every attempt action.

Keep all ownership and allowance decisions in the existing synchronous claim transaction. No Discord call belongs inside that transaction:

1. Verify server, channel, message, roll state, final deadline, catalog availability, and original marriage identity.
2. If the reacting player is the original owner, close the attempt as reclaimed without changing marriage or allowance.
3. Otherwise reject reactions before the protection deadline, then check the player's current marriage allowance.
4. End only the exact original marriage and create the new marriage, debit the allowance, and close the attempt atomically. A failed replacement rolls back the whole operation.
5. Close any other open cards for the same character in that server, preserving the existing protection against old-card reuse.

Use existing marriage helpers where their exact-identity checks fit; keep transfer authorization in the roll rule boundary. Ordinary marriage helpers must continue rejecting characters already owned outside an approved escape transfer.

Timers update presentation and finalize expired attempts. Every reaction also checks absolute database deadlines, so delayed timers cannot extend protection or the public window. Re-read current state when rendering scheduled updates, and serialize edits for a card so public and terminal updates cannot finish in the wrong order. Do not build a general scheduler or event engine.

On startup, cancel unfinished escape rows before accepting new commands and reactions. Continue recovering ordinary roll windows. Normal cleanup retains reporting data for the existing lifetime and removes resolved records afterward.

## Verification

Use the existing Node test runner and test helpers. Add focused coverage alongside the existing roll, runtime, marriage, and migration tests; a separate test-first phase was omitted by user choice.

- Shared-pool selection includes owned, self-owned, and absent-owner characters; gender filtering, live-card exclusion, guild isolation, prank behavior, and unowned mystery selection still work.
- Owned results bypass both the mystery gate and event selection, including high-rank characters.
- Check just before and exactly at 60 seconds and 120 seconds. Early outsider reactions never become automatic later marriages.
- Reclaim works with an exhausted allowance in both phases, preserves marriage identity/date, and closes the attempt.
- A successful public marriage transfers exactly once and debits only the winner. Competing owners, outsiders, and multiple-character reactions cannot duplicate ownership or exceed allowances.
- Expiry, restart cancellation, publication failure, stale original marriages, missing catalog characters, and divorce/remarriage preserve unrelated ownership and do not spend a rejected player's allowance.
- Purple protected card, normal-color public card, exact public announcement, omission of the public deadline, announcement placement, character-name escaping, pronouns, initial owner mention, later mention suppression, terminal edits, and reporting behavior match the proposal. Scheduled edits cannot overwrite a completed outcome.
- An upgraded database preserves existing catalog, marriage, allowance, normal-roll, and mystery records. Run relevant regression tests and the existing catalog type check.

Live Discord behavior remains subject to available bot access: unit tests can validate payloads and event routing, but cannot prove server permissions, actual notification delivery, or client rendering.

### Verification result

On 2026-10-18, all 166 tests passed using `node --experimental-test-isolation=none --test --test-reporter=dot`, including 29 escape tests. Single-process execution avoids the environment's child-process restriction. `npm run typecheck:catalog` and `git diff --check` also passed. Live Discord rendering and notifications were not tested. No production database was opened or migrated during verification, and no commits were created.

## Author self-review

Self-approved as a design proposal on 2026-10-18, including the user's revised public announcement, normal roll color, and omitted public deadline. The user subsequently approved implementation. The design covers the accepted ownership, timing, quota, selection, terminology, presentation, and restart decisions. It reuses existing SQLite transactions, marriage identity checks, Components V2 cards, reactions, image lookup, and report storage. It adds no dependency or independent event framework. Sensitive transfers remain atomic, and stale cards cannot replace later ownership. Final review also covers cleanup of attempts canceled before publication; these records expire after the existing reporting lifetime.
