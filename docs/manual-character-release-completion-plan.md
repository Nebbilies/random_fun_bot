# Manual-character release — completion plan

## Authority and current verdict

The approved `manual-character-addition-design.md` and `manual-character-addition-plan.md` remain authoritative. This document sequences unfinished work after the database-shape review in `uuid-schema-verification.md`; it does not redefine or reduce feature scope.

**Not production-approved.** See `manual-character-acceptance.md` for current requirement-to-test evidence and `manual-character-addition-progress.md` for implemented checkpoints. Authoritative final-schema startup, mutation services, portal workflows and independent-process tests now exist; the former 576-test checkpoint is historical. Runtime restart uses explicit fail-closed preflight, not complete automatic recovery. Browser adverse-flow/mobile acceptance, operator performance budgets and separately authorized backup/recovery rehearsal remain open. A passing suite does not establish complete release acceptance.

No production access is authorized by this plan. Preserve unrelated working-tree changes. Production rehearsal and rollout are separate, explicitly authorized operations.

## Execution order and gates

### 1. Close and commit the verification corrections

- Review the pending fixes for sequence restoration, non-NULL primary keys, partial picker history and canonical UUIDs.
- Retain real rebuilt-schema tests rather than relying on hand-authored TEXT approximations.
- Extend emptied-table high-water coverage to rolls and mystery sessions, including failed-migration rollback.
- Commit only release-related changes after focused tests, the full suite, type checking and scoped whitespace checks.

**Exit:** all reproduced defects have regression coverage; unrelated glossary/item work remains untouched.

### 2. Establish the final schema and restart contract

- Define explicit target DDL/version for identity/source/provenance/tie order, curation, direct memberships, revisions, previews, audit and idempotency storage.
- Narrow the offline migration input contract to fully upgraded legacy v10. Genuine v1–v9 inputs must fail with instructions to use a compatible legacy application to normalize a disposable copy to v10; do not claim historical compatibility based on version-marker tests.
- Separate new-database creation from existing-database opening. Support fresh empty/manual-only catalogs in the final schema; never silently convert an existing production v10 database at normal startup.
- Add safe pre-cutover refusal for old schemas in new runtime code, and reject future/unknown schemas. Preserve read-only behavior.
- Keep explicit maintenance conversion separate from startup. Release commit mode only after the acceptance gates below; do not simply remove the current version check.

**Exit:** create → close → reopen and migrate → close → reopen work through normal writable/read-only entry points on disposable files. Unsupported versions fail without mutation. Migration failure restores schema, rows, sequences and connection state.

### 3. Finish the shared catalog write/read boundary

- Implement revision-bound preview/confirmation service for create/edit/reposition/source link/correction/unlink and explicit likes-source adoption.
- Validate and calculate server-side; verify AniList references using a bounded fixed-API lookup outside the write transaction.
- Recheck source ownership, uniqueness, relevant revisions and rank neighbors inside serialized commits. Persist mutation, audit, revision and idempotency result atomically.
- Complete source-publication integration: preserve curated aliases/memberships/manual metadata/generated counts and durable tie order. No lock held during network work.
- Add durable direct memberships and one deduplicated shared franchise read model for lookup, marriage grouping, filters and items.
- Replace publication-timestamp freshness with relevant appearance/source coverage. Rank/likes/manual-only edits must not invalidate anime enrichment; source corrections must not retain incorrectly attributed appearances.
- Provide coherent revision-based reloads for bot and portal processes, not process-local notifications alone.

**Exit:** conflict/retry/rollback/concurrent-writer tests prove no lost curation, duplicate identities, stale commits or mixed-revision reads; direct/mixed franchises work without an AniList import.

### 4. Complete gameplay and active-state safety

- Audit every inventoried consumer against the final schema, including items, mysteries, tag tools, URL/component parsing and importers. Keep anime/franchise/marriage/session/inventory IDs distinct from character UUIDs.
- Select and carry likes provenance through lookup, marriage, roll and mystery projections/snapshots. Test actual rendered output: every revealed generated value has `[generated]`; hidden values reveal neither count nor provenance.
- Capture published event terms and retain UUID targets; revalidate pending rank-sensitive actions without changing already-published terms.
- Gracefully expire legacy Discord components. Remove temporary numeric-character compatibility from the final UUID runtime; keep source numbers only at source boundaries.
- For legacy live actions, use an explicit drain-first cutover policy: reject new game mutations, let published actions finish under their existing rules, then stop all writers. Use the reviewed settlement service only for its supported cases. Delivered Hostages/live rolls/Siren/active mysteries must produce actionable refusal diagnostics if still present—never guess refunds, delete state or randomize a maintenance outcome.
- If the chosen operations require canceling a state that cannot be drained, implement and test exact consumption/refund journaling as a separate dependency before allowing that path. New journaling cannot reconstruct missing legacy costs.
- Ensure empty/manual-only responses are clear; unknown gender enters both pools; Clue Reveal requires real suitable anime data.

**Exit:** end-to-end migrated and fresh/manual-only scenarios pass for search, rolls, ownership, trades/gifts, wishes, items and mysteries. Maintenance entry/drain/retry tests prove no cost or reward duplication, no ownership loss and no stale-interaction mutations.

### 5. Deliver the portal workflows

- Build create, search/edit, reposition, source management and audit-history screens on the shared mutation service; no independent portal ranking SQL.
- Include franchise selection/creation, duplicate warnings with explicit override reasons, browser-only HTTPS image previews, generated-count/rank impact and confirmation.
- Handle stale previews and recoverable errors without losing input; retries return the original committed result.
- Test admin/moderator/anonymous permissions on direct endpoints and both server entry points. Retain existing auth and Host/Origin/CSRF requirements.
- No deletion, uploads, arbitrary image fetching, identity merging, free-form likes editor or imported-metadata override expansion.

**Exit:** browser acceptance on desktop/mobile for both roles, empty bootstrap, duplicate review, source conflicts, stale previews and double submits; API tests cover forbidden actions independently of UI visibility.

### 6. Assemble release evidence on synthetic/disposable data

- Run full tests/type checks plus focused final-schema and cross-process concurrency tests.
- Add file-backed migration/reopen and injected-failure tests, row/reference/history/sequence/source/tie-order invariants, publication retention and historical snapshot coverage.
- Run an extended repeat-publication/restart/gameplay test for revision/cache degradation; measure representative synthetic migration and query performance against the old schema. Define acceptable operational latency/downtime from measured deployment requirements, not guessed timing.
- Produce a requirement-to-test checklist with evidence, explicit remaining gaps, supported versions and operator runbook.
- Document maintenance entry/drain, stopping every writer/importer, consistent backup verification, explicit conversion, restart, smoke checks and restoring the untouched backup with the pre-migration application version.

**Exit:** no unresolved data-loss, identity, permission, provenance or concurrency blocker. A green suite alone is insufficient. Ready for an authorized rehearsal, not automatic production rollout.

### 7. Authorized backup rehearsal and release decision

This phase requires separate authorization for handling a consistent production-derived backup. Never open/migrate the live database during rehearsal. Treat copies as sensitive and disable external integrations.

- Preserve an untouched recovery backup; rehearse only on a separate disposable copy.
- Record source commit/schema, backup verification, drain blockers, actual migration time, row/reference invariants, restart results, critical gameplay/portal smoke tests and recovery results.
- Restore another disposable environment using the documented pre-migration application/backup procedure and verify it works.
- Set maintenance duration from measured timings plus a buffer. Record a go/no-go decision and explicit rollout authorization.

**Exit:** successful measured rehearsal and verified recovery, with all release evidence attached. Only then schedule production conversion.

## Parallel work boundaries

After the schema/interface contract is fixed, gameplay provenance and portal UI can proceed in parallel against the same shared service contract. A separate reviewer can expand historical fixtures and migration tests. Schema, mutation, publication and revision ownership should stay coordinated; do not let multiple implementations invent competing write paths. Reserve cross-process and browser acceptance for the integrated result.

## Definition of done

All approved feature requirements are implemented; final-schema startup/restart and supported migration paths are tested; complete gameplay and portal acceptance passes; independent safety review objections are closed; operating docs match code; authorized rehearsal and recovery succeed. Production execution remains a separate recorded action.
