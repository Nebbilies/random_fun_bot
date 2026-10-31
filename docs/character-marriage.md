# Character marriage

Marriage gives one Discord user ownership of a character within one server. A character can have a different owner in another server, and one user can marry multiple characters. Players marry rolled characters by reacting with ❤️ within 60 seconds; there is no typed marry command.

The catalog review portal's **Game controls** page (`/game`) provides global controls across all servers in its database. **Add rolls to everyone** adds the entered positive whole number to current hourly balances, capped at each server's maximum. Users already full remain full. **Reset claims for everyone** immediately restores claim availability without changing marriages, roll balances, daily refills, or scheduled resets. Restart the review portal after updating to load the new page.

Mystery events select Doors or Clue Reveal; Treasure Hunt is no longer in the roster. The mystery heading appears only on the introduction. Event updates use new messages. Clue Reveal mentions the winner once at the start of its three-second reveal countdown, followed by `2...` and `1...`. The revealed prize has a winner-only **i dont wanna** button that immediately ends the event without spending a claim. Declined prizes cannot be claimed.

Doors shows two hidden portraits in a gallery with **Left** and **Right** buttons. Only the roller can choose, within 30 seconds. The character and John Pork are randomly placed with equal odds. A choice announces the user and chosen side, then waits three seconds. A win reveals the character card with a 60-second exclusive claim. A loss reveals **John Pork**, anime `-`, rank `?`, likes `?`, and no claim; two seconds later it reveals the prize character as unclaimable and ends the event. A timeout reveals both without awarding a claim.

Use the server's existing message-command prefix. With `!` as the prefix:

- `!mm` or `!mymarry` lists your marriages, newest first, one character per row.
- `!mmr` lists your marriages by current catalog rank, as `#rank - character` per row.
- `!mm @user` and `!mmr @user` show another member's marriages. Anyone in the server may view them.
- `!divorce <character name>` ends one of your marriages after confirmation. If the name matches several of your characters, choose one from the picker first.
- `!w` rolls a female character; `!h` rolls a male character. Other or missing gender metadata appears in both. Both commands share the server's hourly maximum (default: 7 rolls) per user, resetting every hour on the hour (Vietnam time). Unused rolls do not carry over.
- `!ru` shows your remaining rolls and minutes until the next hourly reset. `!mu` shows whether you can claim and the hours and minutes until the next three-hour claim reset.
- `/set-roll amount:10` sets the server's base maximum rolls per user per hour (default: 7). Requires Administrator permission. Changes apply immediately, preserve rolls already spent this hour, and survive restarts.
- `!daily` refills your current hour's rolls to the server's configured maximum, once per user per server each day. Daily availability resets at 00:00 UTC+7 and survives restarts. Using it with full rolls still spends the daily refill; rolls do not stack or carry over.
- Each user can claim one character per server every three hours. Claims reset at 00:00, 03:00, 06:00, 09:00, 12:00, 15:00, 18:00, and 21:00 Vietnam time. Any user with an available claim may react to a roll. First eligible reaction processed wins immediately; the bot posts the winner. Unused claims do not carry over.
- A server Administrator may use `!divorce @user <character name>` or `!divorce <user ID> <character name>` to end another user's marriage. A raw user ID works when the owner has left the server. Administrator permission is checked again when confirming.

Every divorce asks for confirmation. The prompt is tied to the exact marriage selected; if it changes while the prompt is open, confirming leaves the new marriage intact. The marriage remains after its owner leaves the server. Divorce removes current ownership, and the character can be married again through a later roll. From Phase 2 deployment onward, the bot retains each former owner's latest ownership-loss time per character and server, including transfers and forced losses. There is no backfill or full marriage event log. Chronicle of Return can use a qualifying recent loss to create a fresh marriage to an available unowned character; it does not restore the old marriage or spend/reset the normal claim.

Rolls choose equally among currently unowned characters. Duplicate active cards may show the same character, but only one can award the marriage. Old cards stay closed after divorce. Roll and claim usage and active windows survive a restart until their original expiry. Hearts added while the bot was offline cannot be reconstructed in order; users must remove and add the heart again while the bot is online. Empty pools do not spend a roll. A failed card delivery or heart reaction still spends the reserved roll. Divorce does not refund a claim.

Each roll card shows the character name, the first catalog anime title beneath it, rank, likes, and image. If the catalog has no anime title, it shows “Unknown anime.”

Before character selection, each available roll has a shared 1% chance to show a prank card instead: “ur roll gone” with `dog_clap.gif`, or “john ate ur roll” with `john_pork.gif`, with equal odds. Prank cards spend one roll, show `?` for rank and likes and `- ` for anime, and have no claim or report controls.

Marriages use AniList character IDs internally. Only published characters can be married. The first successful database write wins if multiple users try to marry the same character in one server. Ranks can change after catalog imports, so commands display the current catalog rank rather than treating rank as identity.
