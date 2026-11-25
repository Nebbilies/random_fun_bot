# Growing catalog and character marriage — design proposal

## Goal

Prepare durable, exclusive per-server character marriage before the roll flow exists. Add player commands to view and end marriages. Make the catalog grow so every published character keeps a current rank.

## Agreed language and rules

- **Marry** means gaining character ownership in one Discord server. **Divorce** ends that ownership. A character has at most one owner per server; a user may own any number of characters. The same character may have different owners in different servers.
- Rolling will offer the player-facing marry action later. This phase provides an internal marriage operation, not a `!marry` command or roll reaction.
- Only published catalog characters may be married. AniList character ID is the stable key; rank and name are display data. The first successful database write wins a race to marry a character. Another user's attempt reports that it is already married. An owner repeating the action does not create a second marriage.
- A marriage remains when its owner leaves the server. Only the owner or a server Administrator may divorce. An Administrator may target another owner with `!divorce @user <name>` or `!divorce <user ID> <name>`; without a target, the command searches the caller's marriages.
- `!divorce <name>` searches the targeted owner's marriages by name. Ambiguous matches use a picker that identifies each character. Every divorce requires a confirmation button. Confirmation checks the marriage and permission again so a stale prompt cannot end a different ownership.
- `!mm` and `!mymarry` are aliases listing marriages newest first, one character name per row. `!mmr` lists the same marriages by current catalog rank, lowest rank number first, as `#rank - character` per row. Each accepts an optional mentioned user to view; any server member may view any member's list. Long lists use pages.
- Current marriages remain the ownership authority. Phase 2 supersedes the original history-free design: retain each former owner's latest loss per guild and stable character identity from deployment onward, without reconstructing old losses or retaining a full event ledger. Divorce removes the active association; Chronicle of Return may later create fresh ownership if its eligibility checks pass.

## Catalog decision

The current importer keeps a top-15,000 staging set and replaces the published catalog. That conflicts with the agreed rule that every published character always has a rank. Change publication to an accumulating catalog: a complete import adds newly qualifying characters and never removes a published one. Recompute all ranks by latest known AniList favourites, descending, then AniList ID, ascending. Update favourites for published characters seen again during an import; keep the last known value for those not seen. A newly discovered character must pass the existing anime eligibility and metadata checks before publication. Rank is not a permanent identity and may change after any successful import.

The importer must discover beyond the former 15,000-candidate cap. Reuse metadata already published for known characters and fetch full metadata for newly discovered ones. Keep the current checkpoint, validation, and atomic-publication guarantees. A failed scan or publication leaves the prior catalog and ranks intact. A completed old-style catalog remains valid input to the first growing refresh. The bot's `!char` index still reloads on restart.

The first growing refresh requires a full qualifying-anime scan. It can take longer and use more disk and memory than the capped import. Keep scan and metadata hydration batches bounded, and check the larger `!char` index's memory use. Characters removed by an earlier top-15,000 refresh cannot be restored from identity-only records if they are no longer discoverable; the new no-removal rule applies from the first growing publication onward.

At design time, the existing local database is version 1 and contains 15,000 published characters. The marriage migration must also support version 2 databases. No live AniList import is part of verification; the importer already requires separate written permission for bulk API use.

## Design options

| Decision                       | Chosen                                                       | Other option and reason                                                                                           |
| ------------------------------ | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Player acquisition before roll | Internal marriage operation only                             | A temporary `!marry` command would create an extra public acquisition path.                                       |
| Exclusivity                    | Database key on server and AniList character ID              | A check in command code alone could lose a race.                                                                  |
| Catalog size                   | Grow the published set and recompute ranks                   | Keeping only the top 15,000 would leave some married characters without a current rank.                           |
| Divorce lookup                 | Search the owner's marriages by name, then pick if ambiguous | Rank alone changes after imports; ID alone is hard to remember.                                                   |
| Marriage history               | Current association plus post-Phase-2 latest-loss records    | Chronicle eligibility needs a former owner's latest loss, not a complete event log or restored marriage metadata. |

## Data and command boundaries

- Store each marriage with server ID, AniList character ID, owner ID, and marriage time. Enforce one row per server and character in SQLite. Do not tie the foreign key to the replaceable rank or to a catalog row that publication deletes.
- Expose narrow operations for marrying, reading an owner or a user's marriages, and divorcing. Validate a character is published at marry time. The future roll handler will call the same marry operation.
- Put the growing-import work in one commit. Put marriage storage, `!divorce`, `!mm`, `!mymarry`, and `!mmr` in a separate commit. Stage only task changes; the checkout contains unrelated edits.
- Use existing message commands and the guild's prefix. Use Discord Components V2 for the ambiguous picker, confirmation, and list pages where they help. Do not register game slash commands.

## Failure and verification cases

- Two users in one server race for one character; exactly one marries it. Both may marry the same character in different servers. A user may marry several characters in one server.
- A character unknown to the published catalog cannot be married. A repeated marry by the same owner leaves one marriage. Divorce by a non-owner without Administrator permission fails.
- A divorce prompt expires or becomes stale after ownership changes; it cannot remove a new marriage. A departed owner's marriage remains available to an Administrator by raw user ID.
- A refresh adds characters below the old cutoff, retains previously published characters that no longer qualify, updates ranks, and leaves marriages and approved tag decisions intact. A failed refresh changes none of these. Test with more than 15,000 staged characters without calling AniList.
- Lists show every marriage in the requested order, with stable ordering for equal timestamps and ranks, and paginate within Discord limits. Empty lists and ambiguous names have clear responses.
- Verify version-1 and version-2 migrations, catalog publication rollback, command permissions and UI, targeted type checks, and the full local test suite. Do not call the live bulk AniList API for tests.

## Deferred

The original design deferred rolls, reaction or button acquisition, trade, battles, and permanent marriage history. Later features implement rolls/trade and Phase 2 adds bounded latest-loss records, not full marriage history. The roll design will decide who may interact with a roll and how long its marry action stays open.
