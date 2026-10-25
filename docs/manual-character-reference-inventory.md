# Manual character addition: UUID reference and maintenance inventory

## Scope and evidence

This is a **source-only inventory and proposed implementation checklist**, governed by [the approved design](./manual-character-addition-design.md) and [the approved plan](./manual-character-addition-plan.md). No database was opened, queried, backed up, migrated, or contacted; no bot, portal, importer, tests, or network requests were run. Only this document is written by this task. Findings describe declarations and consumers in the current working tree, not verified contents of any deployed database. Runtime data counts, unexpected historical payloads, and actual orphan counts remain rehearsal gates.

The checkout already contains unrelated modified/untracked work, including `lib/catalogRanking.js`, `test/catalogRanking.test.js`, portal authentication files, `web/serveAssets.js`, and `GLOSSARY.md`. Preserve that work. The ranking helper already treats IDs as opaque strings, but the published schema and gameplay APIs still use integers. Presence of a helper or authentication file does not establish integration or completion.

No delegation/orchestration is required. Paths below are repository-relative. “Preserve” means preserve retained records and their semantics, including historical/unpublished identities; it does not authorize new published-character deletion or retirement.

## 1. Identity boundaries

| Identifier | Current representation | Target treatment |
| --- | --- | --- |
| Internal character identity | AniList integer reused as `characters.id`, `character_id`, and `characterId` | Server-generated UUID text, stable across publication, source correction, ownership, and rank changes |
| AniList character ID | Same integer today | Separate unique source reference `(source, external_id)`; keep API variables numeric as required by AniList |
| AniList anime ID | Integer, including JSON `anime_ids` and Clue Reveal `animeId` | Remains numeric; never UUID-map it |
| Franchise ID | Integer, including passport `franchiseId` | Remains numeric |
| Rank, favourites/likes, tie position | Integers | Remain numeric; add persistent tie order and likes provenance, never sort rank ties by UUID |
| Marriage/roll/mystery-session/report IDs | Integer primary keys | Remain numeric; preserve exact marriage identity guards |
| Inventory/buff IDs and action sweep rowid | Integers | Remain numeric |
| Item/action/vault/generation/puzzle IDs | Item/puzzle strings or existing UUID-like strings | Unchanged; these are not character identities |
| Discord guild/user/channel/message IDs | Decimal strings | Unchanged; never apply `Number()` or character UUID validation |
| Non-character roll target | Integer **0** for prank/vault | Explicitly represent no character, preferably nullable `character_id` with event-kind/state validation |

**Mapping universe:** union all retained relational character references and all typed character references inside retained JSON, plus `characters.id` and `character_identities.id`. Do not build the map from `characters` alone. Records outside the current catalog can retain ownership, wishes, protections, tags, and historical references. Generate exactly one UUID per distinct legacy identity; materialize a durable mapping for verification/restart safety. Legacy references without an identity row need a minimal identity record using available captured name/portrait, not a fabricated published catalog entry. Report missing metadata and conflicting evidence. Exclude the classified roll sentinel; reject unexplained zero/negative/nonintegral IDs elsewhere rather than silently discarding them.

Source mapping for legacy positive IDs represents the old AniList identity association, including retained unpublished identities, unless rehearsal finds contradictory evidence requiring an explicit operator decision. Do not infer new source links from names, arbitrary URL strings, or coincidentally equal numbers.

## 2. Every declared character-bearing table/column

Schema authority is `lib/catalogDb.js:openCatalog` (currently version 10), plus its initializer calls into `lib/itemStorage.js`, `lib/itemActionStorage.js`, `lib/vaultRewards.js`, `lib/itemDiscovery.js`, and `lib/gameConfig.js`.

| Table.column | Current declaration/key | Maintenance treatment |
| --- | --- | --- |
| `characters.id` | `INTEGER PRIMARY KEY`; unique numeric `rank` | Rebuild as UUID text identity reference. Preserve all published fields, likes, exact ranks/tied order; initialize imported origin/likes provenance and persistent tie order |
| `character_identities.id` | `INTEGER PRIMARY KEY` | UUID text primary key; preserve identities absent from `characters` and cached names/portraits |
| `stage_characters.id` | `INTEGER PRIMARY KEY`; index `(favourites ASC, id DESC)` | Discard unfinished rows. Future staging may retain external numeric IDs, explicitly named/typed as such; resolve before publishing |
| `character_anime.character_id` | `INTEGER NOT NULL`; composite PK with `anime_id`; reverse index `(anime_id, character_id)` | Map to UUID; retain published appearances and numeric anime IDs |
| `stage_character_anime.character_id` | `INTEGER NOT NULL`; composite PK with `anime_id` | Discard with unfinished anime staging; future staging must distinguish source ID and resolved identity |
| `marriages.character_id` | `INTEGER NOT NULL`; unique `(guild_id, character_id)` | Map; preserve `id`, guild, owner, timestamp, and uniqueness; do not recreate marriages with new IDs |
| `character_rolls.character_id` | `INTEGER NOT NULL`; index `(guild_id, character_id, state)` | Map retained real targets; separately convert prank/vault zero; preserve roll IDs, messages, names, rules, history and terminal outcomes; cancel unfinished interactions first |
| `mystery_sessions.character_id` | `INTEGER NOT NULL`; unique `origin_roll_id`; partial active-guild index | Map; preserve `rank_snapshot`, state JSON/history and numeric session/roll IDs; cancel active sessions before conversion |
| `tag_candidates.character_id` | `INTEGER NOT NULL`; PK `(character_id, tag_name)` | Preserve/map existing candidates for safest lossless conversion; later recompute deliberately, not as an identity-migration side effect |
| `tag_match_progress.character_id` | `INTEGER PRIMARY KEY` | Preserve/map completed per-character match markers; distinguish from discarded import traversal cursors |
| `tag_decisions.character_id` | `INTEGER PRIMARY KEY` | Preserve/map **all** approve/no-match decisions, tag/source/timestamp, not just manual approvals |
| `character_tag_reports.character_id` | `INTEGER NOT NULL`; unique open `(character_id, reporter_id)` | Map both open and resolved history; report `id` remains numeric |
| `duckduckgo_tag_attempts.character_id` | `INTEGER PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE` | Copy/map without triggering loss; both Google and DuckDuckGo tools write this table. Preserve query/URLs/outcome/tag/details/time |
| `character_wishes.character_id` | `INTEGER NOT NULL`; PK `(guild_id, user_id, character_id)`; index `(guild_id, character_id)` | Map, preserving insertion times and unpublished targets |
| `character_protection_locks.character_id` | `INTEGER NOT NULL`; PK `(guild_id, character_id)`; `lib/itemStorage.js` | Map; retain soulbind NULL deadline and timed protection deadlines |
| `item_character_reservations.character_id` | `INTEGER NOT NULL`; PK `(guild_id, character_id)`; `lib/itemActionStorage.js` | Settle/cancel pending Hostages first and release reservations; map any retained diagnostic representation, do not carry live reservations into restart |
| `counterfeit_crowns.character_id` | `INTEGER NOT NULL`; PK `(guild_id, user_id)` | Map surviving/restored decoys; preserve numeric `marriage_id` and string `generation_id`; verify owner/marriage invariants |

There are **17 character-bearing table entries**, including two unfinished character staging tables. The other unfinished staging tables, `stage_anime` and `stage_anime_relations`, do not themselves contain character IDs.

### Tables without relational character columns

These still require preservation or explicit staging reset, but no character-column substitution:

- `catalog_meta` (inspect named cursor/completeness keys separately).
- `guild_prefixes`, `guild_roll_limits`, `guild_game_rates`, `guild_mystery_settings`.
- `anime`, `anime_relations`, `franchises`, `franchise_anime`, `franchise_aliases`, `franchise_membership_overrides` (anime/franchise IDs remain numeric; nullable override franchise ID means exclusion, not missing character).
- `stage_anime`, `stage_anime_relations` (discard unfinished staging only).
- `roll_allowances`, `daily_roll_claims` including `reset_at`, `claim_allowances`, `claim_events`, `treasure_puzzle_wins`, `roll_notices` (numeric roll linkage is unchanged).
- `tag_search_cache` (Danbooru response JSON, not internal character identity).
- `user_inventory`, `user_inventory_limits`, `active_user_buffs` (classify buff JSON below).
- `item_actions`, `item_action_costs` (character references are in JSON, not their scalar keys).
- `vault_rewards`, `guild_item_discoveries`, `game_config_state`, `game_config_overrides`.

### Foreign keys, indexes, and destructive publication

The only declared `REFERENCES` edge in the inspected schema is `duckduckgo_tag_attempts.character_id -> characters.id ON DELETE CASCADE`. Most logical references have **no foreign key**. `PRAGMA foreign_key_check` alone cannot prove conversion completeness.

`lib/catalogDb.js:publishCatalog` currently copies published rows to temporary tables, deletes **all** `characters`, clears `tag_candidates`/`tag_match_progress`, and reinserts the catalog. With foreign keys enabled this deletes search-attempt history through the cascade even if the same character IDs are reinserted. Do not use this publication routine to perform UUID migration. Future publication must update/upsert stable identities and published rows without delete/reinsert cascades. Decide whether the attempt FK should target permanent identities instead of transient publication; preserve historical attempts regardless.

- [ ] Rebuild integer-primary-key tables; SQLite `INTEGER PRIMARY KEY` cannot simply hold UUID text.
- [ ] Recreate every PK, unique, reverse lookup, owner, and partial-active index in the replacement schema.
- [ ] Preserve all non-character primary keys, autoincrement high-water marks (`sqlite_sequence` where applicable), and message uniqueness constraints.
- [ ] Use explicit column lists, not `INSERT ... SELECT *` or positional `VALUES` copied from the old schema.
- [ ] Copy dependent attempt rows before any destructive schema work; test rollback with FK enforcement enabled and injected failures.
- [ ] Prefer a fully constructed, verified replacement schema/copy transaction over fragile in-place cascading ID updates. If constraints must be disabled for a rebuild, scope that offline, restore enforcement before restart, and verify all logical anti-joins as well as declared FKs.

## 3. JSON inventory: transform by producer and shape

Never recursively replace every number, every `id`, or every key matching an old character number. Preserve text (including historical human-readable IDs in messages/URLs) unless an explicitly designed display conversion is necessary. Known unmodified payloads can be copied byte-for-byte. A rewritten payload must preserve all unrelated fields. Parse errors, unknown character-bearing shapes, or unknown action kinds must block the rehearsal/commit with table/row/path diagnostics, not become `{}`/`[]` silently.

| Storage and producer | Shape / typed paths | Action |
| --- | --- | --- |
| `item_actions.selections_json`; `lib/itemActions.js`, `lib/itemActionRuntime.js` | Ownership choices at `own`, `targets[]`, and Hostage `originals[]`: `{characterId, marriageId, ownerId, rank?, name?}` | Map **only** each `characterId`; numeric marriage IDs/ranks remain. Also inspect retained/canceled/expired actions, not just live ones |
| Same selections | `inventoryIds[]`, `users[]`, `_ui` slot/page/message fields, `_rules`, `_rewardPools` | Not character identities: inventory IDs, Discord strings, UI state, configuration and item definitions. Preserve |
| `item_actions.result_json`; `lib/itemActions.js:finish` | Counterfeit Crown `privateCharacter.characterId`; Chaos Exchange **`character.id`** (catalog reward row); forced-divorce `originals[].characterId`, `targets[].characterId`; Masquerade same arrays; Hostage `loser.characterId` when non-null and `characters[].characterId` | Kind-dispatched mapping. `character.id` is a critical exception to the usual `characterId` field name |
| Same results | Alchemist `rewardId`; Kaimetsu `actorId`, `totalDivorced`, `affectedOwners`, `noCost`; cancellation/expiry status/message; Masquerade `assignment[]`; Hostage `choice` | No character mapping for those values. Kaimetsu does **not** persist its selected-character list in the current result |
| `item_actions.crown_json`; Hostage activation/cancellation | Array of raw crown rows `{guild_id,user_id,character_id,marriage_id,generation_id}` | Map `[].character_id`; preserve all other IDs. Needed even after action cancellation for retained history |
| `item_action_costs.snapshot_json`; Hostage escrow | Raw inventory row `{id,guild_id,user_id,item_id,charges,acquired_at}` | No character fields. `id` is inventory ID. Keep byte-for-byte unless settlement removes escrow after auditing it |
| `mystery_sessions.state_json`; `lib/mysteryCoordinator.js`, `lib/mysteryEvents/*` | Reserved `{gameConfig}`; subsequent event state plus captured rules/config | Current built-in states do **not** contain character identities. Scalar session `character_id` is the target; preserve state, not generic `id` conversion |
| Doors state | roller Discord ID, winning door, status/deadline | Preserve |
| Treasure Hunt state; `treasureHunt.js`, `treasurePuzzles.js` | puzzle ID, answer/clues, clue index, timestamps | Preserve puzzle ID/answer even if numeric-looking |
| Clue Reveal state; `clueReveal.js` | `animeId`, title, aliases, clues, stage, `guessedAtStage` keyed by Discord user, rules/start time | `animeId` remains numeric; user-keyed map is not a character-keyed map |
| Greed Chamber / Deadlock state; `roundContest.js` | `players`/`choices` keyed by Discord users, rounds, scores, phases/timing/rules | Preserve keys and numeric scores/choices |
| `character_rolls.rules_json` | `rules.windows` snapshot (claim/escape/report durations) | No character identities; preserve |
| `active_user_buffs.data_json`; `lib/items/*.js`, `lib/itemRuntimeConfig.js`, `lib/itemStorage.js` | Rule snapshots (durations/counts/thresholds); passport adds `{franchiseId,name}`; legacy/custom JSON may be NULL | No known character identities. Franchise ID remains numeric. Do not mistake `maxRank`/`favouritesThreshold` for identity |
| `vault_rewards.original_json`, `reward_json`; `lib/vaultRewards.js`, `lib/vaultRolls.js` | Item outcome `{item:{id,...},tier,...,_rules,_rewardPools}` | Item IDs, inventory gambling references, weights/config only; no character UUID rewrite |
| `characters` / `stage_characters` JSON-text fields | `name_alternatives`: string[]; `date_of_birth`: year/month/day object; `anime_titles`: string[]; **`anime_ids`: number[]** | Retain published values; anime IDs are not character IDs. Discard stage rows, not published JSON |
| `anime` / `stage_anime` JSON-text fields; `lib/franchiseCatalog.js` | `synonyms`, `genres`: strings[]; `tags`: source tag objects (including numeric tag ID/rank/spoiler flags); `start_date`: date | Preserve published source metadata; no character mapping |
| `tag_search_cache.response`; `lib/danbooruApi.js` | External tag/post/alias API responses | Danbooru IDs remain external numeric IDs. Query cache is not keyed by character identity |
| `game_config_overrides.value_json`; `lib/gameConfig.js`, `lib/gameConfigSchema.js` | Config scalars/arrays/odds rank anchors/item rules | No known character identities; preserve configuration and revision |

`duckduckgo_tag_attempts.details` is diagnostic **text**, not JSON; the same table is written by `scripts/matchGoogleTags.js`. Do not parse/replace numbers in details, names, URLs, descriptions, reference URLs, or historical result messages.

In-memory item results in `lib/items/bloodPact.js`, `wishUponAStar.js`, `pickpocketsHook.js`, `masterKey.js`, and `sirensCall.js` also return character rows/`escapeAttempt.characterId`; these are API/runtime references, not additional durable JSON columns. Siren's durable escape is the `character_rolls` row. Future persistence of these shapes must get an explicit decoder.

Other JSON files/serialization (`data/birthdays.json`, voice-counter entries, daily/account-cookie storage, landmine config, unrelated game UID maps and archived utility commands) are not character-game identity stores. Do not inspect secret-bearing daily/account data or rewrite them as part of this migration.

### JSON implementation checklist

- [ ] Implement per-kind/per-column decoders and a registry of typed character paths, including both camelCase and raw snake_case crown rows.
- [ ] Extract JSON character references **before** building the mapping, even if an action is about to be canceled.
- [ ] Validate expected arrays/objects and nullable Hostage loser; allow known no-character result variants (blocked/no-cost/expired/canceled).
- [ ] Preserve snapshots of historical rank/name/outcome; do not recompute them from today's catalog.
- [ ] Add fixtures in which character, anime, inventory, marriage and puzzle numbers are identical. Assert only the typed character fields change.
- [ ] Report unknown historical shapes as unresolved work; source inspection cannot establish which payload variants a deployment contains.

## 4. Numeric assumptions and consuming code

### Libraries and internal contracts

| Paths | Assumption / required work |
| --- | --- |
| `lib/catalogDb.js` | Identity typedef/row cast and `getCharacterIdentity`, `saveDecision` parameter docs use numbers; `reportCharacterTag` rejects non-integers. Split external `CatalogCandidate.id`/`keepCandidate` numeric validation from UUID identity validation. Replace publication joining stage ID directly to game ID and tie sorting `(favourites DESC,id ASC)` |
| `lib/characterMarriage.js` | `validCharacterId` accepts positive safe integers; all marriage APIs and typedefs use numeric `characterId`. Character-to-franchise `Map<number,...>` keys become UUID strings; franchise group maps remain numeric. `marriageId` validation stays numeric |
| `lib/characterTrade.js` | Same positive-integer validation and numeric request/result typedefs. Ownership SQL/strict comparisons must use a canonical UUID end to end; numeric marriage IDs remain exact guards |
| `lib/gameCharacterLookup.js` | `CatalogSearchCharacter.id` and generic search constraint numeric. Change to opaque UUID; `#1,234` parsing is rank parsing and stays numeric |
| `lib/characterWishlist.js` | Wish typedef/request numeric; strict equality in callers. `ORDER BY created_at,character_id` currently uses numeric identity as secondary order; decide stable tie order explicitly rather than accidentally changing same-timestamp wish ordering to UUID lexical order |
| `lib/characterAvailability.js` | Numeric parameter docs and in-memory `Set(characterIds)`; use UUID consistently in durable and memory reservation/busy/held checks |
| `lib/characterOwnershipDisplay.js` | Map keyed by DB `character_id`, lookup `row.characterId ?? row.id`; avoid mixed number/string keys |
| `lib/tradeRuntime.js` | Numeric `TransferCharacter.characterId` becomes string. Session IDs and `WeakMap<db,Map<number,session>>` are **not** character IDs and remain numeric. Offer/target equality and pending-transfer registration must use UUID |
| `lib/characterRolls.js` | Real character targets flow through queries, claims, marriage checks and mystery rows; prank/vault zero is special. Candidate `ORDER BY c.id` currently determines seeded random offset results. Prefer preserved stable ordering (persistent order/legacy source ordering plus defined new-character ordering), not incidental UUID order, if preserving deterministic fixtures |
| `lib/characterRollRuntime.js` | Captured character, wish matchers, image picker, reports and forced escapes carry identity. `Number(lastInsertRowid)` creates a **roll ID**, not a character ID. `siren:` command-message tokens contain an action UUID, not a character UUID |
| `lib/itemStorage.js`, `lib/itemActionStorage.js`, `lib/itemDefense.js`, `lib/itemActions.js`, `lib/itemActionRuntime.js` | Protection, decoy redirects, ownership choices, Hostage reservation/escrow, results and strict equality need consistent strings. `owned()` uses truthiness, not robust UUID validation. Update JSON contracts as above; keep source/action/inventory/marriage keys distinct |
| `lib/items/aegisOfFidelity.js`, `masterKey.js`, `pickpocketsHook.js`, `sirensCall.js`, `bloodPact.js`, `wishUponAStar.js` | SQL character joins, busy/lock/crown/marriage operations and returned rows. `ORDER BY m.character_id` in Blood Pact/Siren and `ORDER BY c.id` pools may change deterministic outcomes with UUIDs. Keep snapshot tests meaningful with explicit stable selection ordering |
| `lib/items/franchisePassport.js`, `lib/franchiseLookup.js`, `lib/characterMarriage.js`, `lib/characterRolls.js`, `lib/items/bloodPact.js`, `wishUponAStar.js` | Membership currently anime-derived; add shared direct+derived deduplicated membership reads for manual-only identities. Do not convert numeric franchise IDs |
| `lib/franchiseCatalog.js` | `stageFranchiseBatch` appearance tuples `[characterId,animeId]` and publication copy character IDs; resolve external character identity before writing published links. Anime union-find/numeric sort and franchise IDs stay numeric |
| `lib/mysteryCoordinator.js`, `lib/mysteryRuntime.js`, `lib/mysteryEvents/clueReveal.js` | Scalar character identity and runtime captured character. Coordinator `selectedCharacter` re-reads current catalog; rank is separately captured in `rank_snapshot`, but full likes/character snapshots are not currently durably captured. Add explicit terms snapshot for future live-edit guarantees, separate from offline cancellation |
| `lib/characterImages.js` | Rotation key `${guildId}:${characterId}` already string-compatible; no numeric parsing. Portrait fallback currently claims `source:'anilist'`; distinguish manual portrait provenance. Tag pool cache is keyed by tag, not character |
| `lib/haremView.js`, `lib/topCharacters.js`, `lib/franchiseLookup.js` | Read projections/display/list ownership must retain UUID identity while rank stays numeric; include likes provenance where counts are revealed |
| `lib/catalogRanking.js` (pre-existing untracked work) | String-ID pure preview/insertion already exists; not durable revision, schema migration, or serialized publication. Reuse only after reviewing its contract/tests; do not overwrite it |

### Commands, aliases, and display

- `commands/wish.js` **coerces select-menu value with `Number(interaction.values?.[0])`**; remove that conversion and validate/select against allowed UUID choices. `wish`, `wl`, `wishlist` share wishlist paths; preserve `#rank` input semantics.
- `commands/char.js` / `commands/im.js`: chooser values already serialize IDs with `String` and compare strings. Page-jump `Number(input)` is a page number, **not** a character ID. The long-lived collector captures matches/selected metadata; do not remap rank positions to targets after an edit.
- `commands/divorce.js`: chooser already compares `String(row.characterId)`; confirmation falsely labels internal ID as **AniList ID**. Fetch a source reference or display an internal ID accurately. Preserve numeric selected marriage ID in confirmation guards.
- `commands/mm.js`, `mmr.js`, `mymarry.js`, `lib/haremView.js`: marriage list/group and card projections, captured portraits, likes and ownership. Revisit fallback labels that expose internal IDs.
- `commands/top.js`, `lib/topCharacters.js`: numeric page/rank parsing stays numeric; character ownership rows are UUID-bound.
- `commands/ima.js`, `imar.js`, `commands/utils/franchiseCommand.js`, `lib/franchiseModifiers.js`: franchise chooser IDs remain numeric strings; character list rows must combine direct/derived memberships and refresh coherently.
- `commands/w.js`, `h.js`, `mu.js`, `ru.js`, `daily.js`: roll/claim/allowance entry points; do not convert command-message IDs, rank thresholds, allowance periods or roll IDs to UUIDs.
- `commands/trade.js`, `me.js`, `give.js`, `cancel.js`: wrappers around transfer runtime; keep traditional prefix commands.
- `commands/inv.js`, `use.js`: item invocation/forced escape/action handoff; `Number(invIdStr)` is **inventory** ID, keep it numeric. Item IDs are roster strings.
- Likes displays requiring provenance include `commands/char.js`, `commands/mm.js`, `lib/characterRollRuntime.js`, `lib/mysteryRuntime.js`. Append `[generated]` only where a generated count is visible; hidden count must not leak provenance.

### Web and browser contracts

- `web/reviewCharacterTags.js`: decision and report-resolution bodies currently require `Number.isInteger(characterId)`; accept/validate canonical UUID, then verify identity/publication as appropriate. `characterData`/queue/report-history responses expose `id`/`characterId`; change their API type and fallback labels. Rank cursor `before`/`after`, offsets, ports and item grant amounts remain numeric.
- `web/assets/reviewCharacterTags.js`: sends `current.id` as `characterId` without numeric coercion; keep it a string. `localStorage['character-review-rank']`, jump controls and `after` are **rank** state. Old saved rank may point at a different catalog position after edits; re-preview, never reinterpret it as identity.
- `web/reviewFranchises.js`, `web/assets/reviewFranchises.js`: franchise/anime route and body IDs remain numeric. Character counts/joins use UUID columns, and direct memberships need inclusion. Do not globally replace all `Number(id)` calls.
- `web/reviewConfig.js`, `web/assets/reviewConfig.js`, `web/assets/reviewGame.js`, `web/reviewGame.html`, `web/reviewCharacterTags.html`, `web/serveAssets.js`: config numbers, Discord targets, item definitions and shared routes/assets are not character identity parsers. Include new API types/presentation when added.
- `web/portalAuth.js`, `web/login.html`, `web/assets/login.js` are already present work. Session/account IDs are not character UUIDs. Both portal entry points must eventually enforce the approved authorization model; this inventory does not assert that integration is complete.

### External API and scripts

- `lib/anilistCatalogApi.js`: GraphQL character IDs and `[Int]` variables remain AniList numeric IDs. Callers must resolve UUID -> source reference before `characterDetails`, `extraCharacterMedia`, or `characterAnimePage`. Manual-only identities cannot be sent to these queries.
- `scripts/importCharacterCatalog.js`: `keepCandidate`, hydrate batches, `stage.id` joins against `characters.id`, metadata updates, refresh and publication all conflate source/game IDs. Keep scan and stage data source-numeric but resolve through the unique source map at hydration/publication. An occupied link must update the same UUID and respect curated fields/generated likes.
- `scripts/importFranchiseCatalog.js`: `Number(franchise_character_cursor)`, `WHERE id > ?`, `WHERE id <= ?`, `ORDER BY id` and passing `characters.id` directly to AniList are a hard numeric assumption. Traverse a stable source-link worklist/keyset, not UUID-as-AniList or mutable rank. Separate numeric external cursor from resolved UUID appearance tuples; snapshot/revision-check publication.
- `scripts/matchCharacterTags.js`: per-character `tag_match_progress`, decisions/candidate rows and catalog load need UUIDs; name/alias/anime-title JSON is not identity JSON. `tag.post_count` and CLI limits remain numeric.
- `scripts/matchGoogleTags.js`, `scripts/matchDuckDuckGoTags.js`: row `id` becomes UUID in writes/decision joins; result post/tag IDs remain external numeric. Both write `duckduckgo_tag_attempts`; preserve completed attempts. They use rank traversal and saved-attempt filtering, not the franchise numeric cursor.
- All three matchers currently gate on `import_phase === 'complete'`; remove the AniList-completion prerequisite for manual-only catalog/tag management while retaining import permission gates.
- `scripts/syncItemDiscovery.js`, `scripts/probeDanbooruClearance.mjs`, `scripts/deploy.sh`, `anime-img-test/fetch-images.js` do not define a character-reference migration path. Deployment preservation is not a substitute for an offline migration/backup. Do not execute any default CLI here: importer/review/matcher entry points open the default database and some perform network work.

## 5. Caches, captured state, and cross-process reload

| Location | State / migration implication |
| --- | --- |
| `index.js:yoshiko.characterIndex` | Loaded once at startup with `loadCharacterIndex`; stale after portal writes. Introduce durable catalog revision and reload before later catalog-dependent operations |
| `lib/gameCharacterLookup.js` | Builds an array, not an automatically refreshing cache. `char`, wish and item name resolution use it |
| `lib/franchiseLookup.js` | Builds franchise indexes on demand; freshness checks compare `franchise_source_published_at` with `published_at`. Narrow this policy to relevant appearance coverage, not every likes/rank edit |
| `lib/characterImages.js` | Tag -> fetched post pool and guild+character -> rotation/last post. Recreate on migration restart; define metadata/tag invalidation for routine edits |
| `web/reviewCharacterTags.js` | `previewCache` keyed by search query/solo mode, not numeric character identity; safe to drop on restart |
| `lib/characterAvailability.js` | `WeakMap<db,Map<actionId,{guildId,characterIds:Set,expiresAt}>>`; memory-only pending transfers. Restart drops it; reservations in SQLite must be separately released |
| `lib/tradeRuntime.js` | `sessionsByDb`, counter, timers, offer/target marriage+character snapshots, collector closures. Restart drops sessions but does not make old buttons respond gracefully by itself |
| `lib/characterRollRuntime.js` | Escape update timers and forced-delivery maps; captured roll/character/image/window terms. Stop all workers/timers before offline conversion |
| `lib/mysteryRuntime.js`, `lib/mysteryCoordinator.js` | Active runtimes keyed by numeric session, captured character, queues/timers; answer throttles by session/user. Dispose/cancel, not UUID-rewrite memory |
| `lib/itemActionRuntime.js` | Runtime/sweep/delivery state plus durable action selections; sweep rowid cursor is not a character cursor |
| `lib/vaultRuntime.js` | Active vault/reward timers; no character identity, but prevent recovery workers running during migration |
| Commands' component collectors | `char`, divorce, wish, marriage/harem, franchise/top lists capture arrays/page/selection/ownership. Permit captured terms for already running operations in normal editing; migration restarts terminate them |
| `lib/gameConfig.js` | Explicitly no process-local cache; revision reads are config revisions, not an existing catalog revision implementation |

- [ ] Publish catalog/curation changes and a durable revision atomically; serialize bot/portal/importer publication.
- [ ] Reload catalog + relevant membership indexes as a coherent revision, not via portal-process-only notifications.
- [ ] Bound each operation's mixed cached/SQL reads to a consistent revision/snapshot. An existing command may finish with captured data, but a new target must not be resolved by a stale rank.
- [ ] Preserve captured published roll/event rank/likes/outcomes for normal catalog edits; add durable terms capture where coordinator re-reads would otherwise change them.
- [ ] Revalidate pending rank-dependent items/exchanges at confirmation against UUID targets; invalidation cancels without consuming uncommitted costs.
- [ ] Keep Clue Reveal eligibility based on suitable anime; current `available()` already checks it. `reserveRoll` currently returns `unavailable` when no event is selected; approved behavior requires a normal-roll fallback instead.

## 6. Pending interactions: existing settlement APIs and gaps

**Do not run ordinary startup recovery as a migration settlement script.** `index.js` calls mystery cancellation and roll recovery immediately, then item recovery/forced escape delivery/vault recovery after ready. Those paths do not implement the approved maintenance-refund policy.

| Pending class | Existing APIs and actual behavior | Maintenance requirement / gap |
| --- | --- | --- |
| Trade/gift | `lib/tradeRuntime.js:cancelTransfer(ctx)` ends caller's memory session; `prepareTransferCancellation(db,guildId,selected)` returns a synchronous post-commit callback; no costs/ownership move before confirmation | Stop runtime/restart expires memory. Add generic graceful expiry responses; cancellation helper currently says Kaimetsu and matches selected marriages, not global maintenance |
| Confirming item action | `cancelItemAction(db,actionId,guildId,actorId)` only cancels `state='confirming'`, calls `finish` and records no cost | Enumerate every confirming action and cancel idempotently. No item charge was spent yet |
| Hostage awaiting delivery | `cancelUndeliveredHostage(db,actionId)` runs its own transaction, releases reservations/escrow and restores eligible recorded Crowns; Note remains in inventory because charge was not yet decremented | Reuse domain logic or transaction-internal equivalent. “Note restored” is escrow release, **not inserting a second Note**. Preserve Crown marriage/owner checks |
| Hostage active/delivered | `confirmHostageDelivery` deletes escrow then spends a charge; `resolveHostage` exchanges/divorces and timeout **gambles**. No maintenance-safe active cancellation/refund API | Add explicit cancellation path: no exchange/divorce/random draw; release both reservations; record terminal reason and refundable consumed Note according to approved policy. Source inventory snapshot is currently removed on delivery, so durable exact refund provenance must be captured before relying on this for future actions. Handle full inventory without losing/duplicating refunds |
| Selected-character disruption | `cancelSelectedCharacterInteractions` closes matching escapes, cancels active/undelivered Hostages, releases escrow/reservations; delivered Note explicitly **stays spent**, undelivered Crown intentionally not restored | Kaimetsu semantics, **not** maintenance semantics. Do not reuse wholesale and claim refunds are handled |
| Mystery session | `cancelActiveMysteries(db,now)` closes active session and origin roll; `endMysterySession(...outcome:'canceled')` closes one; `cancelMysteryRuntime` disposes memory first | Useful state settlement; no allowance/buff refund. Keep terminal history and captured state |
| Ordinary/escape/forced roll | `failRoll` marks failed and may finish mystery; `recoverRolls` cancels non-Siren escapes, fails some pending rolls, leaves ordinary open rolls, and deliberately excludes pending `siren:%`; `recoverForcedEscapes` tries to **deliver** Siren rolls | Add explicit maintenance closure of every pending/open claim/escape, including Siren. Do not let recovery publish old prompts after restart. `failRoll`/recovery do not refund roll allowances, consumed roll buffs or Siren costs |
| Vault/item rewards | `lib/vaultRewards.js` and `lib/vaultRuntime.js:recoverVaultRewards` settle/deliver item outcomes; no character identity | Preserve already determined item rewards. Either drain safely before maintenance or retain valid reward state with versioned controls/recovery; do not blanket-delete vault history or gamble it for migration |

### Refund feasibility and hard gates

`reserveRoll` spends allowance and may consume passport/clover/pinata/fever effects before publishing; `character_rolls` does not store a complete payer/period/buff-cost journal. Siren's Call spends an item through item invocation and writes `siren:${randomUUID()}` plus target ownership, but that roll does not contain an exact source-inventory cost snapshot. Delivered Hostage loses its escrow snapshot. **Existing data is insufficient to promise automatic exact refunds in all cases.** Do not invent a payer from `command_message_id`, refund a new reset period blindly, or claim a generic refund API exists.

- [ ] Before rollout, implement a durable consumption/refund ledger (action/roll, payer, period, inventory/buff snapshot, amount, reason, refund idempotency key). Settlement and refunds must be atomic.
- [ ] For already-pending legacy interactions, prefer a controlled drain/finish period before the final offline stop. No new actions while draining. Final migration still checks for leftovers.
- [ ] If leftovers lack provenance, produce a blocking exception report and an explicitly approved reconciliation; do not guess, silently lose costs, or perform game outcomes to clear them.
- [ ] Preserve existing spent costs of completed gameplay; refund only the classified canceled/refundable costs, once.
- [ ] Do not call transaction-owning APIs from inside a larger `BEGIN` without refactoring internal settlement operations; current `transaction` wrappers are not nested transaction support.
- [ ] Run memory-only cleanup synchronously after successful commit, never before a potentially failing commit (existing Kaimetsu helper documents this rule).
- [ ] Keep cancellation records and delivery state. A retry must neither transfer/divorce nor refund twice. Do not delete pending rows just to achieve zero reservations.

## 7. Discord components and legacy expiry

UUIDs fit ordinary select values (36 characters); verify all generated payloads against Discord's 100-character custom-ID/option-value bounds. `${characterId}.${marriageId}` remains delimiter-safe because canonical UUIDs contain no period; validate the whole expected choice against current authorized rows rather than trusting split payloads.

- `commands/char.js`: `char:choose` carries character ID in the **value**; `char:page:*`, image/back/report controls carry no character ID. Collector captures identity.
- `commands/wish.js`: select value is character identity; numeric conversion must go.
- `commands/divorce.js`: selected character value, plus captured marriage guard; no numeric conversion needed for the value.
- `lib/tradeRuntime.js`: `xfer:choose:<sessionId>` carries a **numeric transfer-session ID**; option value is character identity. `xfer:confirm`, cancel and page controls are memory/session-bound.
- `lib/itemActionRuntime.js`: `item:<action UUID>:<verb>` carries action identity; character option value is `<character UUID>.<numeric marriage ID>`. Other values may be inventory IDs or Discord users. Existing message/guild/actor binding remains required.
- `lib/mysteryRuntime.js`: `mystery:<numeric sessionId>:decline|door|choice...`; round/door/choice components remain numeric. Do not rewrite regexes to UUID merely because they contain `\d+`.
- `lib/characterRollRuntime.js` and `index.js`: `roll:report` resolves durable roll by guild/channel/message; reaction claims also use message linkage, not serialized character identity. Closed/canceled old rolls must reject claims/reports appropriately.
- Marriage/top/franchise list paging and inventory/vault controls generally carry page, franchise, inventory, reward or action identifiers, not character IDs. Re-audit if new inline editing controls embed identities.

Approved design requires **no legacy numeric character interaction support**. That does not mean “ignore old components”: add a version/epoch or message-aware expiry mechanism. Old durable item/mystery IDs still resolve after a UUID migration and can match the same grammar; old collector-only controls are otherwise unacknowledged after restart. At the central interaction router in `index.js`, recognize obsolete game namespaces without interfering with current collectors and return an ephemeral maintenance-expired response. Terminal durable states must prevent side effects even when a client retries. Do not translate old numeric character select values to UUIDs for gameplay.

## 8. Import staging and metadata cursor reset

Approved policy is to preserve published data, **discard unfinished staging and checkpoints**, and require explicit network import restarts.

### Character importer (`scripts/importCharacterCatalog.js`)

`catalog_meta` keys to explicitly classify/reset as legacy scan state:

- `import_phase` (`scan`, `hydrate`, `publish`, `complete`).
- `scan_started_at`, `scan_finished_at`, `scan_max_id`, `scan_range_start`, `scan_page`.
- `scanned_media`, `scanned_pages`, `scan_scope`, `scan_mode`, `stage_limit`, `legacy_unfiltered_range_start`.

These cursors mostly describe **numeric anime scan ranges/pages**, not character UUIDs. They are still discarded under the approved checkpoint policy. Preserve old completion/diagnostic facts in the migration report if needed; do not leave `import_phase='hydrate'/'publish'` pointing at emptied staging, and do not falsify `complete` for a partial scan. Introduce explicit new import state/format markers distinguishing published catalog availability from an in-progress or completed source scan.

### Franchise importer (`scripts/importFranchiseCatalog.js`, `lib/franchiseCatalog.js`)

- Discard `stage_anime`, `stage_character_anime`, `stage_anime_relations` and unfinished `stage_characters` rows.
- Reset `franchise_import_phase`, **`franchise_character_cursor`**, `franchise_import_source_published_at` as resumable staging/checkpoint state.
- Preserve published `anime`, `character_anime`, `anime_relations`, franchise records/aliases/membership overrides.
- Classify `published_at`, `franchise_source_published_at`, `franchise_snapshot_published_at` as published snapshot/completeness evidence, not numeric cursors. Preserve valid old coverage rather than pretending a partial import covered all characters. Replace timestamp-only equality with relevant source-link/appearance coverage and revision semantics.
- Do not compare an old numeric cursor with text UUIDs or resume on rank. Future explicit enrichment scans traverse relevant source links and skip unlinked manual identities.
- Preserve completed tag attempts/decisions and tag matching progress; resetting AniList import cursors is not permission to erase tag-review history.

Manual creation/search/rolls/direct franchises must function when none of these source-import completion markers exists. No migration step may call AniList or automatically enqueue/restart a scan. Keep written-permission requirements on explicitly requested bulk imports.

## 9. Concrete staged implementation and verification

### Stage A — freeze the old behavior without touching production

- [ ] Keep this source inventory as the allowlist; re-run source-only searches for schema declarations, `character_id`, `characterId`, `Number`, JSDoc numeric IDs, JSON writers and component payloads before implementation is finalized.
- [ ] Preserve existing tests and their assertions as a legacy regression suite, including `test/characterIdentity.test.js` version-1 upgrade, publication rollback, numeric tie order and retained tag tests. Do not delete assertions or broaden types to `any` to make UUID errors disappear.
- [ ] Add explicit synthetic v10 fixture builders using `DatabaseSync(':memory:')` or an isolated temporary path and versioned DDL. Never import `index.js` or execute a script entry point to get a database fixture.
- [ ] Keep legacy test execution on a clearly named v10 fixture/API harness during development, then port shared behavior tests via an identity-aware fixture adapter: imported test `42` resolves through source mapping to its UUID, assertions about source IDs remain numeric, gameplay assertions use UUIDs. Retain old migration-input fixtures unchanged. This avoids a permanent production API accepting `number|string` identities.
- [ ] Include a pre-v10 fixture upgraded using the legacy path before explicit UUID conversion. The existing version-1 test deliberately drops `character_identities`; preserve that regression in the legacy suite rather than running its destructive fixture trick against a new UUID schema.
- [ ] Add parallel UUID behavior cases before removing old runtime code. Literal old assertions that internal `id === 42` cannot simultaneously describe a UUID contract; retain them as legacy expectations, not misleading UUID tests.

Current `npm test` is `node --test test/*.test.js`; `npm run typecheck:catalog` uses the narrow `tsconfig.catalog.json` include list. The latter includes identity/marriage/roll/trade modules and some old tests but not all portal, wishlist, importer or item paths. Plan targeted checks plus wider UUID contract tests; do not assume a green narrow typecheck covers this inventory. No baseline pass/fail is claimed by this inventory task.

### Stage B — additive identity and contract foundations

- [ ] Add explicit UUID/internal and source-ID types/validators, source uniqueness, creation origin, likes provenance, persistent tie order, curated aliases/direct memberships, catalog revision, mutation log and idempotency records.
- [ ] Keep the v10 opener available only for explicit legacy fixtures/migration input, not default unattended conversion. New ordinary startup refuses an unmigrated production DB with instructions.
- [ ] Implement isolated resolver/import boundary functions; keep numeric candidate/API handling out of gameplay APIs.
- [ ] Add shared likes formatting and membership reads; review existing ranking helper rather than duplicating it.
- [ ] Introduce consumption/refund journaling and maintenance cancellation before relying on it in conversion.

### Stage C — offline migrator, explicit path only

- [ ] Require an explicit input/output path and expected schema version, with no fallback to `data/bot.sqlite`; refuse a running/writable application target. For development accept only disposable test paths/in-memory handles; do not discover production paths from environment.
- [ ] Implement dry-run/report mode, deterministic validation and a recorded mapping/run ID. A rerun must either use the same recorded mapping or reject an already-converted input, not regenerate different identities into half-migrated data.
- [ ] Parse and extract all retained relational/JSON references; distinguish known sentinel rows before constructing the union/map.
- [ ] Settle pending interactions using maintenance rules; fail on unresolved refund provenance. Do not call random gameplay timeout resolution.
- [ ] Copy/rebuild tables and rewrite classified JSON in a transaction (or build a complete separate output database, verify it, then perform an operator-controlled offline replacement). Never mutate the sole backup. Define failure/cleanup semantics for partial output.
- [ ] Seed tie order from **stored published rank** and verify `(likes DESC,tie_order)` reproduces the old exact order. Do not recalculate ties from UUIDs. Validate any pre-existing rank/count inconsistency and stop rather than silently “repairing” it.
- [ ] Preserve non-character rows, IDs, sequences, timestamps, curated fields/tag decisions and prior unattributed history. Add only truthful migration/system attribution for the migration itself, not invented user attribution.
- [ ] Clear unfinished staging and legacy checkpoints as specified; issue no network calls.
- [ ] Write a machine-readable verification report alongside the migration output in future tooling; this task creates no such files.

### Stage D — UUID consumers, new functionality and coherent publication

- [ ] Port all library contracts, SQL joins, commands, portal requests, JSON codecs and component values listed above in small verified slices.
- [ ] Use stable pool/list ordering where historical tests rely on deterministic random offsets. Do not rewrite random gameplay assertions just to match random UUID ordering.
- [ ] Implement revision-bound preview/confirm, serialized atomic publication, source-aware refresh and direct membership reads; no delete/reinsert publication cascade.
- [ ] Add UUID-length/malformed/stale component tests plus legacy-expiry routing; never add numeric interaction translation.
- [ ] Confirm empty/manual-only operation and imported/manual mixed catalog behavior, including Clue Reveal exclusions and normal-roll fallback.
- [ ] Integrate both portal servers' authentication/role checks, preserving already-present work. No published-character removal API.

### Stage E — synthetic rehearsal acceptance matrix

Use only generated fixtures until a separately authorized backup rehearsal exists:

- [ ] Published identity, identity-only archived/unpublished character, marriage-only/wish-only/tag-only/history-only and JSON-only legacy references all map once; missing identity metadata is reported without dropping retained references.
- [ ] Exact guild ownership, marriage IDs/timestamps, wishes and wish order, tag approvals/no-match decisions/candidates/progress/reports/search attempts, locks and crowns survive modulo documented settlement.
- [ ] Prank and vault `character_id=0` become explicit no-character targets; no UUID is generated for zero. Zero elsewhere blocks conversion.
- [ ] JSON rewrite covers every typed path, preserves same-valued non-character numbers, handles NULL loser/crown arrays/no-cost variants, and rejects corrupt/unknown payloads.
- [ ] Pending ordinary/mystery/escape/Siren/confirming item/undelivered Hostage/active Hostage fixtures settle without transfers, divorces, random outcomes, extra charges, duplicated refunds or leftover reservations/escrow. Full inventory and expired allowance periods are covered.
- [ ] Inject failures after settlement, mapping, child-copy, JSON rewrite and schema swap; verify rollback/output isolation and idempotent retry. Exercise the cascading attempt edge explicitly.
- [ ] Preserve every published anime/franchise relation and override; remove only staging/checkpoint state; an incomplete scan does not become completed enrichment.
- [ ] Exact tied rank order survives; new imported ties use source-ID order only within the new batch. Manual insertion/reposition meets boundary/equal-like/overflow/stale/idempotency rules.
- [ ] Independent bot/portal DB connections see one coherent publication; already captured roll/event terms remain stable during ordinary edits, and new actions use the new revision.
- [ ] All tables' character anti-joins to permanent identities return zero unresolved references; published-only constraints are checked separately. Re-extract typed JSON and verify every target exists. FK/integrity checks supplement, not replace, these logical checks.
- [ ] Run targeted tests, full `npm test`, `npm run typecheck:catalog`, and diff checks only in the isolated development/test workflow. Record results rather than inferring them from this document.

### Stage F — separately authorized production gate (not performed here)

- [ ] Measure a full consistent-backup rehearsal, including cancellation/refund exceptions, all table/JSON checks, tied-order checks and recovery timing. Choose a maintenance window from measurement with a buffer.
- [ ] Verify offline backup consistency (including SQLite WAL state), backup checksum/readability, and actual restore using the compatible old application version. Restoring only an old main SQLite file while retaining new WAL/SHM files is not a recovery procedure.
- [ ] Disable new gameplay/portal writes, drain interactions where provenance is incomplete, then stop **bot, both portal servers, importers, tag matchers, reward/recovery workers and any other DB writers**. Confirm exclusivity before conversion.
- [ ] Preserve the verified pre-migration backup and compatible old code/config together. Do not let new code silently migrate the recovery copy.
- [ ] Convert a controlled working copy, verify the full report before replacement/restart, and retain the exact mapping/run record. Any invariant/refund failure is a stop condition.
- [ ] Restart only after verification; old interactions expire gracefully and no pending legacy Siren/Hostage recovery recreates gameplay. Explicitly authorize subsequent import restarts with fresh checkpoints and permission gates.
- [ ] Rollback is a whole compatible DB+application restore, not a partial reverse-ID update or business undo. Once new gameplay writes begin, recovery requires an explicit decision about those writes; do not silently overwrite them.

## Completion boundary

This inventory is complete for character-reference declarations and consumers visible in the inspected source tree. It is **not** evidence that a production schema matches the source, that every historical JSON payload is known, that exact legacy refunds are reconstructible, or that tests/recovery have passed. Those are explicit implementation/rehearsal gates above. No production database access is necessary or permitted for this inventory task.
