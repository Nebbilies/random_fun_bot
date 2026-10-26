# Manual-character release acceptance evidence

## Scope and verdict

This records synthetic/disposable development evidence, not permission to handle a production-derived backup or deploy. No production/default database has been opened for this work. The approved design remains authoritative.

The implementation now has authoritative final-v12 create/open/offline-conversion contracts, audited creation/edit/reposition/source/tag/franchise services, authenticated portal workflows, revision-coherent reads, and published character terms. **Not production-approved:** active-runtime recovery remains conservative and production-derived rehearsal/recovery and deployment go/no-go remain separately authorized gates.

## Latest development verification

- Full integrated suite: **845 passed, 0 failed**; `npm run typecheck:catalog` passed.
- Real Chrome replay on both portal entrypoints passed after browser generation fixes; uncaught browser exceptions are monitored and fail the harness.
- Independent source-generation re-review found no blockers for the reported stale-response race; its focused 19 tests passed. Its asynchronous overlap tests use one connection; separate-process catalog-write coverage does not certify every importer interleaving.

## Requirement-to-test map

| Requirement | Evidence |
|---|---|
| Explicit fresh creation, normal writable/read-only file restart, no silent v10 conversion, unknown/spoofed schema refusal | `test/finalCatalogStartup.test.js` |
| Authoritative constraints; recognized legacy v10 only; rollback rows/sequences/connection state; literal reserved-object filtering | `test/finalCatalogStartup.test.js`, `test/characterIdentityMigration.test.js`, `test/migratedSchemaGameplay.test.js` |
| Typed historical UUID adapters, preserved captured terms, unknown variants fail closed | `test/characterIdentitySnapshots.test.js`, `test/mysterySnapshotIntegrity.test.js` |
| Supported drain settlement, escrow/reward/cost boundaries | `test/characterMigrationSettlement.test.js`, `test/catalogMaintenance.test.js` |
| Exact insertion/reposition, generated likes, tie order, unknown input, no free-form counts | `test/catalogRanking.test.js`, `test/manualCharacterMutations.test.js`, `test/catalogMutations.test.js` |
| Audit attribution, stale previews, atomic rollback and durable exact retry | `test/manualCharacterMutations.test.js`, `test/catalogMutations.test.js`, `test/catalogSourceMutations.test.js` |
| Fixed source verification, uniqueness, correction/unlink provenance, no orphaned manual membership | `test/catalogSourceMutations.test.js` |
| Staged character source binding; no stale unlink resurrection; imported/manual publication retention | `test/characterImportSourceBinding.test.js`, `test/sourceCatalogPublication.test.js` |
| Direct/derived deduplication, publication/merge retention, appropriate source freshness | `test/directFranchiseGameplay.test.js`, `test/directFranchisePublication.test.js` |
| Independent-process writers, stale races, durable retry and coherent reload | `test/catalogConcurrentWriters.test.js`, `test/catalogCache.test.js` |
| Final UUID APIs, legacy component expiry, rank-invalid item cancellation, mystery fallback without lost buffs | `test/finalGameplayContracts.test.js`, `test/finalInventoryControls.test.js`, `test/uuidGameplayReadiness.test.js` |
| Revealed generated labels and immutable ordinary/mystery/forced terms | `test/characterLikesProjections.test.js`, `test/rollPublishedTerms.test.js`, `test/mysteryPublishedTerms.test.js`, `test/forcedEscapePublishedTerms.test.js`, `test/rollDeliveryPublishedTerms.test.js` |
| Final normal restart plus real runtime calls; preserve costs, no guessed recovery | `test/catalogRuntimeRestart.test.js` |
| Manual-only tag tools, fresh human decisions survive asynchronous matching | `test/finalTagTools.test.js` |
| Both portals, direct auth/role/CSRF checks, source permission, report audit atomicity | `test/reviewCatalog.test.js`, `test/portalAuth.test.js`, `test/characterCatalog.test.js` |
| Browser stale-response generations, confirmation/editor races, franchise selections, paging and permitted curation | `test/catalogBrowserState.test.js` |
| Real Chrome basic create/search/edit/generated-label flows; both entrypoints; desktop admin/mobile-width moderator | `node scripts/checkCatalogBrowser.js --browser <explicit-chrome-or-edge-executable>` |

The browser script starts only loopback test servers with synthetic temporary final catalogs and test credentials. It does not access an existing database, AniList or image content. It uses Chrome DevTools Protocol directly, without installing a browser package. Mobile-width emulation is not physical-phone testing. Source conflicts, duplicates, stale/double-confirm scenarios have API/synthetic-DOM evidence rather than complete real-browser coverage.

## Independent review corrections

Review found and regression tests now cover: schema-name wildcard bypass; unrecognized legacy DDL normalization; derived-only manual franchise loss during source correction; unknown source-service options; unaudited legacy portal tag writes; multiple asynchronous browser preview/editor races; buff loss when no mystery is eligible; nonterminal rank-invalid item refusal; global numeric-ID bridge; old inventory controls; human-tag overwrite during matching; Google table mismatch; stale character staging after source changes; overlapping restarted scans admitting older in-flight pages. Scan generations now distinguish restarts even at the same source revision.

## Measured synthetic performance

Reproduce with `node scripts/benchmarkCatalogRelease.js --synthetic`. Local Windows x64 / Node 22.23.2 sample; fresh OS temporary databases, no network; 20 query-batch iterations. Full final-schema validation rechecks inherited constraints and is intentionally more expensive than legacy open. Preparing validation inserts once per table reduced repeated statement preparation.

| Operation (ms) | 1,000 characters | 10,000 characters |
|---|---:|---:|
| v10 → final v12 conversion | 410.067 | 10,957.872 |
| Legacy normal reopen | 12.894 | 11.604 |
| Final normal reopen | 79.680 | 2,369.354 |
| Legacy / final character-index load | 2.322 / 2.057 | 15.364 / 45.428 |
| Legacy / final warm-cache batch | 0.555 / 0.654 | 2.179 / 3.767 |

Semantic ranks/names/memberships/ownership and query result counts matched; identities intentionally changed. These are single local samples under development load, not production latency or downtime budgets. Representative backup size, actual hosting resources, acceptable latency, measured recovery and maintenance buffer remain operator acceptance gates.

## Runtime restart limitation

Before enabling bot recovery writes, handlers, timers or Discord login, final-v12 startup invokes `assertCatalogRuntimeRestartReady`. It refuses unresolved pending deliveries, active mysteries/escapes, item/vault reconciliation or missing/corrupt active terms instead of silently cancelling spent costs. Published ordinary claims with durable valid terms can settle once after restart. Trades/gifts remain memory-only and disappear without ownership mutation. Discord delivery interrupted between send and database acknowledgement is not proven exactly-once.

This is tested **safe refusal/degradation**, not a complete durable timer/replay engine. It can require operator intervention following an unexpected crash; never bypass it to start with active blockers. New exact consumption/refund journaling and durable recovery would be needed for automatic resumption of unsupported states. No test or raw SQLite reopen claims otherwise.

## Remaining release gates

- Complete broader real-browser adverse-flow and physical mobile acceptance as appropriate to deployment requirements.
- Resolve or explicitly accept the fail-closed runtime availability limitation; do not claim complete automatic recovery.
- Measure representative synthetic/hosting performance against an operator-approved latency budget; these local samples alone do not supply one.
- Separate authorization to use a consistent production-derived backup, retaining an untouched recovery backup; rehearse conversion, normal restart, gameplay and actual restore.
- Record supported historical variants, measured downtime/recovery window, independent final objections and explicit go/no-go.
- Production rollout is a separate recorded authorization. The CLI deliberately remains rollback-only.

See `manual-character-operations.md` for maintenance and recovery procedure. A complete approved feature/deployment certification must not be inferred while these gates remain open.
