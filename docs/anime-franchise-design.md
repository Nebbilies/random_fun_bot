# Anime franchise catalog — design proposal

## Status and scope

Phase 1 decisions are settled. This is the Phase 2 design proposal. The implementation plan is a separate phase and requires user approval of this design first. Stop before Phase 4 (tests and implementation).

The goal is to look up **current catalog characters by franchise**. `!ima <franchise>` lists names only; `!imar <franchise>` lists `#rank - name`. Both use catalog rank order, deduplicate characters, and use traditional prefix commands. This work does not add characters to the catalog or change their ranks. No special behavior is needed for characters outside the current catalog.

Store a catalog character's full list of AniList anime appearances, including specials. Store each anime's AniList ID, titles, synonyms, genres, tags, start date, season year, format, status, average score, popularity, adult flag, cover image, and URL. Keep unavailable fields null rather than inventing values. Store AniList's typed anime-to-anime relations separately.

## What a franchise means

AniList has individual media IDs and typed relations, but no canonical franchise ID or main-series flag. A **franchise** here is a local, searchable group of anime entries. Mainline classification is not needed for these two lookup commands.

Build initial groups from connected anime entries using `PREQUEL`, `SEQUEL`, `PARENT`, `SIDE_STORY`, `SPIN_OFF`, `ALTERNATIVE`, `SUMMARY`, and `COMPILATION` links. Treat links as undirected for membership while retaining their original direction and type as source data. Remakes can enter through `ALTERNATIVE`. Exclude `CHARACTER`, `SAME_UNIVERSE`, and `OTHER` from automatic grouping because they do not reliably mean one franchise. Do not traverse `SOURCE` or `ADAPTATION` through manga or light novels. Anime without an accepted link form a one-anime franchise until more evidence or a manual correction appears.

These are game grouping rules, not AniList facts. AniList links may be incomplete or disputable. The local review page must allow a reviewer to rename a franchise, add aliases, merge groups, and move or remove an anime from a group. Saved corrections take precedence on refresh. A franchise has a stable local ID, display name, and aliases. Use a representative member's title as the initial name, favoring a popular TV entry; do not present that heuristic as AniList's “main series.” Search the franchise name, aliases, and member anime titles. When several franchises match, show a choice before displaying characters.

For example, AniList links the [2012 Sword Art Online anime](https://anilist.co/anime/11757/Sword-Art-Online/) to [SAO II](https://anilist.co/anime/20594/Sword-Art-Online-II) by `SEQUEL`, SAO II to Alternative: Gun Gale Online by `SPIN_OFF`, and the 2012 anime to Progressive by `ALTERNATIVE`. Those entries can share one local franchise. The original anime can be its display-name anchor without defining a canonical main story. The group's character result is the union of its members' credited catalog characters, with each character shown once.

## Storage options

| Option                                                                                     | Benefit                                                                                             | Problem                                                                                                              |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Put related anime IDs in a JSON attribute of a “main” anime                                | Small initial schema                                                                                | Duplicates membership, obscures relation types, makes merges and queries harder, and assumes a canonical main anime. |
| Add `main_anime_id` to every anime row                                                     | Simple grouping query                                                                               | Forces a tree and one chosen root; loses typed links and handles corrections poorly.                                 |
| Store anime, typed links, character appearances, and local franchise membership separately | Supports many-to-many facts, search, and corrections without claiming AniList defines a main series | Requires a migration and a controlled grouping step.                                                                 |

**Recommendation:** the third option. Use AniList IDs as keys for anime and characters. Use local IDs for franchises. The logical records are:

- `anime`: one record per AniList anime ID, with the selected metadata and fetch time.
- `character_anime`: distinct `(character_id, anime_id)` appearances for current catalog characters.
- `anime_relation`: source anime ID, target anime ID, and AniList relation type. Keep direction and type even though grouping traverses selected links in either direction.
- `franchises`, `franchise_anime`, and franchise aliases: stable local groups, memberships, and searchable names. Membership can support a rare anime that belongs to more than one manually curated group.
- Saved reviewer decisions: explicit name, alias, and membership corrections applied after automatic grouping, so a refresh cannot silently undo them.

The exact table columns and correction representation belong in Phase 3. Avoid a second full copy of AniList response JSON when the selected fields suffice.

## Import and lookup behavior

The current importer queries `Character.media(type: ANIME)` but stops on the first page containing a qualifying anime. It saves `anime_ids` and `anime_titles` on character rows. Those columns are incomplete for this feature; title deduplication also means their arrays cannot safely be paired as a complete anime-ID-to-title migration. Fetch all pages of anime appearances for each catalog character, then deduplicate anime metadata by AniList ID. Collect typed relation links for relevant anime, retaining anime-only links needed to connect franchise groups. A relation path may need an intermediate anime that has no current catalog character; collection must be checkpointed and bounded by the approved AniList access scope.

Stage new anime, appearances, relations, and generated franchise membership before publishing. Publication should switch the searchable view atomically, preserve manual corrections, and keep the prior searchable state if collection fails. Discord lookups should read the local SQLite catalog, not call AniList. As with the existing character lookup, a bot restart can load the new search index; live reload is not required.

Both commands resolve franchise names and aliases locally, present a choice when more than one franchise matches, then show current catalog characters in rank order. `!ima` hides ranks; `!imar` displays `#rank - name`. Reuse the existing character-result paging and Components V2 patterns where they fit.

## Boundaries and risks

- AniList's [terms](https://docs.anilist.co/guide/terms-of-use) prohibit mass collection. The repository's existing bulk-import permission gate remains in force. Do not run a live bulk backfill or relation crawl without written permission.
- AniList's [rate-limit guidance](https://docs.anilist.co/guide/rate-limiting) currently notes a degraded 30-request-per-minute limit. Keep the existing request pacing and backoff. The actual request count depends on character media pagination and the bounded relation collection strategy.
- Relations are evidence, not guaranteed franchise boundaries. Automatic grouping can miss unlinked works or join entries that a reviewer wants separate. Manual corrections and an inspectable local review page are required before treating the groups as reliable game data.
- A stored franchise name is a local label. AniList's [`Media.relations`](https://docs.anilist.co/reference/object/media) and [relation types](https://docs.anilist.co/reference/enum/mediarelation) do not identify an authoritative franchise root.
- Preserve existing catalog, tag decisions, and unrelated local changes. No commits are part of this phase.

## Acceptance for this design

The model can answer “which current catalog characters appear anywhere in this franchise?” without inventing a main-series type. It retains each character's direct anime appearances and the AniList relation evidence. Refreshes preserve reviewer corrections and either publish a complete new search view or leave the old one available. Player lookups require no live AniList request.
