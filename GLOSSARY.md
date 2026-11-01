# Character Game

Language for the character catalog, ownership, and character review.

## Language

**Character identity**:
The permanent, source-independent identity of a character, shared across its external references and independent of its catalog rank.
_Avoid_: Rank, catalog position

**Character ownership**:
The association of one player with a character in one Discord server. A character has at most one owner per server.
_Avoid_: Global ownership, character copy

**Franchise ownership view**:
A franchise's character list that identifies each currently married character's owner in the viewer's Discord server. Unmarried characters have no owner annotation.
_Avoid_: Global ownership list, marriage list

**Harem**:
The set of characters owned by one player in one Discord server.
_Avoid_: Global collection, inventory

**Kaimetsu**:
A consumable item whose confirmed use randomly divorces half of each player's non-soulbound harem in its server, including the user's own, with each half rounded down.
_Avoid_: Vault trap, global divorce

**Marry**:
To become a character's owner in one Discord server.
_Avoid_: Claim

**Escape attempt**:
An owned character's appearance in a roll that gives the current owner a chance to reclaim them before other players may marry them. The character remains owned until another player successfully marries them.
_Avoid_: Automatic divorce, released character

**Reclaim**:
For a character's current owner to end an escape attempt while retaining ownership.
_Avoid_: Remarry, new marriage

**Divorce**:
To end character ownership in one Discord server.
_Avoid_: Release

**Character catalog**:
The growing set of published characters and their display metadata. Published characters remain in the catalog, while popularity ranks can change on refresh.
_Avoid_: Ownership registry

**Manual character**:
A character added to the catalog through curation rather than an automatic source import.
_Avoid_: Fake character, custom copy

**Generated likes**:
A curated character's assigned like count, generated to fit its requested insertion rank rather than obtained from AniList. The count stays fixed across source refreshes unless explicitly edited and is labeled when displayed.
_Avoid_: AniList likes, imported likes

**Insertion rank**:
The requested catalog position when a character is added, not a permanent reservation of that rank. Later catalog changes may move the character.
_Avoid_: Pinned rank, permanent rank

**Character tag mapping**:
The association between a character and a tag used to find that character's images.
_Avoid_: Character mapping, tag match

**Character tag report**:
A viewer's flag that a character's tag mapping may be wrong or missing. A report does not propose a replacement tag.
_Avoid_: Correction, tag suggestion

**Character gender report**:
A viewer's flag that a character's catalog gender may be incorrect. A report does not propose a replacement gender.
_Avoid_: Gender correction, gender suggestion

**Gender override**:
A reviewed catalog gender that takes precedence over a character's source-provided gender until explicitly removed.
_Avoid_: Source gender, gender report

**Gender review case**:
A character's unresolved gender reports grouped into one review item, independent of its tag reports.
_Avoid_: Tag review, gender suggestion

**Reported character**:
A character with one or more unresolved character tag reports, presented as one item for tag review.
_Avoid_: Reported tag, duplicate report

**Report resolution**:
A review outcome that corrects a character tag mapping, dismisses its open reports, or marks a missing catalog character as unavailable.
_Avoid_: Approval

**Report correction**:
A tag mapping chosen while resolving reports, replacing the mapping that viewers flagged.
_Avoid_: Tag suggestion

**Marriage modifier**:
A letter flag appended to a marriage list command (such as `!mm[flags]`) that modifies sorting, grouping, or presentation.
_Avoid_: Subcommand, command parameter

**Franchise marriage view**:
A marriage list view (activated with the `a` modifier) that groups a player's married characters under their respective anime franchises in alphabetical order.
_Avoid_: Franchise harem, series list

**Individual card view**:
A marriage view (activated with the `i` modifier) that displays a player's married characters one full card at a time with Previous and Next navigation controls.
_Avoid_: Single character view, harem carousel

**Server leaderboard**:
A ranking of current server members by their top-ten rank sum, with lower sums placed first. Equal sums are ordered by comparing each player's best character rank, then their next-best ranks in turn.
_Avoid_: Catalog top list, global leaderboard

**Top-ten rank sum**:
The sum of the ten best current catalog ranks among a player's owned characters in one server. A player needs at least ten ranked owned characters to have this score; lower is better.
_Avoid_: Total harem rank, popularity points

**Catalog top list**:
A paged view of the catalog's highest ranked characters, listed in rank order.
_Avoid_: Leaderboard, popularity board

**Greed Chamber**:
A mystery event where players choose between banking their points by escaping and risking their unbanked points against a shared collapse for a higher score.
_Avoid_: Greed mode, individual collapse

**Banked score**:
A Greed Chamber score secured by escaping or surviving the final round, retained if the chamber later collapses.
_Avoid_: Unbanked score, prize

**Unbanked score**:
A Greed Chamber score still exposed to collapse while its player remains inside the chamber.
_Avoid_: Banked score, winnings

**Deadlock**:
A mystery event where players secretly choose a number each round and earn its value only when nobody else chose the same number. Round scores accumulate toward the event result.
_Avoid_: Highest unique bid, auction

**Wish**:
One player's declared intent to obtain one character in one Discord server. Its character identity is fixed when the wish is made, so a later rank change does not move the wish to another character.
_Avoid_: Favorite, target, wanted character

**Wishlist**:
A player's bounded set of wishes in one Discord server, holding at most seven. It is a target list, so wishing for an already owned character is allowed and changes nothing about ownership.
_Avoid_: Harem wishlist, global wishlist

**Item lifetime**:
The real-world duration an inventory entry remains available for starting uses, determined by its rarity tier when acquired. Time continues to pass while its owner is offline.
_Avoid_: Effect duration, inactivity timeout

**Item expiry deadline**:
The fixed moment an inventory entry's lifetime ends and it leaves the usable inventory, without interrupting an already-started use. Later changes to rarity-tier lifetimes do not alter an existing entry's deadline.
_Avoid_: Effect end time, cooldown

**Guild item discovery**:
A server's permanent knowledge of an item kind after any player successfully acquires it there. The item remains discovered after all copies are consumed; revealing an unacquired reward does not establish discovery.
_Avoid_: Current ownership, personal discovery

**Guild item list**:
A server's view of the full item catalog, showing names and descriptions for discovered items and concealing both for undiscovered items. It can be filtered by rarity tier.
_Avoid_: Inventory, behavior-type list

**Fortune's Lens**:
A consumable item that reveals a mystery vault's three reward choices before its owner selects one. Revealing those choices does not establish guild item discovery.
_Avoid_: Reward reroll, discovery item

**Armed Recast**:
A player's prepared Fortune's Recast effect in one server, waiting to offer a same-tier replacement choice for their next eligible vault reward after any Double or Nothing gamble.
_Avoid_: Spent Recast, inventory reroll

**Item release**:
A dated group of newly introduced item kinds announced together, with each name concealed until that item is discovered in the viewer's server.
_Avoid_: Item discovery, inventory update

**Consolation Chit**:
A passive consumable that awards a random item to a mystery-event winner who has no claim available when the event resolves. It does not compensate for losing, missing the claim window, or an unavailable prize alone.
_Avoid_: Extra claim, compensation vault

**Chronicle return**:
A former owner's fresh acquisition of a currently unowned character through Chronicle of Return. It is distinct from an escape reclaim, which retains existing ownership.
_Avoid_: Escape reclaim, restored marriage

**Ownership loss**:
The end of a player's ownership of a character in one server, whether through divorce or transfer to another owner. An escape attempt without a change of owner is not an ownership loss.
_Avoid_: Escape attempt, global history

**Wish match**:
A roll whose character appears on at least one wishlist in that server. A wish match is announced as one wish line naming every matching player and is presented with the wishlist accent color.
_Avoid_: Wish alert, wish notification
