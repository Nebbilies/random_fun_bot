# Manual-character release acceptance evidence

## Scope and verdict

This records development evidence, not deployment approval. The approved design remains authoritative. Later user-authorized replacement checks now include production-derived backups; see [replacement readiness](./manual-character-replacement-readiness.md) for current evidence. The live database was read only to create a consistent backup including WAL; no live conversion or service cutover has occurred.

The implementation now has authoritative final-v12 create/open/offline-conversion contracts, audited creation/edit/reposition/source/tag/franchise services, authenticated portal workflows, revision-coherent reads, and published character terms. **Not production-approved:** active-runtime recovery remains conservative and production-derived rehearsal/recovery and deployment go/no-go remain separately authorized gates.

## Latest development verification

- Replacement completion: **1,093 passed, one platform-dependent test skipped**; catalog type check passed. Expanded Chrome acceptance passed all four entry-point/role scenarios, including duplicates, stale input, retry, source conflicts/failures, likes adoption and rendered login/logout. See `.replacement-final-tests.log` and `.replacement-browser-tests.log`.
- Authorized current-data VPS rehearsal passed: 15,000 identities, 499 ownership records, 27 wishes and 13,166 tag decisions preserved; conversion rollback, independent restore under old code/runtime, final reopen, runtime guard and manual-character gameplay smoke passed. See [replacement readiness](./manual-character-replacement-readiness.md) for paths, measured times, exact reconciliation decisions and the separate live-cutover boundary.
- Independent standards and spec reviews found no actionable regression in shared confirmation or startup verification changes. Runtime recovery remains a [separate acceptance scope](./runtime-recovery-acceptance.md).

- Latest full integrated suite including guarded conversion and durable runtime recovery: **916 passed, 0 failed**; `npm run typecheck:catalog` passed (`.restart-full-tests-final.log`, `.restart-typecheck-final.log`).
- Independent recovery-safety re-review closed all four prior findings; 12 added tests cover corruption/unknown-state refusal, atomic Whistle recovery, duplicate Golden Hour costs and heart retry. Focused recovery suites passed 52/52.
- Real Chrome replay passed again after runtime schema integration on both portal entrypoints (desktop admin/mobile-width moderator, `.restart-browser-tests.log`); width emulation is not physical-device acceptance.
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

The browser script starts only loopback test servers with synthetic temporary final catalogs and test credentials. It does not access an existing database or AniList; source verification uses deterministic responses and external image URLs are blocked. It uses Chrome DevTools Protocol directly, without installing a browser package. Mobile-width emulation is not physical-phone testing. Source conflicts, duplicates, stale/double-confirm, source failure, likes adoption and login/logout now have real-browser coverage on both entry points and both roles.

## Independent review corrections

Review found and regression tests now cover: schema-name wildcard bypass; unrecognized legacy DDL normalization; derived-only manual franchise loss during source correction; unknown source-service options; unaudited legacy portal tag writes; multiple asynchronous browser preview/editor races; buff loss when no mystery is eligible; nonterminal rank-invalid item refusal; global numeric-ID bridge; old inventory controls; human-tag overwrite during matching; Google table mismatch; stale character staging after source changes; overlapping restarted scans admitting older in-flight pages. Scan generations now distinguish restarts even at the same source revision.

## Measured synthetic performance

The following table records the historical implementation before replacement completion. Current writable startup uses native verification without a full constraint copy; read-only startup retains independent replay after a corruption regression demonstrated it remains necessary. Updated timings and production-derived rehearsal results are recorded in [replacement readiness](./manual-character-replacement-readiness.md).

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

Before Discord login, final-v12 startup invokes the read-only `assertCatalogRuntimeRestartReady`. Valid supported paid states are recovery work rather than blockers: ordinary pending deliveries, bound escape timers, versioned mystery phases, durable unopened vault sessions, and existing item/reward reconciliation. Recovery runs after ready and before game ingress; periodic sweeps retry transient delivery failures. Missing/corrupt terms, unknown states and ambiguous historical outcomes remain named blockers instead of being silently cancelled. Published ordinary claims retain their canonical bindings and original deadlines. Trades/gifts remain memory-only and disappear without ownership mutation. Discord delivery interrupted between send and database acknowledgement is not proven exactly-once.

Recovery regressions use explicit file-backed final-schema creation and normal authoritative reopen, fake Discord/clocks, and interrupted paid workflows. They verify original terms/deadlines, exactly-once database costs and awards, repeated recovery, transport retry and conservative handling of unsupported state. This does not prove exactly-once external Discord delivery or recover memory-only trade/gift conversations. Ambiguous historical or corrupt rows can still require reviewed intervention; never bypass the guard.

## Remaining release gates

The original checklist below is historical. Its production-derived rehearsal, broader browser acceptance and measured-hosting items are now evidenced in [replacement readiness](./manual-character-replacement-readiness.md). The remaining live action is an explicit controlled cutover with source-currentness verification, Node v22.23.2 selection and post-start smoke checks before resuming traffic. Physical-device testing and exactly-once external delivery are not claimed.

- Complete broader real-browser adverse-flow and physical mobile acceptance as appropriate to deployment requirements.
- Review the supported recovery matrix and remaining ambiguous-state/external-delivery limitations; do not claim universal automatic recovery.
- Measure representative synthetic/hosting performance against an operator-approved latency budget; these local samples alone do not supply one.
- Separate authorization to use a consistent production-derived backup, retaining an untouched recovery backup; rehearse conversion, normal restart, gameplay and actual restore.
- Record supported historical variants, measured downtime/recovery window, independent final objections and explicit go/no-go.
- Production rollout is a separate recorded authorization. The CLI defaults to inventory or rollback rehearsal; explicit commit is restricted to separately named offline working copies with the documented acknowledgements and evidence.

See `manual-character-operations.md` for maintenance and recovery procedure. A complete approved feature/deployment certification must not be inferred while these gates remain open.
