# Character marriage

Marriage gives one Discord user ownership of a character within one server. A character can have a different owner in another server, and one user can marry multiple characters. The future roll flow will call the marriage operation; there is no player-facing marry command yet.

Use the server's existing message-command prefix. With `!` as the prefix:

- `!mm` or `!mymarry` lists your marriages, newest first, one character per row.
- `!mmr` lists your marriages by current catalog rank, as `#rank - character` per row.
- `!mm @user` and `!mmr @user` show another member's marriages. Anyone in the server may view them.
- `!divorce <character name>` ends one of your marriages after confirmation. If the name matches several of your characters, choose one from the picker first.
- A server Administrator may use `!divorce @user <character name>` or `!divorce <user ID> <character name>` to end another user's marriage. A raw user ID works when the owner has left the server. Administrator permission is checked again when confirming.

Every divorce asks for confirmation. The prompt is tied to the exact marriage selected; if it changes while the prompt is open, confirming leaves the new marriage intact. The marriage remains after its owner leaves the server. Divorce removes current ownership without keeping a history, and the character can be married again through a later roll.

Marriages use AniList character IDs internally. Only published characters can be married. The first successful database write wins if multiple users try to marry the same character in one server. Ranks can change after catalog imports, so commands display the current catalog rank rather than treating rank as identity.
