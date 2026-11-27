# Weekly Event brainstorm

## Agreed rules

Each Discord server runs its own Weekly Event on a fixed weekly schedule after an administrator enables it and selects an announcement channel. The default boundary is Sunday at 00:00 in the server's game timezone. A qualifying action enters its player automatically. The winner's prize is active in that server during the following week.

The next theme is selected randomly by weight. Random selection skips the previous theme when another eligible theme is available. A one-week override in the portal can select the next theme, including a repeat.

The portal exposes all configurable Weekly Event values with global defaults and server overrides. Edits apply to future contests. Each contest locks the prize rules for its winner at the start of scoring.

A schedule change honors the current contest's announced cutoff and its winner's full prize week. The next contest starts at the first new boundary at or after that prize week ends.

Season rollover ends the current contest without a winner and clears the active prize. The next contest starts at the next weekly boundary.

Enabling starts the first contest at the next weekly boundary. Disabling allows the current contest to finish and any prize it awards to run for its full week. The announcement channel receives the previous contest's result and the new theme at the boundary. The `!weekly` prefix command displays the theme name, scoring condition, prize, and leaderboard with the top players, the caller's score and rank, and the cutoff.

| Theme               | Scoring                                                                                                                                                                                                                                                                                                               | Prize for the following week                                                                                                                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Steals and divorces | One point per character taken or forcibly divorced from another player. A multi-character effect counts each affected character. Gifts and trades score zero.                                                                                                                                                         | Each qualifying steal or divorce item earned gains one additional charge.                                                                                                                                       |
| Affection           | Total affection actually gained after bonuses and caps.                                                                                                                                                                                                                                                               | Earn 30% more affection by default. Round the bonus down with a minimum of one extra point per positive award, subject to the existing affection cap.                                                           |
| Wish matches        | One point for the roller when a character matches any wishlist in the server, including their own. A roll scores at most one point.                                                                                                                                                                                   | Double the relative roll weight of eligible characters on the winner's own wishlist by default.                                                                                                                 |
| Reclaims            | One point per successful manual or automatic escape reclaim. Chronicle returns score zero.                                                                                                                                                                                                                            | Each eligible escape has a 50% chance of an automatic reclaim.                                                                                                                                                  |
| Mystery Champion    | One point per mystery event win. A win counts regardless of claim availability.                                                                                                                                                                                                                                       | Earn a free vault on every mystery event win, regardless of claim availability. Use the normal vault odds and opening flow. Consolation Chit can also award an item if eligible.                                |
| Franchise Collector | Score the player's largest count of distinct characters gained in any one franchise during the week. Gifts, trades, and other ownership gains qualify. A character owned at opening qualifies if the player loses and regains ownership during the week. Count each character once per player per eligible franchise. | The first time the winner spends a normal claim in each claim window, they have a 50% chance to reset it. A soulmate perk that preserves the claim leaves this check available. Each window allows one attempt. |

The highest-ranked player who is still a server member at cutoff wins. Among eligible players with tied final scores, the player who reached the score first wins. A week without an eligible scoring player has no winner or prize.

Score an action in the week its outcome becomes final. A mystery game started before a cutoff and won after it counts in the new week.

The default charge bonus list contains Master Key, Pickpocket’s Hook, Cupid’s Misfire, Heart for a Heart, Hostage Note, Severed Fate, and Threadbreaker. Add future items to the default list when their effects steal or forcibly divorce another player's character. Siren’s Call starts an escape, and Grand Masquerade swaps characters. Both are outside the default list. Kaimetsu earns no points and receives no extra charge. The bonus adds to the item's normal starting charges. Unspent bonus charges stay on that copy until it is used up or expires.

## Portal settings

| Setting                   | Default or behavior                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Enable Weekly Events      | Off until a server administrator enables them.                                                               |
| Announcement channel      | Selected for each server.                                                                                    |
| Weekly start day and time | Sunday at 00:00 in the existing game timezone.                                                               |
| Random theme weights      | Equal positive weights by default. A weight of zero removes the theme from random selection.                 |
| Next theme                | Optional one-week server override. The default is random selection.                                          |
| Leaderboard length        | 10 ranked players by default, with the caller's own score and rank also shown.                               |
| Steals and divorces       | Extra charges per item (1) and the eligible item list above.                                                 |
| Affection                 | Bonus percentage (30%) and minimum bonus per positive award (1 point).                                       |
| Wish matches              | Weight multiplier for eligible characters on the winner's wishlist (2×).                                     |
| Reclaims                  | Automatic reclaim chance per eligible escape (50%).                                                          |
| Mystery Champion          | Free vaults per mystery win (1). Uses the shared portal settings for vault tier weights and opening timeout. |
| Franchise Collector       | Claim reset chance (50%) and attempts per claim window (1).                                                  |
