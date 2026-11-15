# Character efficiency ranking — design proposal

Status: Phase 2 approved by the user. Phase 3 is documented in [the implementation plan](./character-efficiency-ranking-plan.md), which requires separate user approval. No production code, schema migration, service restart, branch creation, or commit is authorized by design approval.

The engineering framework applies. Pause for user approval after this design and again after the implementation plan. Self-review status appears at the end.

## 1. Goal and scope

Replace favourites-derived gameplay ranking with a weighted Danbooru/Mudae efficiency score. Rename the current `characters.rank` to `characters.legacy_rank`, preserving each existing character's exact pre-cutover position. Create a new `characters.rank` as the single published efficiency-derived gameplay position, so existing rank-based mechanics continue to consume the same gameplay field name.

Use the supplied, examined data to initialize the current catalog. Support nullable inputs for custom characters, fresh Danbooru verification during portal preview, atomic rank publication, and explicitly triggered bulk refreshes.

The updated `mudae-full-ranking.csv` supersedes `mudae-ranks.csv` for bootstrap. Add its optional Mudae character URL as reference metadata. Ignore Mudae gallery image URLs completely: do not fetch, render, store, or copy them into audit payloads or character snapshots.

Do not add dependencies, slash commands, a second identity system, automatic periodic refreshes, retirement/removal, arbitrary score overrides, a ranking plugin framework, or a generic undo system. Existing ownership, UUIDs, wishes, source links, franchises, affection, and unrelated item rules stay intact.

This proposal supersedes only the rank/likes-related decisions in [the manual-character design](./manual-character-addition-design.md): requested insertion ranks, generated likes, manual repositioning, likes-source adoption, and favourites-based ordering/presentation. Its other product and safety contracts remain applicable.

## 2. Confirmed product rules

### Score and ordering

The initial fixed, versioned policy is:

- Danbooru bounds: `[0, 149200]`, weight `0.5`.
- Mudae claim-rank bounds: `[1, 150837]`, weight `1.5`. Lower claim rank is better.
- No clamping. Values outside the reference bounds remain distinguishable.
- A missing input stays `NULL` in storage and contributes exactly zero **after** normalization. Never substitute numeric claim rank zero.
- A successfully fetched Danbooru count of zero is valid and contributes zero.

```text
d = 0                         if danbooru_post_count is NULL
    danbooru_post_count / 149200 otherwise

m = 0                         if mudae_claim_rank is NULL
    (150837 - mudae_claim_rank) / 150836 otherwise

efficiency = 0.5 * d + 1.5 * m
```

Assign unique, consecutive gameplay ranks starting at 1, ordered by:

1. Exact efficiency descending.
2. Mudae claim rank ascending, with `NULL` after every known rank.
3. Applicable legacy rank ascending: only when both `danbooru_post_count` and `mudae_claim_rank` are `NULL`, use that character's non-null `legacy_rank`. A better old position wins (`1` before `100`). Characters with an applicable legacy rank precede those without one.
4. Canonical character UUID ascending, using deterministic binary/ASCII ordering rather than locale-sensitive collation.

Derive a nullable legacy tie key independently for each character: its frozen `legacy_rank` when both metric inputs are missing, otherwise `NULL`. Sort that key ascending with `NULL` last, then UUID. Do not conditionally skip comparisons pair-by-pair, which can violate transitivity. An explicit zero Danbooru count is present data and therefore does not qualify for this legacy criterion. When no applicable legacy key exists, UUID is the final fallback.

Both missing inputs produce efficiency zero; the character remains playable. An out-of-bounds known Mudae rank can produce a negative contribution, so a zero-score character can outrank a negative-score character. That follows the agreed unclamped policy; it is not a missing-data exception.

Roster additions do not change bounds or existing efficiency values. Positions can shift when a character is inserted or its inputs change. Policy changes require an explicit full-score recalculation and new policy version, not silently edited constants or roster-derived bounds.

### Inputs, tags, and URLs

- Use total Danbooru tag `post_count` across all ratings for scoring. Continue using general-rated images only.
- Share one approved Danbooru tag between scoring and image lookup.
- Portal validation must permit active copyright tags (Danbooru category 3) as well as character tags (category 4). Both categories use the same approved tag for scoring and image lookup. Copyright tags use their entire total post count and general-rated franchise image pool, with an explicit franchise-wide preview warning. Current source inspection and an isolated lookup diagnostic confirm that the existing implementation permits only category 4. Keep general, artist, meta, and deprecated tags disallowed.
- The supplied CSV tags are already approved and authoritative. Nonblank tags may overwrite existing mappings without a conflict-approval gate.
- Blank CSV tags clear existing approved mappings, store a `NULL` count, and contribute zero. Preserve an explicit manual `no_match` decision so automatic matching cannot immediately repopulate a deliberately cleared mapping.
- A live verification failure, missing/deprecated/invalid supplied tag, malformed response, or missing count fails validation. None becomes a fabricated zero or `NULL`.
- Mudae claim rank is nullable manual input, not an automatically scraped value.
- `mudae_character_url` is nullable reference metadata. It does not influence scores, ordering, portraits, or eligibility. A URL is not required to enter a valid claim rank.
- Multiple catalog characters may share a Mudae URL. Never merge UUIDs or require URL uniqueness.

### Publication and gameplay

- Archive the pre-cutover rank in `legacy_rank` and keep it frozen across every later publication. New characters have `legacy_rank = NULL`, because they did not have a pre-cutover position. The ranking module may read the archive only for the confirmed missing-both-inputs tiebreak. Gameplay thresholds and lookups use the new `rank`, never the archive as a fallback position.
- Remove manual rank selection, repositioning, generated-likes controls, and switching to AniList-managed likes from the portal and active mutation routes.
- For a new character or ranking-input edit, preview fetches the supplied Danbooru tag's count. No tag means no lookup and a `NULL` count.
- Confirmation uses the captured preview result and atomically recalculates rank positions. It does not refresh the rest of the roster.
- External bulk refreshes remain manual. Future AniList discoveries may publish with `NULL` ranking inputs and efficiency zero; existing entries retain their inputs and scores.
- Remove favourites/likes and `[generated]` from current application presentation and gameplay decisions. Existing already-sent historical Discord messages are not mass-edited.
- Clover, Piñata, and Rolling Fever use inclusive `rank <= 1500` by default. Reset existing global/server eligibility overrides and already-active buff cutoffs to 1500 as part of cutover.
- Preserve active buff identities, queue order, remaining uses, start/expiry times, refunds, and claim-token benefits. Only eligibility changes. Wall-clock expiry still advances during maintenance.
- Use a coordinated maintenance window for initial conversion: stop the bot, portal, and importers; verify a SQLite backup; migrate explicitly; start the matching application version. Startup never silently consumes the CSVs or changes ranks.

## 3. Options considered

### A. Replace rank data while keeping the current logic

This looks cheap but is not viable. Startup validates ranks against `favourites DESC, tie_order`; AniList publication and manual mutations also recreate that ordering. Replacing data alone would either fail startup or be overwritten. Favourites-dependent gameplay and displays would remain wrong.

### B. Add a parallel gameplay-rank column and update every consumer

Using a different name for the new active gameplay rank leaves competing positions and requires changing every query, threshold, search index, and snapshot consumer. There is no requirement to keep two active ranking systems. An explicitly archived `legacy_rank`, however, is required by the user and is not a competing gameplay field.

### C. Archive the old rank; reuse its name for the new gameplay rank — selected naming

Rename the old column to `legacy_rank` and preserve its values. Add a new `rank` column for the efficiency-derived position, together with the explicit metric fields and reference metadata. Rank-based callers remain conceptually unchanged because they still read `characters.rank`. Centralizing calculation/publication prevents portal, scripts, source imports, and startup from disagreeing.

The archive is a frozen snapshot, not an alternative gameplay rank or a source to refresh from AniList. Its sole ranking role is the confirmed tiebreak for characters missing both metric inputs. It remains available directly in the database as requested; it does not replace the need for a full rollback backup. This architecture is included in the user's Phase 2 approval.

## 4. Data model and ranking module

### Published character data

The rank-column transition is:

- `legacy_rank`: the renamed old rank, preserving its exact value for every existing UUID. Nullable positive safe integer, unique when present, and immutable after initialization. Multiple new characters may have `NULL`; never assign them synthetic legacy positions or re-number the archived roster.
- `rank`: a newly created, non-null, unique positive safe integer for the consecutive published efficiency-derived position. Every preview, gameplay query, index, threshold, and current-rank validator uses this column.

Add these further fields to `characters`:

- `danbooru_post_count`: nullable nonnegative safe integer.
- `mudae_claim_rank`: nullable positive safe integer; mapped from CSV `mudae_rank`.
- `efficiency`: stored finite numeric result of the active policy, including legitimate negative values; never user-editable.
- `mudae_character_url`: nullable bounded HTTPS Mudae character-page URL; mapped from the same-named CSV column.

Reuse `tag_decisions`; do not introduce a second ranking-only tag column. Count provenance and observation time belong in the existing attributed mutation payload/report. A count belongs to the tag captured in that mutation, not to a mutable global tag-search cache entry.

Add one authoritative singleton ranking-policy record containing a policy version, canonical configuration, and activation time. Version 1 records the agreed bounds, rational weights, missing-input rule, unclamped behavior, and deterministic tiebreak sequence including the conditional legacy key. Validate its exact supported configuration; this is not an arbitrary user-programmable formula engine or a per-server ranking setting.

Retain existing `favourites`, `likes_source`, and `tie_order` columns as inert compatibility/history data for this release. Their existing constraints and source-link bookkeeping still need valid values, but they must not drive live ordering, gameplay, or UI. Do not drop them, reinterpret them as efficiency, or regenerate counts to fit new positions. New rows receive valid neutral legacy fields and a unique legacy tie value; that value does not break new-score ties.

The Mudae URL must not replace AniList `site_url` or a manually curated reference URL. Store it independently, without extending the existing AniList-only source-identity mapping or imposing its one-to-one uniqueness rules.

### Exact ordering without a new dependency

Deepen the existing [ranking module](../lib/catalogRanking.js) rather than creating independent calculations in each writer. Its interface supports projecting a publication for preview and applying the same ordering inside a caller-owned write transaction. It owns validation, score calculation, deterministic tie handling, and collision-safe rank assignment. It performs no remote requests and does not secretly commit its caller's transaction.

For the fixed rational weights, exact comparison can use built-in `BigInt` internally:

```text
N = (0 if count is NULL else count * 150836)
  + (0 if claim rank is NULL else 3 * (150837 - claim rank) * 149200)

D = 2 * 149200 * 150836 = 45009462400
efficiency = N / D
```

All scores share positive denominator `D`, so compare `N` exactly and then apply the confirmed tie-breakers. Convert the rational result to the canonical finite numeric value for persistence/display. Do not rank by rounded display values, an epsilon rule, or independently written floating-point SQL formulas. Internal `BigInt` values never leak into JSON payloads.

No extra score-key column or score-order index is needed initially: the approximately 15,000-row roster is explicitly ranked at publication, and gameplay reads its existing indexed `rank`. Startup recomputes expected scores/order through the same module and rejects inconsistent stored values rather than repairing them implicitly.

## 5. Publication, evidence, and compatibility

### Portal preview and confirmation

Reuse the existing authenticated roles, origin/field validation, preview lifetime, revision checks, payload hashes, mutation audit, and idempotent confirmation results in [the mutation protocol](../lib/catalogMutationProtocol.js).

The requested manual portal allowlist is category 3 (copyright) or 4 (character), not an unrestricted tag search. Update the exact lookup used by manual portal verification, both portal entrypoints/report-review paths, shared mutation evidence validation, cache-key/evidence handling, form labels, and error messages consistently. Preserve character-only defaults for automatic character-tag discovery/matching; broadening a global lookup indiscriminately could incorrectly auto-approve franchise tags for individual characters. Retain exact-name matching, nondeprecated status, strict count validation, and fresh-count evidence. A client-supplied category is not trusted verification.

The user confirmed copyright tags for both scoring and image lookup. Copyright tags generally identify a franchise rather than an individual character: selecting one uses the entire tag's total count for efficiency and can display other characters from that franchise, still restricted to general-rated images. Preview must explicitly identify the tag as copyright/franchise-wide and warn about both the scoring count and image pool before normal confirmation. Retain one shared tag and the existing Preview/Confirm interaction; do not introduce separate scoring/image mappings, silently weaken image-rating filtering, or clamp a large copyright count back to the reference bounds.

Capture catalog revisions before remote verification. Fetch exact active allowed-category tag evidence outside every write transaction. Require an explicitly present nonnegative safe-integer `post_count`; do not use the existing search helpers' missing-count-to-zero fallback. Ranking verification must bypass the current indefinitely cached search response. Reuse the existing transport, timeout, and retry machinery without accepting a stale cached count after a network failure.

Recheck revisions after fetching, then persist a bounded preview containing the canonical tag, count, observation time, nullable claim rank, optional Mudae URL, policy version, proposed efficiency/rank, and affected-neighbor summary. A new character's UUID must be generated and bound in this preview, not generated at confirmation: UUID is now a final tie-breaker, so generating it later could invalidate the previewed rank. The preview reserves no published character or ownership row.

Confirmation must atomically verify the preview, create/update the intended row and tag decision, apply the same rank calculation, update the durable revision, and save audit/result records. Offset existing unique ranks above both old/final ranges before assigning final positions, with safe-integer overflow checks. Never publish intermediate duplicate ranks. Exact retries return the original committed UUID/result even after expiry or revision advancement.

Clients can submit nullable claim rank, tag choice, and Mudae reference URL, not trusted post counts, efficiency, final rank, policy constants, arbitrary verifier URLs, or evidence flags. Metadata-only edits—including a Mudae-URL-only edit—do not fetch Danbooru or change scores. A combined ranking-input edit follows the confirmed fresh-count preview path.

The portal shows editable nullable claim rank/tag/URL, read-only verified count and efficiency, proposed final rank, and before/after changes. Preserve existing metadata requirements, duplicate-warning behavior, and admin/moderator permissions. Present the URL as an optional Mudae link in portal details and the live prefix character-detail view, separate from existing source/reference links. There is no new command or gallery/image UI.

Validate Mudae references with the standard URL parser: HTTPS, exact `mudae.net` hostname, no credentials or nondefault port, and a `/character/<positive numeric id>/<slug>` path. Reject control characters and oversized values. Do not fetch the URL to verify rank, trust its page title, or derive character identity from it. Render it through safe text/link construction, not unescaped HTML.

### Every writer must follow the same rule

- Manual creation and ranking-input edits calculate efficiency and publish positions through the shared ranking module.
- Both catalog-tag editing and the older tag/report-review queue update the shared tag, its count, score, and positions together. Setting `no_match` clears the count and reranks; it does not erase the Mudae input or URL.
- Matching scripts and `saveDecision` cannot directly change a ranked character's tag while leaving its score stale. Their approval path must supply trusted count evidence and use the same score-aware publication. Candidate discovery alone does not publish a ranking change.
- [AniList publication](../lib/sourceCatalogPublication.js) preserves existing `legacy_rank`, ranking inputs, Mudae references, and efficiency. It merges permitted metadata without recreating favourites ordering. Newly discovered characters begin with `legacy_rank = NULL`, missing inputs, zero score, and no Mudae URL; publication assigns only their new gameplay positions through the shared ordering.
- Existing unfinished discovery scans that use the legacy favourites-limited mode cannot silently resume after cutover. Report them and require an explicit restart in the current growing-discovery mode; do not silently trim, adopt, or delete their staging. This keeps legacy favourites-based candidate limits out of the new publication path.
- Source link/correct/unlink operations remain available and preserve the ranking inputs and UUID. Disable the old `imported-likes-adopt` action server-side as well as in the form. Maintain legacy source constraints without using them as a rank fallback.
- A manual stored-input recalculation does no network work. A manual external-count refresh collects all requested fresh evidence first and publishes only after validation succeeds. Any query failure leaves the current published tags, inputs, scores, and positions unchanged. Changing policy requires recalculating every score in one publication.

Ranking/tag/URL-only changes advance the catalog revision so [the existing cache](../lib/catalogCache.js) reloads consistently across processes. They do not invent an AniList source change or invalidate proven anime/franchise coverage. Actual source-link, metadata, or membership changes retain the existing source/appearance revision rules. Stale previews fail safely when any relevant revision changes.

## 6. Bootstrap files and validation

Read these two sources, joined strictly by `character_id`, never names or row position:

- `danbooru-tags.csv`: `character_id`, `full_name`, `tag`, `danbooru_post_count`.
- Updated `mudae-full-ranking.csv`: `character_id`, `full_name`, `mudae_name`, `mudae_rank`, `mudae_character_url`; lexically consume but ignore `mudae_gallery_image_urls`.

The gallery column contains CSV-quoted JSON arrays with many embedded commas/quotes. A naive comma split is invalid even though the column is ignored. No existing CSV decoder was found in the inspected application sources/dependencies. Use a small tested quoted-CSV reader with Node's existing filesystem/crypto facilities; support BOM, CRLF, escaped quotes, and quoted line breaks without adding a dependency or a Python runtime requirement. The bulk file is a local CLI input, not a portal JSON request subject to its 64-KiB body limit.

Accept explicit blank/`NULL` cells as missing values. Validate exact headers, duplicate columns/UUIDs, canonical UUIDs, integer ranges, URL syntax, and tag/count consistency. A tag requires an explicit count; no tag requires a missing count. Source names are diagnostics only and do not overwrite catalog names. Preserve reference URLs as metadata; never use them to merge characters. Ignored gallery JSON need not be decoded or validated as an image list.

Require both CSV UUID sets to match, then compare them with the actual target catalog during preflight. Unknown, omitted, or duplicate catalog IDs block bootstrap rather than fabricating inputs, silently dropping characters, or changing ownership. If the catalog changed since the export, reconcile/regenerate the inputs first. Deliberate blank values are different from absent CSV rows.

The local read-only checks found:

- Both original inputs and the updated Mudae input contain the same 15,409 unique IDs, with no name disagreements or malformed UUIDs in the original pair.
- Danbooru has 1,745 missing tags/counts and 333 explicit zero counts; populated counts and tags agree on presence.
- Mudae has 1,064 missing ranks; 367 characters lack both metrics in the paired original data.
- The updated Mudae file changes no IDs, full names, or ranks. It adds 14,345 populated character URLs; all passed the inspected HTTPS Mudae character-page shape check. Thirteen URL groups are shared across different UUIDs, which must remain legal.
- The existing fixed bounds therefore stay unchanged. The new URL field has no scoring effect.

SHA-256 provenance for the examined files:

```text
danbooru-tags.csv
483e26dda6cc1c6679100578c4182f8af4d5bf315d3fb4fe3e3793e4a7b42a17

mudae-ranks.csv (superseded reference, not a second bootstrap input)
7cf17265609ec361e62418796b4711070185b0851a947f99f9003ace6c89c765

mudae-full-ranking.csv (active Mudae bootstrap input)
89f3add50e8b95a134f9f09cc1fe7ce19f9191573eb1a7a05f64624cc2b8ae67
```

These checks do not establish live-database coverage, validate remote page contents, or authorize production conversion. No production catalog was opened or modified for them. Record source basenames/hashes, policy version, target revision, actor, and before/after changes in the bootstrap report/audit; do not embed machine-specific attachment paths or the ignored gallery payloads.

## 7. Gameplay, presentation, and live state

- **Four-Leaf Clover:** replace `favourites >= minFavourites OR rank <= maxRank` with the new `rank <= maxRank`; initial/default/cutover `maxRank` is 1500. Preserve five default qualifying rolls, eligibility rules, priority relative to Franchise Passport/Piñata, and normal-pool fallback.
- **Piñata:** use the same rank-only filter at 1500. Preserve ten default server-wide qualifying rolls, normal-pool fallback, and the personal extra claim-token benefit.
- **Rolling Fever:** replace `favourites > favouritesThreshold` with `rank <= maxRank`, inclusive of 1500. Preserve ten default rolls and refund up to two already-used rolls, without exceeding normal refund constraints.
- **Wish Upon A Star:** order a franchise by new gameplay rank. Choose randomly among eligible members of its configured top three; if none qualify, select the highest-ranked eligible member of that franchise. Do not reinterpret this as the top three available characters or a global top-three threshold.

These are behavioral changes to eligibility, not mathematically equivalent translations of favourites counts. Existing rank-dependent mystery odds, exchange constraints, and other rank mechanics retain their current formulas/thresholds but consume the new canonical rank. No live favourites-based protection check was found; do not invent a protection change.

Remove `minFavourites` and `favouritesThreshold` from supported configuration, item descriptions, help, activation messages, and mutable buff-rule snapshots. Introduce Rolling Fever's `maxRank` alongside the already-existing Clover/Piñata key. Reset relevant existing global/server rank overrides to 1500, remove obsolete favourites keys, and advance the config revision so stale configuration saves cannot restore them. This is a one-time cutover reset, not removal of the existing ability to configure rank cutoffs later.

Migrate matching active and queued buff rule payloads in place, including server-wide Piñata records. Preserve record IDs, ownership/scope, queue order, remaining counters, start/deadline values, refund/claim-token amounts, and other supported settings. Preserve Piñata claim-token records and their benefits; they must not be consumed, duplicated, or re-armed by migration. Reject malformed targeted payloads during preflight rather than silently replacing them with defaults. Unrelated buffs/configuration stay byte-for-byte unchanged.

Retain already-captured roll/mystery ranks and determined outcomes, plus pending-action revalidation behavior from the existing design. New actions use current published ranks; pending rank-dependent actions revalidate or cancel safely without spending uncommitted costs. Historic snapshot versions and their archived favourites fields remain readable, but current rendering and new gameplay never consult those fields. There is no need for a new snapshot version merely to remove visible likes or attach a live-detail reference URL.

Current renderers, catalog/search projections, character details, marriage views, item reveals, and tag-review details must stop displaying favourites or generated-like provenance. The Mudae URL is an optional reference on live details, not a replacement image or a historical-snapshot enrichment. Keep the current prefix commands and existing Components V2 presentation; do not redesign unrelated UI.

## 8. Schema cutover, recovery, and rollback

The current [authoritative schema validator](../lib/catalogFinalSchema.js) compares exact DDL and explicitly verifies favourites-derived rank order. [Writable startup](../lib/catalogDb.js) and the existing additive-upgrade dispatcher also depend on recognized schema layouts. Merely adding columns or rewriting ranks is not a valid migration.

Recommendation: follow the repository's existing exact-schema recognition convention under `PRAGMA user_version = 12`, with the new ranking-policy record distinguishing the ranked layout. Freeze an exact predecessor definition/validator for offline preflight, update authoritative DDL and empty-catalog creation, and validate the new score/order invariants. Do not weaken exact-schema checking or accept arbitrary version-12 layouts. The substantial CSV/data cutover is explicit, not another automatic first-start additive upgrade.

The original rank is `NOT NULL` and unique, so a bare column rename would incorrectly require a legacy position for future characters. The migration must rebuild the character table to the authoritative new layout, with nullable unique `legacy_rank` and a separate non-null unique `rank`, copying old `rank` values into the archive without modification. Preserve UUIDs, every other retained column, foreign-key relationships, indexes, and triggers; verify them before commit. Enforce frozen archive values against ordinary updates. Recalculate and offset only the new `rank` column, never `legacy_rank`. Do not rename historical JSON snapshot keys or stored roll/mystery ranks: those already capture historical terms and are not the renamed live table column.

An old binary must reject the new schema instead of rebuilding favourites order. A new binary presented with the known pre-ranking catalog must provide an explicit migration-required error, not publish `NULL` scores in place or auto-load attachment files. Unknown or partially converted schemas fail closed. Historical numeric-ID conversion remains a separate prerequisite and must not silently activate efficiency ranking without its approved input set.

Operational sequence, subject to a separate deployment authorization:

1. Rehearse preflight and conversion on a disposable, verified database copy. Validate exact predecessor schema, integrity/references, CSV coverage, and all targeted configuration/buff payloads; produce an input/rank/tag/URL change report and preservation counts.
2. Enter maintenance, finish in-memory trades/dialogs and quiesce new actions, then stop every writer. Preserve durable games under their existing recovery contracts. The existing drain gate alone is not proof that every process or in-memory dialog is stopped.
3. Take and verify a consistent SQLite backup with correct WAL handling, using native SQLite backup facilities or an equivalent checkpointed offline copy. Record application revision, schema identity, source hashes, and backup identity. Do not copy only a live main database while ignoring its WAL.
4. In one owned transaction, revalidate the target and input hashes/revision, install the recognized schema transition while preserving each old rank as `legacy_rank`, import approved tags/counts/claim ranks/URLs, calculate scores and the new `rank`, reset targeted settings/buffs, advance revisions, and persist provenance/audit/results. Use a bound CLI preview/audit entry rather than bypassing existing mutation attribution. No remote request occurs under this lock.
5. Verify authoritative schema, score/order invariants, foreign keys, uniqueness, targeted rule changes, and preservation before commit. Failure rolls back the whole conversion. An identical committed bootstrap retry is a reported no-op; changed inputs/policy require an explicit later publication, never a second one-time reset of live buffs/settings.
6. Start only the matching application version while maintenance remains active. Verify startup/recovery, new-rule reads, preserved identities/relationships, and cache behavior before reopening gameplay.

Before reopening gameplay, rollback means stopping the new processes and restoring the verified **whole** database plus its matching old application. Rehearse that rollback. Never restore only ranks, tags, or one table while leaving converted settings, buffs, or policy state behind.

Once gameplay resumes, restoring the old backup would discard newer player actions. At that point use a reviewed forward correction or a separately designed state-preserving rollback; do not claim that swapping binaries or restoring the old snapshot is lossless. Destructive legacy-column removal is a separate future change, not an implicit final step here.

## 9. Acceptance conditions for later phases

The implementation plan must turn these into focused failing tests before production implementation:

- Weighted formula, missing-versus-zero inputs, exact rational ties, known/null claim-rank ties, applicable legacy-key ordering, UUID fallback, out-of-bounds positive/negative scores, safe-integer limits, and finite stored scores. Test that legacy rank applies only when both metric inputs are `NULL`, known applicable legacy keys precede absent/inapplicable ones, an explicit zero count is not missing, and mixed groups retain a transitive deterministic order.
- Fixed policy independence from roster additions; shared preview/confirmation/startup ordering; no rounding-induced rank disagreement.
- Exact preservation of each pre-cutover rank as immutable `legacy_rank`; `NULL` archives for later additions; no archive changes during score edits, source imports, rank-offset writes, restart, or identical bootstrap retries. Verify new nullability, uniqueness, foreign-key, index, and trigger constraints after the table rebuild.
- Same UUID in new-character preview and confirmation, stale revisions during fetch/confirmation, idempotent retries, unique-rank reassignment, and all-or-nothing concurrent publication.
- Strict fresh Danbooru evidence, successful zero count, absent/malformed count, timeouts/rate limits/deprecated tags, and rejection of cached/fabricated evidence. Preview failure must not alter published data.
- Manual character/copyright allowlist acceptance across both portal entrypoints and shared mutation confirmation; rejection of other/deprecated categories; correctly scoped verification/cache evidence; unchanged character-only automatic matching. Verify that a copyright tag supplies its total count to the unchanged formula and the same tag to the general-rated image picker, with an explicit franchise-wide scoring/image warning during preview. Cover zero and above-bound counts without fabricated values or clamping.
- Full quoted CSV parsing with the updated gallery-bearing input, exact UUID coverage, deliberate blanks versus missing rows, approved overwrites, durable `no_match` clears, source hashes, and repeat-run safety.
- Optional Mudae URL import/edit/display, invalid URL rejection, no page/image fetches, no gallery persistence, independent rank/URL nullability, legal shared URLs, and unchanged AniList/manual reference URLs.
- Portal, tag/report queue, automated tag approvals, manual refresh, and AniList publication all preserve the same score/tag/order invariant. Existing imported/manual metadata and relationships remain intact.
- Inclusive rank 1500 qualifies and rank 1501 does not for all three affected items. Preserve fallback, usage, refund, claim-token, and Wish Upon A Star selection semantics.
- Global/server settings and active/queued buffs migrate only their targeted eligibility fields. Preserve remaining benefits and fail closed on malformed targeted state; unrelated state is unchanged.
- No favourites fallback, manual rank override, likes-adoption route, or visible likes/provenance in active UI. Historical snapshots remain recoverable with frozen ranks/outcomes.
- Exact old/new/unknown-schema recognition, empty/manual-only catalog behavior, future zero-score discoveries, restart/read-only validation, backup/rollback rehearsal, and no mixed-version writer acceptance.

Use the existing Node test runner, catalog typecheck, temporary database fixtures, and configured portal acceptance approach. No new test framework, formatter, browser session, or live service is required merely to approve this design. Broader application tests and operational rehearsal belong to the later Verify phase, not evidence already claimed here.

## 10. Self-review and approval gate

Self-review status: **approved for user review**, including the confirmed legacy tiebreak and copyright-tag support for both scoring and images with a franchise-wide preview warning. Source inspection and an isolated existing-lookup diagnostic verified the current category-4-only restriction; document checks passed for the revisions. This self-approval is not user design approval or authorization to implement.

- Cross-checked the confirmed formula, bounds, weights, missing-data/tie rules, automatic publication, authoritative tag overwrites/clears, total-count/general-image distinction, and all three inclusive 1500 cutoffs.
- Cross-checked old-rank preservation against every publication path: the frozen nullable `legacy_rank` is separate from the new canonical `rank`, future rows do not invent an archive value, table-rebuild constraints are explicit, and historical snapshot keys remain unchanged. Removed the superseded backup-only position and recorded the dedicated-branch preference without creating a branch.
- Recorded the user's additional legacy tiebreak as an independent nullable key, not a pair-dependent comparator, preserving better-position ordering and the distinction between missing and zero inputs. Recorded the user's confirmed copyright scope for both scoring and images, the required preview warning, and unchanged general-rating enforcement. Copyright support remains a design change, not a claim that production validation already accepts it.
- Incorporated both subsequent rollout decisions: coordinated maintenance and zero-score future AniList discoveries. Incorporated the newer Mudae URL source without changing ranks, bounds, UUIDs, or the image policy.
- Checked the current schema gates, mutation/idempotency protocol, tag writers and indefinite-cache hazard, source publication, configuration/buff persistence, snapshot compatibility, and revision-driven cache reload. The proposal addresses these at the responsible shared module rather than adding per-caller workarounds.
- Read-only input checks establish matching file IDs and unchanged Mudae ranks, record the source hashes, and identify shared URLs without proposing merges. No target/production database coverage or remote-page validation is claimed.
- Arithmetic sanity checks confirm denominator `45009462400`, combined reference maximum `2`, Mudae-only maximum `1.5`, Danbooru-only maximum `0.5`, zero Mudae contribution at rank `150837`, and a negative contribution just beyond that bound.
- Document checks passed: relative links resolve, code fences are paired, no trailing whitespace was found, and Git's whitespace check reported no errors. Application tests/typecheck were not run for this documentation-only phase; the acceptance matrix is future work, not a claimed implementation result.
- Forward conversion, pre-reopen whole-database rollback, the post-reopen rollback limitation, old/new binary rejection, targeted buff/config preservation, and destructive-operation exclusions are explicit. Unrelated worktree changes remain untouched.

The user approved this revised Phase 2 proposal, including the new canonical gameplay `rank`, frozen `legacy_rank`, conditional legacy tiebreak, and copyright tags for scoring/images with a preview warning. That approval authorizes preparing and self-reviewing Phase 3 only.

Review [the implementation plan](./character-efficiency-ranking-plan.md) next, then pause for user approval. The user selected a dedicated `feature/character-efficiency-ranking` development branch; create it only when implementation is authorized, not during this approval pause. Do not commit, migrate a database, deploy, or proceed to production code now.
