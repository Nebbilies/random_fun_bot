# Character catalog

This builds a local SQLite catalog at `data/bot.sqlite`. The catalog grows with AniList characters **seen in qualifying anime** and never removes a published character. Ranks use the latest known AniList favourites, highest first, with AniList ID breaking ties. Qualifying anime have an AniList average score of at least 50/100 and popularity greater than 15,000, are not `MUSIC` videos, and are not `NOT_YET_RELEASED`. Adult-labelled anime remain eligible. Unscored anime are excluded. The scan uses bounded anime media-ID ranges, because AniList's character list has no anime-only filter and its pages stop at depth 5,000.

## Before importing

AniList's API terms restrict mass collection. **Do not run the bulk importer until AniList has granted written permission.** A request for permission is not approval. The importer refuses to start without `--permission-confirmed`; use that flag only after receiving the grant. The source query shape has not been checked against the live API while permission is pending.

Node 22.13 or newer is needed for the built-in `node:sqlite` module. It is still marked experimental in Node 22. The tools add no package dependency. Back up `data/bot.sqlite` before a refresh; copy the database after the tools have stopped, or use SQLite's online backup facility.

## Run

All catalog tools resolve `data/bot.sqlite` relative to the project location, regardless of the working directory. The importer prints the absolute database path at startup. If an older version created `scripts/data/bot.sqlite`, the corrected tools resume from the original project-level database; they do not merge or delete the accidental copy.

After written permission:

```sh
npm run catalog:import -- --permission-confirmed
```

The import pauses at least four seconds between AniList requests, retries 429 and server errors, and checkpoints every completed anime page. Restart the same command to resume. It reads the highest anime ID at the start and scans every integer ID through that bound in 500-ID ranges. Anime characters are deduplicated by AniList character ID. It fetches new-character metadata in groups of 25, confirms each new character has a qualifying anime, and atomically adds verified discoveries to the published catalog. Previously published characters remain even if a later scan no longer finds them. Seen characters get updated favourite counts; unseen characters keep their last known counts. A failed scan leaves the previous published catalog in place. Once complete, use `--refresh` along with the permission flag to build a fresh scan.

An import started before the score and format filters can resume from its saved page without rescanning. If its checkpoint is mid-range, the importer finishes that range with the old pagination and filters the returned anime locally; later ranges use AniList's filters. An old capped checkpoint keeps its saved limit and checks eligibility before publication. Because that scan discarded lower-ranked candidates, its no-rescan result is **approximate**. The completion report marks it as such. Use `--refresh` after it completes to run a full growing scan from the beginning.

The importer logs each anime ID range, anime title, character page count with a few example names, and every metadata batch. It also prints start and finish times, upper anime ID, number of pages, and published count. Because AniList changes during a long run, this is a completed scan, not a point-in-time snapshot. If no characters qualify, AniList rejects a query, or metadata cannot be verified, the importer stops without publishing. Keep the database and inspect the error before resuming. The first growing refresh can take longer and use more disk space than a capped import.

Each published character has a persistent identity keyed by AniList ID. Existing names and AniList portrait URLs remain available across refreshes; saved tag decisions also remain. The bot's `!char` search picks up a refreshed catalog after restart. New characters without an approved tag use their AniList portrait. Version-1 databases are upgraded in place when opened for writing. An older database cannot recover characters discarded by earlier capped imports unless a new scan discovers them again.

Then find Danbooru character tags:

```sh
npm run catalog:match
```

This searches character tags and active aliases, waits at least 1.2 seconds between uncached Danbooru API requests, and stores results in the same SQLite file. Alias targets are looked up as character tags so their real post counts appear in review; the old zero-post alias name is removed from the candidate list. It resumes at the next unsearched character. `npm run catalog:match -- --limit=100` processes a small batch. A unique name-and-anime-qualified candidate, a unique exact multiword name, or a matching canonical tag is accepted automatically when it has at least 500 more posts than the next candidate, or at least 5 times as many with a minimum of 100 posts and a nonzero runner-up count. An exact AniList name or active alias with at least 100 posts is also accepted when every other candidate has zero posts. Alias names count as identity evidence only when they match a full multiword AniList name or alternative, or when the canonical tag's series matches an AniList anime. These count rules need at least two candidate tags. Starting the matcher refreshes saved alias counts, removes old alias names, and applies the count rules to previously searched characters without changing manual decisions.
The matcher logs each character's rank, name, and result: the approved tag or a short candidate list for manual review. It also reports the total number of saved alias counts refreshed.

Open the local review page:

```sh
npm run catalog:review
```

Visit `http://127.0.0.1:8787`. The page shows characters without a saved decision; automatic approvals are excluded. It shows AniList identity and anime titles, Danbooru tag candidates, and up to three general-rated Safebooru previews sorted by score. The solo panel filters score-ranked posts locally. Approve a candidate, search or enter another active Danbooru character tag, or mark no match. First, Back, Forward, and Last navigate the queue without saving a decision. The browser remembers your place. Manual choices survive refreshes.

Character cards also have a **Report tag** button for wrong or missing mappings. Each Discord user can report a character once while its report is open. The reviewer page's **Reported characters** section shows the oldest open case, its current tag, previews, and distinct reporter count. Choose a valid replacement tag or dismiss the report; either action closes that character's open reports and advances to the next case. Resolved reports remain in local history, including reporter IDs in the database. Corrections use the existing manual decision flow. The tag matcher is intended as a one-time run, not a scheduled rematch.

The default bind address and port are `127.0.0.1:8787`. To use a VPS port opened for your friend, start the reviewer with `npm run catalog:review -- --host=0.0.0.0 --port=8787 --public-host=YOUR_VPS_IP`, then visit `http://YOUR_VPS_IP:8787`. Replace `8787` with the opened port. `--public-host` must match the IP address or domain in the browser URL; it keeps the request host check when the server binds all interfaces. The review page has no authentication; restrict that port to trusted IP addresses or put it behind an authenticated HTTPS proxy. For private access instead, keep the default bind address and use an SSH tunnel: `ssh -L 8787:127.0.0.1:8787 ubuntu@YOUR_VPS_IP`.

The matcher and reviewer only read/write `data/bot.sqlite`; they do not register Discord commands. No character roll, claim, or leaderboard behavior is included in this slice.

## Anime appearances and franchise lookups

The franchise enrichment uses the AniList character IDs already in the published character catalog. It saves every direct anime appearance for each current catalog character, including specials and low-popularity titles. Anime records include AniList ID, title variants, synonyms, genres, tags, dates, season year, format, status, average score, popularity, adult label, cover image, and AniList URL. This separate enrichment does not change character eligibility or the ranked character catalog.

AniList has no canonical franchise ID. The importer builds local franchise groups from anime-to-anime `PREQUEL`, `SEQUEL`, `PARENT`, `SIDE_STORY`, `SPIN_OFF`, `ALTERNATIVE`, `SUMMARY`, and `COMPILATION` relations. Loose character/shared-universe links and cross-media adaptations do not join groups. Relation data can be incomplete or inconsistent, so these groups are game data and may need local correction.

After a permitted character-catalog import or refresh completes, run the franchise enrichment with the same written-permission prerequisite:

```sh
npm run franchise:import -- --permission-confirmed
```

Use `--refresh` to restart enrichment from the current character snapshot. A failed run can be restarted without `--refresh`; it resumes from the last fully saved character batch. The previous published franchise snapshot remains intact until the replacement has been completely fetched and grouped. If the character catalog has changed, `!ima` and `!imar` report that the franchise data needs refresh and do not return stale results. Restart the bot after a successful enrichment to make it available in Discord.

`!ima <franchise>` shows current catalog character names. `!imar <franchise>` shows the same characters in catalog rank order as `#rank - name`. Both combine appearances across a franchise and count each character once. When a title matches more than one franchise, the player can choose which result to view.

The catalog review server hosts both review pages on one port. Start it once:

```sh
npm run catalog:review
```

Use `http://127.0.0.1:8787` for character-tag review and `http://127.0.0.1:8787/franchise` for franchise review. On a VPS, expose the existing catalog-review port and visit its `/franchise` path; no second open port is needed. The franchise page shows member anime, source relation labels, and current catalog character counts. It supports renaming groups, aliases, merges, splits, moving anime, and removing anime from all groups. Manually excluded anime remain in a separate list where they can be restored to a group. Manual decisions are retained across enrichment refreshes. The reviewer has no authentication; keep it bound to localhost or restrict remote access to trusted users as described above. `npm run franchise:review` remains available for a standalone server on port `8788`.
