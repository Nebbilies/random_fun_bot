# Character marriage

Marriage gives one Discord user ownership of a character within one server. A character can have a different owner in another server, and one user can marry multiple characters. Players marry rolled characters by reacting with ❤️ within 60 seconds; there is no typed marry command.

Use the server's existing message-command prefix. With `!` as the prefix:

- `!mm` or `!mymarry` lists your marriages, newest first, one character per row.
- `!mmr` lists your marriages by current catalog rank, as `#rank - character` per row.
- `!mm @user` and `!mmr @user` show another member's marriages. Anyone in the server may view them.
- `!divorce <character name>` ends one of your marriages after confirmation. If the name matches several of your characters, choose one from the picker first.
- `!w` rolls a female character; `!h` rolls a male character. Other or missing gender metadata appears in both. Both commands share 7 rolls per user per server, resetting every hour on the hour (Vietnam time). Unused rolls do not carry over.
- `!ru` shows your remaining rolls and minutes until the next hourly reset. `!mu` shows whether you can claim and the hours and minutes until the next three-hour claim reset.
- Each user can claim one character per server every three hours. Claims reset at 00:00, 03:00, 06:00, 09:00, 12:00, 15:00, 18:00, and 21:00 Vietnam time. Any user with an available claim may react to a roll. First eligible reaction processed wins immediately; the bot posts the winner. Unused claims do not carry over.
- A server Administrator may use `!divorce @user <character name>` or `!divorce <user ID> <character name>` to end another user's marriage. A raw user ID works when the owner has left the server. Administrator permission is checked again when confirming.

Every divorce asks for confirmation. The prompt is tied to the exact marriage selected; if it changes while the prompt is open, confirming leaves the new marriage intact. The marriage remains after its owner leaves the server. Divorce removes current ownership without keeping a history, and the character can be married again through a later roll.

Rolls choose equally among currently unowned characters. Duplicate active cards may show the same character, but only one can award the marriage. Old cards stay closed after divorce. Roll and claim usage and active windows survive a restart until their original expiry. Hearts added while the bot was offline cannot be reconstructed in order; users must remove and add the heart again while the bot is online. Empty pools do not spend a roll. A failed card delivery or heart reaction still spends the reserved roll. Divorce does not refund a claim.

Each roll card shows the character name, the first catalog anime title beneath it, rank, likes, and image. If the catalog has no anime title, it shows “Unknown anime.”

Marriages use AniList character IDs internally. Only published characters can be married. The first successful database write wins if multiple users try to marry the same character in one server. Ranks can change after catalog imports, so commands display the current catalog rank rather than treating rank as identity.
