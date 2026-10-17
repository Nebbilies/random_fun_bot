# Character catalog: implementation plan

## Approved scope

- Keep the 15,000 AniList characters with the most favourites who appear in at least one qualifying anime: average score at least 50/100, anime popularity greater than 15,000, excluding `MUSIC` and `NOT_YET_RELEASED`. Include adult-labelled anime. Break equal favourite counts by AniList character ID.
- Store character identity and useful metadata in SQLite. Keep AniList favourites as the displayed rank signal.
- Suggest Danbooru character tags. Accept only strong, unique matches automatically, audit a sample, and send ambiguous matches to a local review UI.
- Fetch only general-rated Danbooru images for review. Discord rolling, claims, and leaderboards are outside this slice.
- Do not run bulk AniList collection until AniList grants written permission. Asking for permission is not the grant.

## Constraints and approach

- Node 22.13+ is available on the VPS. Use `node:sqlite`, `node:http`, and `fetch`; add no ORM or database package.
- AniList pages hold at most 50 records and stop at a depth of 5,000. `Page.characters` has no anime-only filter. Scan anime media by bounded `id_in` ranges, then their paginated character connections. This also covers anime with no release date. Deduplicate characters by AniList ID.
- Query the highest anime media ID first. Walk every integer ID through that bound in small ranges. Keep a rolling top 15,000 staging set by `(favourites DESC, character_id ASC)` instead of persisting every character found. For an already-started scan under the old rules, preserve its checkpoint, keep a temporary 30,000-candidate buffer, and validate finalists. This no-rescan result is approximate. Checkpoint each completed API page. Redoing a page after a crash must be safe.
- Throttle AniList requests below its current 30/minute limit, allow no bursts, and honour `Retry-After` on 429. Keep the delay configurable only if a real operational need appears; start conservatively.
- After complete discovery, fetch full metadata for finalists in bounded batches. Publish a new catalog snapshot atomically. Failed or interrupted imports leave the prior published snapshot intact. Preserve human tag decisions across refreshes.
- AniList's data can change during a long scan. Report scan start/end, media ID range covered, counts, and the cutoff favourite count. Call the result a completed scan rather than an atomic snapshot.

## File-by-file changes

1. `.gitignore`: exclude `data/bot.sqlite` and its journal/WAL sidecars.
2. `package.json`: add explicit CLI commands for catalog import, tag matching, and the review UI; require Node 22.13+ for these tools.
3. `lib/catalogDb.js`: open SQLite, apply versioned SQL migrations, and own tables for published characters, anime appearances, staging candidates, import progress, tag candidates, confirmed mappings, and review decisions. Use transactions and foreign keys.
4. `lib/anilistCatalogApi.js`: GraphQL requests, pacing, 429/backoff handling, and small query functions for anime ID discovery, anime pages, extra character pages, and finalist metadata.
5. `scripts/importCharacterCatalog.js`: permission-gated, resumable media-ID scan; rolling top-15,000 selection; final metadata hydration; atomic publication and a coverage report. Never run this against AniList before written permission.
6. `lib/danbooruTagMatcher.js` and `scripts/matchCharacterTags.js`: fetch/cache character tags and active aliases at a measured pace; propose matches using AniList names and anime titles. Store match evidence and status. Do not treat post count alone as identity evidence.
7. `scripts/reviewCharacterTags.js` and minimal static review files: localhost-only browser UI with AniList portrait/names/anime, candidate tags, general-rated Danbooru previews, and Approve / Change tag / No match / Skip actions. Show queue and audit progress.
8. `test/characterCatalog.test.js` and focused companion tests: cover top-15,000 ordering, resume/idempotence, atomic publication, matching ambiguity, and preserved human decisions with mocked HTTP. No live bulk API calls.
9. `docs/character-catalog.md`: operation guide, permission prerequisite, run commands, database backup, review workflow, and known limits.

## Execution gates

1. Write failing focused tests for ranking, checkpointing, matching, and review decisions.
2. Implement the smallest code path that passes them.
3. Run local tests and a fixture-only review UI check. Do not start the bulk import without AniList's written grant.
4. Inspect the diff and confirm existing user changes remain untouched. Do not commit unless explicitly requested.
