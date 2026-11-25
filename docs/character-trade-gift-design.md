# Character trade and gift — design proposal

## Goal

Let two players in one server hand characters over to each other without leaving Discord. A **trade** exchanges one owned character for one owned character; a **gift** hands a single owned character over. Both run as a short conversation in the channel where they started, and both need the consent of the player who receives the character.

## Agreed language and rules

- **Trade** is an exchange of two owned characters between two players in one server. **Gift** is a one-way hand-over of one owned character. Both end character ownership for one character and start it for the other, exactly like marrying and divorcing do.
- `!me @user` starts a trade; `!trade @user` is an alias. The initiator sees their own character list, types the name of the character they want to offer, and the other player then sees their own list and types the name of the character they want in return. The bot closes with a confirmation that names both characters, and the receiving player answers yes or no.
- `!give @user` starts a gift. The initiator sees their own character list and types the name of the character they want to give away. The bot closes with a confirmation for the receiving player, who answers yes or no.
- The receiving player is the only one who confirms. The initiator already showed intent by naming the character; the recipient is the one who ends up with a new character, so the last word is theirs. A declined trade or gift changes nothing.
- Both the typed name and the typed answer are supported: a character is picked by typing its name, and a confirmation is answered by typing `yes`/`y`/`no`/`n` (or `ok`, `sure`, `nope`, `cancel`). The confirmation also carries Confirm and Cancel buttons, and the confirmation card is edited to the outcome so the channel keeps one record of what happened.
- A name that matches more than one owned character opens a select menu listing the candidates, so the player picks the exact character instead of guessing. A name that matches nothing asks for the name again and leaves the trade open.
- `!cancel` ends the trade or gift the calling player is part of. Either player may cancel, and a cancelled trade changes nothing.
- A character that is soulbound cannot change hands, and a character that is in the middle of an escape attempt cannot change hands either. The trade fails with a reason and nothing moves.
- A trade moves both characters or neither. If one of the two characters cannot move, the whole trade fails.
- Ownership stays a server-scoped fact. A character that changes hands in one server keeps its owner in every other server, and the new owner is the only one who may trade or give it away next.
- Ownership changes are recorded with a new marriage time, so a character's position in `!mm` (newest first) reflects the change.

## Design options

| Decision                 | Chosen                                         | Other option and reason                                                                                                                     |
| ------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Who confirms             | The receiving player only                      | A second confirmation from the initiator adds a step without protecting anyone, since the initiator already named the character.            |
| How to answer            | Typed answers and buttons                      | Buttons alone break when a player answers in plain text, and typed alone ignores the richer component UI the bot already uses.              |
| Who may cancel           | Either player                                  | An initiator-only cancel would leave the recipient unable to walk away from a stale prompt.                                                 |
| Ambiguous name           | Select menu picker                             | Asking for a more specific name punishes characters that genuinely share a name; picking silently can move the wrong character.             |
| Where the transfer lives | The existing ownership table, owner field only | A separate transfer log would duplicate ownership and break the harem list, escape rules and protection locks that already read that table. |
| Session lifetime         | In memory, per channel                         | A trade is a conversation that lasts minutes. Persisting it would need a cleanup job for rows nobody is going to answer.                    |

## Data and command boundaries

- Ownership is one row per server and character. A trade or gift only moves that row's owner to another player and stamps a new marriage time. No schema change, and the escape flow, the protection locks and the harem list keep working because they read the same table.
- The storage layer exposes three narrow operations: read the character a player owns, move one character, and swap two characters. The swap runs in one transaction and rolls back when either side cannot move, so a half finished trade is impossible.
- The command layer exposes `!me` (alias `!trade`), `!give` and `!cancel` as ordinary message commands with the server prefix. They are not slash commands.
- The list of characters to pick from is the same view `!mm` shows, so both commands reuse one shared renderer. The list pages with Previous and Next buttons, and only the player who is choosing may page it.
- The conversation runs in the channel where it started. The bot reads the next message from the player it is waiting for and ignores messages from everyone else, so a random message in the channel never advances or cancels a trade by accident.
- The trade and gift commands are registered in the message dispatch list of the bot, next to the other character commands.

## Failure and verification cases

- A trade with no characters on either side, with yourself, or with a user who is not in the server is refused with a clear reason and no prompt is opened.
- A trade cannot start while the initiator already has a pending trade or gift, while the other player has one, or while the channel already runs one.
- A character that is soulbound or mid escape cannot be traded or given; the reason is reported and both characters keep their owner.
- A trade where only one of the two characters can move leaves both characters with their original owner.
- A declined, cancelled or expired trade and gift change no ownership.
- A player who is not the one being asked cannot advance or answer a trade, and the typed answer of another player in the channel is ignored.
- An ambiguous name opens the picker and the wrong candidate cannot be selected by accident; an unknown name asks again.
- Verify the storage operations, the whole conversation for a trade and for a gift, the buttons, the picker, the cancel path, the guard clauses, the targeted type checks and the full local test suite.

## Deferred

Trade between more than two players, trading several characters at once, a gift with a price or a cooldown, a trade history, and any effect of a trade on escape attempts or item protection beyond the rules above.
