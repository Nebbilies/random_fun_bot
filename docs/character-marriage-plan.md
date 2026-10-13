# Growing catalog and marriage — implementation plan

Approved design: [character-marriage-design.md](character-marriage-design.md). Use the existing JavaScript, `node:sqlite`, Discord message-command dispatch, and Components V2. Do not add a package or run the live bulk AniList importer.

## Starting state and safeguards

- The local `data/bot.sqlite` was read only during design. It is version 1 with 15,000 published characters and a completed import. Test migrations in temporary databases; never use the live database as a fixture.
- Preserve unrelated working-tree edits. In particular, `docs/character-catalog.md` already has user changes. Commit only task hunks. Make two commits: catalog growth first, marriage second.
- Existing importer checkpoints may contain a capped partial scan. Let such scans finish under their saved scope, then require a fresh full scan for growing publication. A new scan uses the growing mode. Do not silently treat an old capped checkpoint as a complete discovery.

## Phase 4 — failing tests first

1. In `test/characterCatalog.test.js` and `test/characterIdentity.test.js`, test publication that adds a character below the old cutoff, keeps an old character absent from the new stage, updates favourites and ranks for seen characters, retains tag decisions and portraits, and rolls back on failure. Replace tests whose expected deletion conflicts with the new catalog policy. Test new-scan staging beyond 15,000 with local fixtures and no API requests.
2. Add `test/characterMarriage.test.js` for version-1 and version-2 migration, fresh schema, per-server exclusivity, unlimited ownership, duplicate attempts, unknown-character rejection, divorce permission boundaries, departed-owner persistence, stale-divorce protection, and list order.
3. Add focused command tests for `!divorce`, `!mm`, `!mymarry`, and `!mmr`: name ambiguity, confirmation, Administrator targeting by mention or ID, public list lookup, pagination, and race/stale feedback. Mock Discord interactions; do not contact Discord.

## Phase 5A — growing catalog, then first commit

1. Update `lib/catalogDb.js` so a new scan can stage every qualifying candidate without the old cap while preserving the bounded legacy helper and resumable old checkpoints. Publish the union of existing catalog rows and verified staged rows in one transaction, using database tables rather than loading the full union into JavaScript memory. Refresh seen favourites, keep unseen metadata and favourites, recompute contiguous ranks by `(favourites DESC, id ASC)`, and preserve identities and tag decisions. Keep rollback protection and read-only access consistent.
2. Update `scripts/importCharacterCatalog.js` to start new scans in growing mode, hydrate only new characters in small batches, reuse existing metadata, and publish without truncating to 15,000. Keep old incomplete scans resumable under their recorded mode; a later fresh refresh discovers the full set. Replace the top-15,000 cutoff and count assumptions in output. Retain the bulk-import permission gate.
3. Update the existing catalog tests and the relevant text in `docs/character-catalog.md`. Stage only catalog changes, including the catalog portion of `GLOSSARY.md`; keep pre-existing documentation edits unstaged. Run catalog tests, the targeted type check, and a diff review. Commit the catalog change without co-author metadata.

## Phase 5B — marriage, then second commit

4. In `lib/catalogDb.js`, migrate databases through a new version that creates marriage storage. Keep migrations atomic for both version-1 and version-2 input. Key active marriage by `(guild_id, character_id)` and retain a unique row identity so a stale confirmation cannot divorce a later marriage of the same character.
5. Add `lib/characterMarriage.js` with narrow operations to marry a published AniList ID, read active marriages and owners, and divorce only the selected active marriage. Use database uniqueness for the winner of a race. Return explicit outcomes for newly married, already owned by the same user, owned by another user, and unknown character. Query names and current ranks through the published catalog. Validate guild, user, and character IDs at the boundary.
6. Add the prefix command `commands/divorce.js`. Search only the selected owner's marriages by name, reusing the current character-name matcher where it fits. For ambiguous results, show a picker. Always show confirmation, then recheck server, actor permission, target owner, and marriage row identity before deleting. Permit another target only for an Administrator; accept a mention or raw user ID for an owner who left.
7. Add `commands/mm.js`, `commands/mymarry.js`, and `commands/mmr.js` with one shared list path. Show one character per row, newest marriages first for `mm`/`mymarry`, and current rank ascending for `mmr`. Allow an optional member mention for public list lookup. Page long lists with bounded controls. Route these game commands before unrelated message side effects, as `!char` is routed today.
8. Extend `tsconfig.catalog.json` to cover the new marriage service and focused tests. Add command and data tests, and document command use in a new marriage section. Stage only marriage changes, including the marriage portion of `GLOSSARY.md` and the approved design and plan. Run focused tests and type check. Commit the marriage change without co-author metadata.

## Phase 6 — verify

- Run focused catalog and marriage tests, then `node --test`, `npm run typecheck:catalog`, and `git diff --check`.
- Review both commits for unintended files and confirm unrelated working-tree changes remain. Verify no slash command or roll action was added, and no live AniList request or live database write was performed during development.
- Report behavior, tests, commit IDs, and any remaining limits. Stop when catalog rank and per-server marriage invariants are proven; do not add trade or battle behavior.
