# Manual character addition — implementation checkpoint

This is a partial implementation, not rollout approval. The confirmed design and plan remain authoritative. No production database has been opened or migrated.

## Implemented foundations

- Full reference inventory: `manual-character-reference-inventory.md`.
- Shared portal authentication for both server entry points, explicit environment accounts, role enforcement, sessions, CSRF, throttling, login/logout UI, password hash utility. See `portal-authentication.md` before restarting the portal: credentials are now mandatory.
- Pure UUID identity/source-key validation and unique source-link primitives. Not yet integrated into existing numeric-ID consumers.
- Pure rank insertion/reposition previews, generated likes, safe-integer/overflow validation, deterministic integer tie order.
- Shared revealed-count formatter wired into character, marriage, roll and mystery displays. Imported presentation is unchanged; hidden mystery counts stay hidden. Provenance must still be selected/persisted through subsequent schema work.
- Manual metadata validation (HTTPS portrait/reference URLs, explicit gender, nonempty franchise selection, normalized aliases). No manual editor/publication endpoint yet.
- Offline UUID migration foundation and rollback-only rehearsal CLI. Explicit database path is mandatory; CLI rejects default `bot.sqlite`. It neither invokes network imports nor commits a migration.

## Migration limitations — do not deploy as a completed conversion

- Reviewed producer-specific historical JSON adapters now convert item selections/results/Crowns and validate built-in mystery, buff and inventory-escrow snapshots. Unknown shapes, fields, kinds and unresolved references still deliberately block preflight.
- Explicit offline settlement now cancels no-cost confirmations and validated undelivered Hostages, releases escrow/reservations, restores eligible Crowns, and retains cancellation evidence. It preserves determined vault rewards. Delivered Hostages, live rolls/Siren and active mysteries still block: legacy records lack exact cost provenance, so drain/reconciliation or a reviewed consumption ledger is required rather than guessed refunds.
- Existing schema version/initialization is not cut over. Gameplay ownership/trade/wish/lookup and portal parsing now accept UUIDs alongside temporary legacy numeric support. Source-aware character publication/hydration and franchise import are tested against explicitly migrated fixtures. Full consumer, deterministic selection-order, reload/cache and startup cutover acceptance remains unfinished.
- Library commit primitive exists only for explicit future schema integration; normal startup does not invoke it. No production-capable migration CLI is exposed.
- Tests for version gates use current synthetic legacy schemas, not an exhaustive historical schema fixture library.

## Verification at checkpoint

- Before changes: `npm test` — 456 passed; `npm run typecheck:catalog` passed.
- First foundation checkpoint: `npm test` — 504 passed, 0 failed; `npm run typecheck:catalog` passed.
- Historical adapters/settlement/source-publication/UUID-readiness checkpoint: `npm test` — 568 passed, 0 failed; `npm run typecheck:catalog` passed. Includes settlement-to-migration integration and migrated-fixture import/publication tests.
- Database-shape re-review: 576 tests passed, 0 failed; catalog type check passed. Corrected empty-table sequence loss, nullable converted primary keys, sparse picker history, and UUID case acceptance. Actual rebuilt-schema gameplay tests added; see `uuid-schema-verification.md` for findings and remaining acceptance blockers.
- Focused auth verification includes authenticated portal behavior, role/API denial, login/logout and startup validation.
- No production-data rehearsal, measured downtime, or production browser smoke test has occurred.

## Next integration work

1. Expand historical fixtures as needed and finish exact-cost journaling/drain/reconciliation for remaining unsafe legacy live interactions.
2. Coordinate explicit new schema/startup gates and complete UUID consumer conversion/fixtures; retain source IDs only at API boundaries.
3. Finish shared revision-bound preview/confirm publication and source-change completeness semantics. Source-aware import/publication foundations now preserve manual metadata, generated counts, existing ties and cascading tag-search history.
4. Implement durable direct franchise memberships and relevant enrichment completeness.
5. Wire validated preview/confirm mutation service, audit/idempotency, and manual-character portal workflows.
6. Cover coherent cross-process reloads and active gameplay rules; run full acceptance/browser checks.
7. Rehearse on a consistent disposable backup and verify restoration before separately authorized production migration.
