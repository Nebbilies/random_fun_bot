# Character efficiency ranking — implementation plan

Status: Phase 3 approved by the user; test-first implementation and verification are authorized. The user approved [the revised Phase 2 design](./character-efficiency-ranking-design.md). The latest instruction selects a `feat/` branch from updated main and permits separate implementation commits. Deployment remains unauthorized.

## 1. Scope and approval boundary

Implement the approved design without reopening its product decisions. Archive each current `characters.rank` as immutable `legacy_rank`; publish efficiency positions in a new `rank`. Gameplay continues reading `characters.rank`.

The score is `0.5 * count / 149200 + 1.5 * (150837 - claimRank) / 150836`, with each NULL input contributing zero after normalization. Bounds are fixed and unclamped. Compare exact rational numerators, then known Mudae rank ascending, applicable legacy rank ascending, and canonical UUID ascending. The legacy key applies only when both raw inputs are NULL; applicable known keys precede absent keys. Explicit count zero is present data.

Use one approved Danbooru tag for scoring and images. Manual portal verification accepts active category 3 and 4 tags; copyright previews warn about franchise-wide scoring and images. Images remain general-rated. Automatic matching stays character-only. Clover, Piñata, and Rolling Fever switch to inclusive rank 1500 at cutover, including existing overrides and active/queued buffs, while preserving remaining benefits.

Implementation uses `feat/character-efficiency-ranking` from updated `origin/main` in an isolated worktree, preserving unrelated local changes. Separate implementation commits are authorized by the latest user instruction. Pushes and deployment remain unauthorized.

Use the existing Node 22.23.2 toolchain, SQLite, Node test runner, standard URL/crypto/filesystem APIs, and installed browser tooling. Add no dependency. Keep traditional prefix commands and existing presentation conventions.

## 2. Proposed public boundaries and test seams

Plan approval includes agreement to these test seams before any tests are written. New names below are proposed interfaces; keep them small and adapt naming to existing conventions during implementation. Do not introduce a second ranking engine or generic migration framework.

| Seam | Interface and observation | Catches | Does not prove |
| --- | --- | --- | --- |
| Ranking | `lib/catalogRanking.js`: pure score/order projection plus transaction-scoped rank application | Exact ties, NULL/zero distinction, fixed bounds, deterministic ordering, collision-safe positions | Remote freshness, UI behavior, deployment safety |
| CSV input | Proposed `lib/catalogRankingInputs.js`: decode and validate paired local CSV inputs; return allowlisted records and hashes | Quoting, coverage, blanks, integer/URL validation, ignored gallery data | Actual target coverage until preflight; remote data truth |
| Danbooru verification | Existing `DanbooruApi` with an explicit fresh approved-tag method and injected HTTP transport | Categories, actual count presence, cache bypass, errors, total counts | Live service availability or correctness of an approved franchise choice |
| Publication | Existing preview/confirm APIs, source publication, and tag approval APIs on temporary SQLite catalogs | Evidence binding, UUID stability, revisions, idempotency, atomicity, preserved archive | Actual process quiescence or browser layout |
| Schema and conversion | Public catalog openers, proposed offline operation API/CLI, and read-only inventory reports | Exact schema recognition, transactional rebuild, preservation, retries, startup rejection, rollback | Operator selecting the correct production backup |
| Gameplay and persistent rules | Existing config/buff readers, item application, roll selection, and proposed cutover inventory/report API | Rank 1500 boundary, refunds/tokens/uses/queues, targeted reset, historical recovery | Discord service availability or every historical message |
| Portal and current rendering | Existing loopback HTTP servers, browser acceptance script, prefix detail/render APIs | Permissions, field removal, warnings, Mudae links, no favourites display | Production proxy/auth configuration and remote image contents |
| Deployment | `test/deploy.sh` with fake services and disposable checkout/database paths | No restart before schema readiness, failure behavior, normal deploy regression | Real VPS service state or successful whole-database restoration |

Use real temporary SQLite databases at persistence seams, including read-only reopen, rather than mocking SQL internals. Query persisted state where the database schema/preservation contract itself is under test; observe normal mutations through their public results/readers. Mock only external HTTP, clocks/randomness where outcomes need control, Discord delivery, and OS/service boundaries. Never use production databases or live API calls in automated tests.

Expected scores/orders come from worked specification examples and fixed literals, not the production comparator. Cover mixed ties through permutation and comparator-consistency cases. Full-roster CSV inspection and operational rehearsal supplement tests; they do not substitute for them.

## 3. File ownership and dependency order

Each slice follows one failing behavioral test, the smallest production change, then its focused checks. Phases 4 and 5 interleave in these vertical slices; do not write the entire future test suite before implementation. Existing tests for removed manual-rank behavior must be replaced with rejection/derived-rank tests, while preserving coverage of unrelated behavior.

Execution dependencies: complete slices 1–2, then the schema/recognition portion of slice 3. Implement slices 4–7 against valid new-layout fixtures. Complete slice 3's full conversion/operation only after slice 7 supplies the tested settings/buff transformation, then finish slices 8–9. Do not expose a bootstrap commit path that omits its eligibility migration. This split keeps schema work available to publication tests without claiming an incomplete conversion is ready.

### Slice 1 — exact score and shared publication ordering

Change `lib/catalogRanking.js` and `test/catalogRanking.test.js`.

- Replace active insertion-likes/reposition behavior with input validation, exact score projection, and deterministic whole-roster ordering. Inventory callers before removing old exports; retain old-only functionality only where the isolated predecessor conversion genuinely requires it.
- Represent the fixed policy once: version 1, integer bounds, rational weights, missing rules, tiebreak sequence. Compute numerator with BigInt operands before multiplication/subtraction; denominator is `45009462400`. Return JSON-safe finite numeric scores and ranks; keep BigInt internal.
- Expose a pure projection usable by previews and validation, plus a write helper operating only inside a caller-owned transaction. Validate canonical UUIDs, unique identities, valid nullable legacy keys, and safe raw integers.
- Assign new ranks 1..N using a collision-safe offset/write sequence under the existing unique/check constraints. Check offset arithmetic before any write. Never offset/rewrite `legacy_rank` or derive tie order from favourites.
- Centralize input and Mudae URL validation here or in the input module below, without circular imports. URL validation uses HTTPS, exact `mudae.net`, no credentials/nondefault port, bounded input without control characters, and `/character/<positive id>/<slug>`. Shared URLs remain legal.

First cases: full reference maximum 2; each component alone; both NULL; zero count; claim 150837; claim above bound; safe-integer extremes; invalid inputs; exact ties despite equal rounded displays. Then exercise known/null claims, applicable/absent legacy keys, explicit zero versus NULL, ASCII UUID fallback, input permutations, empty roster, and unchanged existing scores after additions.

Focused check: `node --test test/catalogRanking.test.js`.

### Slice 2 — local input decoder and bootstrap inventory

Add proposed `lib/catalogRankingInputs.js` and `test/catalogRankingInputs.test.js`. Reuse standard filesystem/crypto and the shared validators.

- Decode BOM, CRLF/LF, escaped quotes, quoted commas/newlines, and terminal records; reject malformed quoting, duplicate/missing/unknown headers, and malformed rows. Treat the exact updated Mudae header including gallery as supported. Consume the gallery cell lexically without JSON parsing or retaining it in returned records, errors, or audit.
- Read the two inputs once per operation, hash the same bytes that are parsed, and validate canonical UUIDs, duplicates, nullable cells, safe integers, tags/count presence, and Mudae URLs. Blank and explicit `NULL` mean missing. Reject tag-without-count and count-without-tag.
- Join by UUID, never names or order. Require matching file ID sets; target-catalog equality is a separate preflight check. Names are diagnostics only. Produce sanitized allowlisted records and provenance using source basenames/hashes, not local attachment paths.
- Use small authored fixtures, including a large quoted gallery cell and duplicate URLs. Do not commit the supplied exports. Later read-only verification against the supplied files must reproduce 15,409 UUIDs and the design's counts/hashes before cutover rehearsal.

Focused check: `node --test test/catalogRankingInputs.test.js`.

### Slice 3 — recognized schema and guarded offline conversion

Change `lib/catalogFinalSchema.js`, `lib/catalogDb.js`, `lib/vaultFortuneUpgrade.js`, and affected recognition helpers in `lib/catalogReleaseSchema.js`, `lib/catalogRuntimeSchema.js`, and `lib/catalogRuntimeRecovery.js`. Add proposed `lib/catalogPreRankingSchema.js`, `lib/catalogRankingMigration.js`, and `lib/catalogRankingOperation.js`; add the operator adapter `scripts/migrateCharacterRanking.js`.

- Freeze the exact supported pre-ranking v12 DDL and validator before changing authoritative DDL. Share unchanged definitions only where doing so cannot silently move the predecessor contract. Recognize specific historical extensions explicitly; unsupported predecessor layouts must report prerequisites rather than be normalized by the ranking operation.
- New authoritative DDL includes nullable unique positive `legacy_rank`, non-null unique positive `rank`, nullable count/claim inputs, finite stored efficiency, optional URL, and a singleton supported policy. Keep retained legacy fields/constraints valid. Enforce archive immutability against ordinary updates with an exact recognized trigger; later creation writers insert NULL archives.
- Keep `user_version=12` per approved design. Distinguish layouts by exact schema/policy recognition. Writable and read-only new startup reject a known predecessor with a migration-required diagnostic before any automatic additive upgrade. Unknown/partial layouts fail closed. Fresh empty catalogs install the complete new layout/policy; startup never reads CSVs or repairs ranks.
- Isolate existing numeric identity conversion as a prerequisite producing a recognized pre-ranking layout. Update `lib/characterIdentityMigration.js` and `lib/catalogConversionOperation.js` only as needed to keep that existing conversion explicit and separate. Do not repurpose its v10-only CLI or silently populate zero metrics there.
- Offline conversion owns one `BEGIN IMMEDIATE` transaction. Recheck predecessor, bound revision, input hashes, maintenance/drain evidence, and all affected state before writes. Inventory configuration/buffs before the rebuild; malformed targeted state blocks the transaction.
- Rebuild `characters` to the exact authoritative layout using the safe SQLite table-rebuild sequence. Copy each old rank unchanged into `legacy_rank`; import metrics/URL; retain every UUID and other retained column. Handle foreign-key enforcement outside the transaction only as required by SQLite; perform full foreign-key/integrity validation before commit and restore connection settings. Prove dependent indexes, triggers, relationships, and no cascade loss.
- Import nonblank tags as approved decisions and blank tags as durable manual `no_match`; do not call APIs. Apply shared score/order projection and the targeted config/buff conversion from slice 7. Bind actor, policy, source hashes, revisions, changes, preservation inventory, and final result to the existing CLI audit protocol without pretending the predecessor had the new schema.
- Record one-time bootstrap identity in durable attributed state. An identical committed retry reports the existing result without recapturing archives, advancing revisions, or resetting buffs/settings. Changed bootstrap hashes/policy fail with instructions for a separate later publication. Failures before commit roll back schema, data, audit, and revisions together.
- Reuse narrow operator evidence/path/transaction patterns from `lib/catalogConversionOperation.js`; avoid copying its entire operation or weakening its existing guards. New operation reports start, validation, and final outcome to a unique fsynced report. On ambiguous commit/report errors, reopen read-only and distinguish committed, rolled back, and uncertain outcomes.

Tests: extend `test/finalCatalogStartup.test.js`, `test/catalogReleaseSchema.test.js`, `test/characterIdentityMigration.test.js`, `test/catalogConversionOperation.test.js`, and `test/catalogRuntimeRestart.test.js`; add proposed `test/catalogRankingMigration.test.js` and `test/catalogRankingOperation.test.js`. Keep predecessor/new fixtures distinct. Cover old-binary rejection through preserved predecessor validation against the new layout, plus an actual old-binary startup in rehearsal.

Use inventory/report readers to compare archive values, UUID references, unaffected rows, snapshots, and dependent schema before/after. Inject failures at meaningful operation stages to prove rollback and retry outcomes. Test invalid policies, partial schemas, missing/extra CSV IDs, malformed targeted buffs, wrong revisions, same-input retries, read-only reopen, and immutable archives. A valid manually created empty catalog must remain supported.

### Slice 4 — fresh evidence and every tag writer

Change `lib/danbooruApi.js`, `lib/catalogMutations.js`, `lib/catalogDb.js` (`saveDecision`), `web/reviewCatalog.js`, `web/reviewCharacterTags.js`, and the three tag-matching scripts.

- Add an explicit fresh approved-tag lookup accepting categories 3/4 for manual portal use. Existing `exactTag`, search, alias, and automatic matching defaults remain category-4-only. Do not broaden the global defaults to satisfy the portal.
- Bypass the indefinite request cache for ranking evidence. Require an exact active tag name, allowed category, and present nonnegative safe integer total `post_count`. Missing count, malformed data, rate limit, timeout, or lookup failure blocks preview. Never reuse search helpers that default absent counts to zero.
- Normalize server-obtained evidence to tag, category, count, observation time, and verification context. Bind it to the stored preview hash/revision; clients cannot supply trusted evidence, count, efficiency, rank, or policy. Do not rely on mutable cache rows as confirmation authority. No network calls inside confirmation locks.
- Both portal entrypoints and report decisions use the same allowlist and evidence rules. A category-3 preview explicitly warns that the count and image pool cover a franchise and may show other characters. Keep the image picker general-rated with the shared approved tag.
- Tag approvals/no-match transitions atomically update decision, count, score, ranks, audit, and catalog revision. Preserve Mudae inputs/URL and archive. Candidate discovery remains nonpublishing. Direct `saveDecision` calls on ranked catalogs must supply valid trusted publication context or fail; adapt every actual writer instead of silently leaving stale scores.
- Automated approvals obtain fresh category-4 evidence before publication; matching candidates/caches are not score evidence. Preserve explicit manual no-match decisions.

Tests: extend `test/finalTagTools.test.js`, `test/catalogMutations.test.js`, `test/reviewCatalog.test.js`, and relevant matching/API tests found by caller inventory. Add a focused API test file only if no existing HTTP-boundary fixture fits. Verify every rejected category, missing/deprecated tags, cached success with fresh failure, fresh zero, above-bound count, stale revisions during fetch, manual copyright acceptance, character-only automation, report paths, and no API request on no-match. Confirm preview failure leaves published state unchanged.

### Slice 5 — derived-rank manual creation and edits

Change `lib/manualCharacterMutations.js`, `lib/catalogMutations.js`, and `lib/catalogMutationProtocol.js` only where its payload contract requires extension. Reuse existing auth, roles, origins, preview expiry, duplicate warnings, attribution, revisions, hashes, and exact retries.

- Accept nullable tag/claim rank and independent Mudae URL; reject manual rank/reposition/count/score/policy fields and old operations server-side.
- Mint a new UUID during preview; bind it into the hashed stored payload and reuse it at confirmation. Project rank using that UUID, the captured count, and current roster. Use the same shared ordering inside confirmation.
- Metadata-only and URL-only edits do not refresh external counts or alter scores. Ranking-input edits use fresh Danbooru preview evidence when a tag is supplied. No tag means NULL count and no network request. Validate combined edits consistently.
- Confirmation publishes creation/input changes and all affected new ranks atomically. New legacy fields receive valid neutral compatibility values; `legacy_rank` stays NULL. Revalidate stale previews and preserve idempotent results. Tag/rank/URL-only changes advance catalog revision without fake source/appearance changes.
- Reuse the same public mutation behavior for later CLI stored-input recalculation and manual refresh; do not create a portal-specific score writer.

Tests: extend `test/manualCharacterMutations.test.js`, `test/catalogMutations.test.js`, `test/catalogConcurrentWriters.test.js`, and `test/catalogCache.test.js`. Cover preview/confirm UUID equality, concurrent creation/edit/source publication, expiry and stale failures, unchanged archives, no partial rank writes, exact retry, metadata-only no-fetch, URL validation/shared links, and cache reload across connections.

### Slice 6 — source imports and explicit manual maintenance

Change `lib/sourceCatalogPublication.js`, `lib/catalogSourceMutations.js`, `scripts/importCharacterCatalog.js`, and final-layout publication dispatch in `lib/catalogDb.js`. Add proposed `scripts/recalculateCharacterRanking.js` as a thin adapter over shared ranking/publication APIs.

- AniList merges preserve every existing ranking input, score, archive, tag, and Mudae URL. Source likes may remain inert bookkeeping where constraints require them; they cannot order or exclude new discoveries from the growing catalog.
- New source characters have NULL inputs/archive/URL and score zero. Assign new positions through the same exact whole-roster projection. Preserve source staging tokens, manual entries, franchises, and source/appearance revisions according to the actual changed metadata.
- Source link/correct/unlink stays available and preserves ranking data/UUIDs. Reject `imported-likes-adopt` server-side. Refuse silent resumption of favourites-limited discovery staging; report an explicit growing-mode restart requirement without deleting staging.
- Stored-input recalculation performs no HTTP. Explicit external-count refresh gathers all requested fresh evidence before taking a publication lock, binds its source revision and complete requested ID set, then publishes all or nothing. A failed request or stale source revision publishes nothing. Never reapply bootstrap config/buff resets.

Tests: extend `test/sourceCatalogPublication.test.js`, `test/catalogSourceMutations.test.js`, `test/growingCatalog.test.js`, `test/catalogPublicationRetention.test.js`, and concurrency/cache coverage. Cover no-input discovery, unchanged stored inputs/archives under likes changes, existing metadata rules, rejected old actions/staging, all-or-nothing refresh, and no-network recalculation. Add proposed `test/recalculateCharacterRanking.test.js` for operator parsing/report/read-only behavior.

### Slice 7 — gameplay defaults, saved settings, and active benefits

Change `lib/gameConfigSchema.js`, `lib/gameConfig.js`, `lib/itemRuntimeConfig.js`, `lib/itemStorage.js`, `lib/characterRolls.js`, `lib/items/fourLeafClover.js`, `lib/items/pinata.js`, `lib/items/rollingFever.js`, `lib/items/wishUponAStar.js`, `lib/itemRoster.js`, and `commands/inv.js` as required by their actual ownership.

- Remove supported `minFavourites`/`favouritesThreshold`; use `maxRank=1500` defaults for all three items. Selection and Rolling Fever refund checks use inclusive rank. Keep existing roll counts, pool fallback, item priority, ownership eligibility, refunds, and claim-token semantics.
- Implement the one-time transformation inside the migration module, not startup/config reads. Reset existing affected global/guild cutoffs to 1500, remove obsolete keys, and advance config revision. Preserve other settings; permit later rank-cutoff configuration.
- Inspect active and queued payloads without invoking getters that expire/delete records or re-arm benefits. Update only eligibility in affected buff payloads, including guild Piñata. Preserve record identity, scope, order, counters, timing, refunds, claim-token amounts/records, and other supported data. Unrelated rows remain byte-for-byte identical. Malformed targeted payloads block preflight.
- Wish Upon A Star first determines the franchise's top three by current new rank, chooses randomly among eligible members of those three, then falls back to the best eligible franchise member. Do not compute the top three after filtering availability.
- Keep all other rank odds/threshold formulas unchanged. Existing captured roll/mystery outcomes and ranks remain historical; pending rank-dependent actions keep revalidation/cancellation and no uncommitted cost consumption.

Tests: extend `test/gameConfig.test.js`, `test/gameConfigRuntime.test.js`, `test/itemRuntimeConfig.test.js`, `test/itemEffects.test.js`, and migration preservation cases. Check ranks 1499/1500/1501 against contrary favourites, configured later overrides, preserved five/ten roll defaults and two-roll refund constraints, Piñata token records, queued timings/counters, malformed payload rollback, and retry after post-cutover custom settings. Include franchise top-three versus top-three-available cases.

### Slice 8 — portal, live detail links, and historical presentation

Change `web/reviewCatalog.html`, `web/assets/catalog.js`, `web/reviewCharacterTags.html`, `web/assets/reviewCharacterTags.js`, and corresponding HTTP projections. Update `commands/char.js`, `commands/mm.js`, `lib/characterRollRuntime.js`, `lib/itemCharacterPresentation.js`, `lib/masqueradeReveal.js`, and necessary character projections in `lib/gameCharacterLookup.js`, `lib/characterMarriage.js`, and `lib/mysteryCoordinator.js`.

- Remove manual rank/reposition, generated likes, likes-adoption, and visible favourites from current portal and bot views. Show editable nullable claim/tag/URL and read-only captured count, score, projected rank, before/after changes, and the copyright warning.
- Render the optional Mudae link safely in portal and live prefix character detail. Keep existing AniList/curated links and image sources. Never fetch Mudae pages/gallery images or copy URLs into historical snapshots.
- Keep v1/v2 snapshot decoding in `lib/characterSnapshot.js` and `lib/characterIdentitySnapshots.js`. Hide historic favourites in current rendering without rewriting serialized ranks, outcomes, or archived messages. Prefer updating consumers; change codecs only if a proven compatibility gap requires it.
- Update `scripts/checkCatalogBrowser.js` and `scripts/benchmarkCatalogRelease.js` fixtures to create valid ranked catalogs. Browser acceptance uses disposable databases, local servers, and injected HTTP evidence; no live external dependency.
- Add only task-related vocabulary updates to `GLOSSARY.md`, preserving its existing unrelated local edits. Replace obsolete active generated-likes/insertion terminology with efficiency, gameplay rank, and legacy rank; retain historic explanations where needed.

Tests: extend `test/reviewCatalog.test.js`, `test/catalogBrowserState.test.js`, `test/itemCharacterPresentation.test.js`, `test/itemCharacterReveal.test.js`, `test/masqueradeReveal.test.js`, `test/characterIdentitySnapshots.test.js`, `test/mysteryPublishedTerms.test.js`, and `test/mysterySnapshotIntegrity.test.js` where relevant. Verify absence of current favourites controls/output, copyright warning before approval, optional safely rendered links, preserved source links, existing auth/body limits, historical frozen terms, and current pending-action safety.

### Slice 9 — deployment gate, rehearsal, and final verification

Change `scripts/deploy.sh` and `test/deploy.sh`; add proposed `docs/character-efficiency-ranking-cutover.md`. Update `package.json` with explicit operator aliases only when the CLIs exist. Extend `tsconfig.catalog.json` to include newly introduced ranking/input/migration modules and modified mutation boundaries that are otherwise outside the current roots.

- Existing deployment fast-forwards code and restarts both services. Add a read-only readiness gate using the target application's schema validator after code/dependencies are staged and before either restart. A known pre-ranking layout must leave both services stopped with a clear manual-cutover instruction; no automatic migration, old-process fallback, or restart-on-trap in this state.
- Preserve the existing pre-stop recovery checks, staged dependency behavior, service names, permissions, and successful ordinary deployment path. Test failures around stop/update/readiness/restart and ensure the gate cannot falsely classify a partial/unknown layout as ready.
- The cutover runbook documents the proposed commands below, exact service stop/start points, importer shutdown, verified full backup, offline working-copy promotion, WAL handling, schema/score/config/benefit checks, application revisions, and rollback. No new autonomous service orchestrator is needed.
- Run focused tests per slice, then the complete Node suite, catalog typecheck, shell deployment tests, local browser acceptance, and existing release benchmark on disposable data. Repeat only checks affected by subsequent fixes.
- Rehearse with copies of a representative predecessor database and the exact approved CSV bytes. Compare preservation inventories; verify old-binary restore/start and new-binary start while still isolated. Record time/memory on the 15,409-character input without inventing a new performance SLO. Investigate material regression against existing release expectations before proceeding.

## 4. Proposed operator command contract

These commands do not exist yet. Flag names below define the intended behavior for implementation and the runbook; help text and tests must match the final names. They never start/stop services or fetch data implicitly.

| Command | Default and write behavior |
| --- | --- |
| `node scripts/migrateCharacterRanking.js --db <path> --danbooru-csv <path> --mudae-csv <path> --report <new-path>` | Read-only schema/input/coverage/config/buff inventory and proposed changes. No bootstrap and no network. |
| Same command with `--rehearse` | Execute complete conversion on an explicitly disposable working copy, validate, then roll back; emit evidence. Refuse an already-owned transaction. |
| Same command with `--commit` and required operator evidence | Commit only to a separately named offline working copy. Require actor, expected revision/input hashes, target application revision/runtime, backup identity, restore/rehearsal report references, and maintenance/writer-stop acknowledgements. Refuse default production path, alias/symlink/hardlink targets, missing evidence, and an overwritten report. |
| Same bootstrap command against an already-converted copy | Read-only confirmation of an identical recorded bootstrap, reported no-op. Different inputs/policy are refused; use later publications. |
| `node scripts/recalculateCharacterRanking.js --db <path> --report <new-path>` | Read-only stored-input projection with current policy and catalog revision; no HTTP. Explicit commit mode publishes atomically with attribution and expected revision. |
| Same maintenance command with `--refresh-danbooru` and explicit character IDs or `--all` | Explicitly collect fresh counts for the complete requested scope. Default remains preview/report; commit requires a bound successful preview, expected revision, and normal audit/idempotency fields. No external failure becomes NULL. No-tag rows need no request. |

Use strict flag allowlists; never infer bootstrap from file presence. Rehearsal/commit modes are mutually exclusive. Keep reports free of gallery payloads and absolute attachment paths. Refresh preview evidence must be persisted in the existing authenticated mutation/audit mechanism, not accepted as trusted client-edited report JSON. CLI actor/evidence validation follows the existing operator boundary; a report alone grants no authority.

## 5. Deployment workflow to document and rehearse

1. Finish implementation verification. Record matching old/new application revisions, supported predecessor identity, policy, and CSV hashes from the approved design. The old Mudae file is superseded; bootstrap uses `mudae-full-ranking.csv`.
2. Rehearse inventory, rollback-only conversion, committed disposable conversion, preservation checks, and full restoration with matching binaries. Resolve coverage mismatches before maintenance; blank values are allowed, missing UUID rows are not.
3. Enter maintenance. Finish in-memory dialogs/trades, inspect durable recovery blockers, stop bot/portal/importers and every writer. Verify actual stopped state; drain state alone is insufficient.
4. Take a consistent full SQLite backup using native backup facilities or a verified checkpointed offline copy with correct WAL handling. Verify integrity and restore capability; record backup/application identity. Create an offline working copy from that backup.
5. Run read-only preflight and explicit commit on the working copy with the exact input bytes and evidence. Verify archives, consecutive ranks, scores/policy, tag overwrites/manual clears, URL handling, references/indexes/triggers, targeted settings/buffs, and unchanged historical terms/relationships before accepting the result.
6. Promote the validated whole database while writers remain stopped. Handle target WAL/SHM files under the documented offline procedure so an old WAL cannot replay into the converted main file. Keep backup intact; never mix database files from different states.
7. Run the matching new application's read-only schema/recovery checks, then start matching processes under maintenance. Verify cache revisions, portal preview warning, live new ranks, current rules, and preserved benefits. Reopen only after these checks pass.
8. If checks fail before reopening, stop new processes and restore the verified whole backup with the matching old application. After player writes resume, an old backup restore loses those writes; use a reviewed forward fix or separately designed state-preserving rollback.

This plan authorizes no production run. The final implementation review must make the built commands and runbook concrete before asking for deployment authorization.

## 6. Verification gates and completion evidence

Run from repository root with pinned Node 22.23.2. Proposed test filenames become runnable only after their slice adds them.

```text
node --test test/catalogRanking.test.js test/catalogRankingInputs.test.js
node --test test/catalogRankingMigration.test.js test/catalogRankingOperation.test.js test/finalCatalogStartup.test.js
node --test test/catalogMutations.test.js test/manualCharacterMutations.test.js test/finalTagTools.test.js test/reviewCatalog.test.js
node --test test/sourceCatalogPublication.test.js test/catalogSourceMutations.test.js test/catalogConcurrentWriters.test.js test/catalogCache.test.js
node --test test/gameConfig.test.js test/gameConfigRuntime.test.js test/itemRuntimeConfig.test.js test/itemEffects.test.js
npm test
npm run typecheck:catalog
bash test/deploy.sh
node scripts/checkCatalogBrowser.js --browser <explicit-local-Chrome-or-Edge-executable>
node scripts/benchmarkCatalogRelease.js --synthetic --sizes=1000,10000 --iterations=20
```

The existing benchmark accepts synthetic sizes only up to 10,000; measure the 15,409-row conversion separately during offline rehearsal. Do not point browser, benchmark, migration, or refresh tests at the user's live data. Report each actual result and any environment blocker; do not treat an unavailable check as passing.

Completion evidence must establish:

- Formula, exact ordering, conditional legacy ties, NULL/zero distinction, fixed policy, and shared preview/startup/publication behavior.
- Frozen exact archive values, NULL archives on later additions, supported strict schemas, safe table rebuild, and explicit old/new binary rejection.
- Every tag/source/manual writer follows the shared invariant; fresh total-count evidence and copyright warning coexist with general-rated images and character-only automation.
- Authoritative CSV overwrite/clear behavior, exact ID coverage, independent nullable Mudae URL/rank, legal shared URLs, and no gallery fetch/storage/audit leakage.
- Inclusive 1500 rules and one-time resets preserve remaining benefits and unrelated state; source imports cannot restore favourites ordering.
- Current UI has no favourites/manual ranking controls; historical snapshots/outcomes and UUID relationships remain valid.
- Transaction rollback, stale/concurrent rejection, idempotent bootstrap, manual refresh failure safety, deployment stop gate, verified backup restoration, and representative rehearsal performance.

## 7. Self-review and approval gate

Self-review status: **approved for user review**. The plan maps the approved design to existing ownership boundaries and explicit new adapters, with vertical test-first work and no added dependency. This self-approval does not authorize implementation.

Reviewed coverage includes all four tiebreak levels, exact numerator arithmetic, frozen nullable archives, fresh evidence versus cached discovery, both portal paths, automated/direct tag writers, future source additions, live/queued benefits, historical snapshots, strict version-12 recognition, numeric-conversion separation, idempotent cutover, deployment's restart hazard, and rollback limitations.

The operation uses an offline working copy and whole-database promotion; it does not reuse the existing v10 conversion CLI as if it supported ranking. Same-bootstrap retries cannot reset post-cutover settings or recapture legacy ranks. Proposed tests use public behavior and real temporary databases, with limitations listed at each seam.

Documentation verification passed: both documents' relative links resolve, fenced blocks are paired, no trailing whitespace was found, and Git whitespace checks reported no errors. Referenced missing code/test paths are explicitly proposed additions. Self-review also made the schema-versus-full-conversion dependency explicit and recorded the existing synthetic benchmark's size limit. No application tests, typecheck, migration rehearsal, live-database coverage check, branch creation, or production changes are claimed during Phase 3. Preserve the existing unrelated worktree changes, including `GLOSSARY.md`, promotion metadata, and item-expansion documents.

The user approved the plan and test seams, authorizing phases 4–6 on a `feat/` branch from updated main with separate implementation commits. Report unexpected flaws/degradation for user decisions. Deployment requires separate authorization.
