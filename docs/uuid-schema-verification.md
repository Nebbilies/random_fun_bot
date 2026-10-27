# UUID database-shape verification

Scope: re-review of `5085f4b...af10969`, plus corrective working-tree changes. All execution uses synthetic/in-memory databases. No production database, network import, or production cutover was used.

## Findings corrected

1. **Empty AUTOINCREMENT tables lost deleted-row high-water marks.** Rebuild could remove the `sqlite_sequence` row; UPDATE-only restoration then did nothing. Restoration now inserts missing sequence rows and otherwise retains the maximum. A migrated empty-marriage fixture proves the next generation is 901 after deleted generation 900.
2. **TEXT primary keys permitted NULL.** SQLite's implicit non-NULL INTEGER-primary-key semantics do not apply to ordinary TEXT primary keys. Rebuild now explicitly adds NOT NULL to converted primary-key columns that previously relied on that implicit property. Negative identity/catalog inserts are tested.
3. **Partial picker history could block migration after cancellation.** Selecting a later target produces null placeholders in `selections_json.targets`. These reviewed placeholders are now preserved, while actual choices are converted. Result arrays remain strict. A selection → maintenance cancellation → migration integration test covers this.
4. **Case-insensitive acceptance did not match SQLite identity comparison.** The gameplay bridge now rejects noncanonical uppercase UUID input rather than admitting alternate keys; migration mapping normalizes generated values before uniqueness checks. Existing offered UI IDs remain unchanged.

## Actual rebuilt-schema checks

`test/migratedSchemaGameplay.test.js` starts with `openCatalog(':memory:')`, explicitly migrates the real schema to synthetic version 11, and then checks:

- Every inventoried character reference has TEXT affinity, while numeric row IDs remain INTEGER.
- Foreign-key enforcement is restored after migration; foreign-key and integrity checks are clean.
- Marriage, trade, gift, and wish operations preserve UUID identity.
- Reserve → publish → claim works with a UUID target.
- An item action executes and persists UUID result snapshots.
- The four corrected edge cases above.

Existing source-publication tests additionally exercise identity reuse, durable tied order, preservation of cascade-linked history, source-key hydration, numeric external IDs at the franchise API boundary, and transactional rollback.

## Not approved for rollout

- Normal `openCatalog` and `openCatalogReadOnly` still reject version 11. Tests exercising an already-open migrated connection are not restart/cutover acceptance.
- Generated-likes provenance is omitted by multiple lookup/roll/mystery projections. Formatter-only tests do not establish end-to-end labeling; this remains an acceptance blocker.
- Migration input is now explicitly limited to fully upgraded legacy v10. Older versions fail closed with normalization guidance. Genuine v1–v9 conversion is not claimed; use the compatible legacy application on a disposable copy before rehearsal.
- Delivered Hostages, live rolls/Siren, and active mysteries still require drain/reconciliation or exact cost provenance; settlement intentionally refuses guessed refunds.
- Manual publication/editing, direct memberships, source-change completeness, revision-bound previews/audits and coherent reload integration remain unfinished.
- A verified backup/recovery rehearsal and separately authorized production rollout remain required.
