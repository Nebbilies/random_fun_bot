# Character identity foundation — implementation plan

## Goal

Keep every published character's stable AniList identity and last known display references after catalog refreshes. Preserve approved tag mappings. Add a checked JavaScript interface for these facts without converting the repository to TypeScript.

## Decisions and invariants

- AniList character ID is the permanent identity. Popularity rank is display data and can change.
- The current top-15,000 catalog determines `!char` search results and future claim eligibility. It is not an ownership registry.
- A known identity keeps its last published name and AniList portrait URL when it leaves the current catalog. Store references, not image files.
- Tag decisions survive refresh, including approved automatic mappings and explicit no-match decisions. A new character without an approved tag uses its AniList portrait.
- Existing reports for characters outside the current catalog still close as unavailable. Retained-owned reporting waits for ownership storage in the claims phase.
- The running bot may load a refreshed catalog after restart. No live reload is required.
- No ownership records or claim, trade, or battle commands belong in this phase. Future ownership is exclusive per character per Discord server and must never key on rank.

## Steps

1. **Migrate the catalog safely** — `lib/catalogDb.js`.
   - Add a persistent character-identity table keyed by AniList ID, holding last known name and AniList portrait URL.
   - Migrate existing SQLite databases in place: backfill identities from current `characters` and advance `user_version`. Keep new-database initialization and read-only version checks consistent.
   - Make a failed migration rollback without losing the current catalog or tag decisions. Do not touch unrelated in-progress database edits.
   - Verify: open a version-1 fixture and a fresh database; both expose identical identity data.

2. **Make publication preserve identity and tags** — `lib/catalogDb.js`.
   - Within the existing publication transaction, update identities from the staged catalog before replacing current rows. Never delete old identities merely because they leave the top 15,000.
   - Stop deleting automatic tag decisions during refresh; preserve existing manual decisions too. Keep current report closure for characters absent from the new catalog.
   - Verify: a disappearing character retains identity, portrait reference, and approved tag; a returning character gets fresh display references without changing ID or reviewed tag; a failed publication changes none of them.

3. **Expose a small typed JavaScript interface** — `lib/catalogDb.js` and only directly involved callers/tests.
   - Add JSDoc types for the identity read result and the publication input; the result distinguishes a known identity from current catalog membership and represents missing portrait/tag as nullable.
   - Provide one read path for a known character without making callers parse raw SQLite rows. Keep `loadCharacterIndex` current-catalog-only and leave the existing `!char` matching rule intact.
   - Add a narrow no-output type-check command and configuration for the touched JavaScript files, with TypeScript and Node types as development dependencies. Do not enable checking for the entire legacy bot in this phase. Official TypeScript guidance supports [checking JavaScript with `checkJs`](https://www.typescriptlang.org/tsconfig/checkJs.html) and JSDoc.
   - Verify: the targeted type check passes without broad `any` suppressions or emitted files.

4. **Exercise the lifecycle** — `test/characterCatalog.test.js` and focused lookup tests.
   - Cover fresh initialization, version-1 migration, refresh removal and re-entry, tag preservation, portrait fallback, and transaction rollback.
   - Confirm `!char` still searches only current characters after the index is reloaded at restart. Confirm absent-character report closure is unchanged.
   - Run targeted tests, the full `node --test` suite, the type check, and a staged-diff check.

5. **Document operation** — `docs/character-catalog.md`.
   - Explain that refresh retains identities and approved tags, while bot restart refreshes its lookup index. Note that previously removed characters cannot be reconstructed from an old version-1 database unless they appear in a later import.
   - State that retained-owned behavior and report review outside the current catalog become active only when ownership storage and commands are built.

## Deferred

- Per-server ownership storage and uniqueness constraints; claim, trade, and battle rules.
- Reporting or reviewing owned characters outside the current catalog.
- A repository-wide TypeScript conversion or type-checking of unrelated commands.
- Live catalog reload and automatic rematching after refresh.

## Stop condition

The migration, refresh invariants, targeted type check, and existing bot behavior are verified. No game mechanics or unrelated cleanup is added.
