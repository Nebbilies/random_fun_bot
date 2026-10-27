# Fortune Phase 1 validation record

Work in progress; final results to be recorded after core implementation and independent review.

## Initial checks

- Focused pre-change vault/config/itemlist baseline: 34 passed.
- Changelog focused tests after fixes: 11 passed.
- Full checkpoint while the Fortune test module was being written: 1,143 passed, 1 skipped; the only failed module was the in-progress new Fortune test. This is not a clean final-suite result.
- Fortune/runtime/upgrade targeted checkpoint: 14 passed.

## Independent historical schema smoke check

A read-only reviewer created synthetic file-backed catalogs from the authoritative `catalogFinalSchema.js` and `catalogRuntimeSchema.js` at commit `6854561`, rather than removing extension tables from the new schema.

19 independent checks passed, covering dry-run preservation, committed upgrade preservation, refusal/repeat/late rollback, caller-owned transaction preservation, all four catalog openers, read-only write refusal, Fortune version marker enforcement, and old captured-vault JSON remaining byte-for-byte unchanged. Old snapshots did not gain Fortune capability or redraw saved outcomes.

The standalone temporary audit artifacts were outside the repository; repository regression tests remain the reproducible release gate. No live catalog was opened or upgraded.

## Scope of verification

Discord-facing tests use fake transport and real SQLite; they do not constitute a live Discord acceptance test. All database upgrade checks use synthetic catalogs. Deployment shell fixtures require Git Bash on this Windows host; the default background `bash` resolves to an unavailable WSL installation.
