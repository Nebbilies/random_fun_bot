# Character efficiency ranking cutover

Implementation and local verification are authorized. Production deployment, service changes, and production database conversion require separate authorization. All commands below are operator instructions, not evidence that production has been changed.

## Application and data contract

Use Node **22.23.2**. Both catalog layouts use SQLite `user_version=12`; exact DDL and the singleton ranking policy identify the new layout. Current startup rejects the predecessor and unknown/partial layouts. Startup never reads CSVs or recalculates ranks. The deployment script validates the target schema after installation and before either service restarts; a failed gate leaves both services stopped.

Bootstrap copies each existing rank unchanged into immutable nullable `legacy_rank`. Efficiency determines the new consecutive `rank`; later additions have NULL archives. Bounds stay fixed and unclamped:

```text
efficiency = 0.5 × count / 149200 + 1.5 × (150837 − claimRank) / 150836
```

Each missing raw input stays NULL and contributes zero. Order uses exact rational score descending, known Mudae claim rank ascending, applicable legacy rank ascending, then canonical UUID ascending. Legacy rank applies only when both raw metrics are NULL; known applicable keys precede absent keys. An explicit count of zero is present data.

Bootstrap overwrites approved image tags with CSV tags. Blanks become durable manual `no_match` decisions. It imports optional Mudae character URLs and ignores gallery cells. Images remain general-rated. Future portal previews fetch fresh total counts for character or copyright tags; copyright approval warns that scoring and images cover a franchise. Confirmation publishes captured evidence atomically, without refreshing other characters.

At bootstrap, Clover, Piñata and Rolling Fever use inclusive `rank <= 1500` in global/server overrides and active/queued snapshots. Remaining rolls, queue position, timing, refunds and claim tokens are preserved. Valid NULL legacy snapshots receive only the new cutoff. Obsolete favourites keys are removed and config revision advances. Wish Upon A Star chooses among available members of the franchise's top three by gameplay rank, then falls back to its best-ranked available member.

## Inputs and prerequisites

Use the approved two files, joined by canonical UUID:

| Input                    | SHA-256                                                            |
| ------------------------ | ------------------------------------------------------------------ |
| `danbooru-tags.csv`      | `483e26dda6cc1c6679100578c4182f8af4d5bf315d3fb4fe3e3793e4a7b42a17` |
| `mudae-full-ranking.csv` | `89f3add50e8b95a134f9f09cc1fe7ce19f9191573eb1a7a05f64624cc2b8ae67` |

The older `mudae-ranks.csv` is superseded. Both active inputs contain 15,409 UUIDs: 1,745 missing Danbooru inputs, 333 explicit zero counts, 1,064 missing Mudae ranks, 367 missing both metrics, and 14,345 URLs. Shared URLs are legal. Exact target coverage is mandatory; reconcile exports if the target roster differs. CSV names do not overwrite catalog names.

Require a recognized complete pre-ranking v12 catalog. Older additive layouts and numeric-identity catalogs need their existing explicit prerequisite conversion first. Do not bypass schema checks or manufacture zero metrics to make startup succeed. Record the old/new application commits, runtime, input hashes, backup identity, rehearsal evidence and operator identity.

`scripts/migrateCharacterRanking.js` refuses the default/production `bot.sqlite`, aliases and hardlinks. Use a separately named canonical offline working copy. Each report path must be new. Reports are exclusive append-only JSONL, fsynced at start, before commit and at outcome. They contain input basenames/hashes, tag/input/URL/rank changes, targeted rules, and before/after counts/hashes for unaffected tables. The audit retains before/after character and tag state. No gallery payload is persisted.

## Rehearse before maintenance

Rehearse these steps on an independently backed-up copy of the actual target catalog. The local synthetic rehearsal described below does not prove production coverage.

1. Open the source with the matching old application's read-only validator. Run integrity, foreign-key and restart-recovery checks. Resolve blockers through their existing recovery procedures.
2. Use SQLite's backup API to create an independent backup and restore copy. Verify both, including WAL-backed writes. Preserve the original backup unchanged.
3. Run read-only preflight, rollback-only rehearsal and committed conversion on a disposable working copy using the exact CSV bytes. Inspect reports and preservation results.
4. Confirm the old application rejects the converted copy and the new application rejects the predecessor. Open the converted copy through normal writable and read-only startup. Verify a complete backup restore starts with the old application.

Example commands, from the matching new application checkout:

```bash
node --version
# Must print v22.23.2.

node scripts/migrateCharacterRanking.js \
  --db /srv/ranking/working.sqlite \
  --danbooru-csv /srv/ranking/danbooru-tags.csv \
  --mudae-csv /srv/ranking/mudae-full-ranking.csv \
  --report /srv/ranking/preflight.jsonl

node scripts/migrateCharacterRanking.js \
  --db /srv/ranking/working.sqlite \
  --danbooru-csv /srv/ranking/danbooru-tags.csv \
  --mudae-csv /srv/ranking/mudae-full-ranking.csv \
  --report /srv/ranking/rehearsal.jsonl --rehearse
```

Preflight does not change the catalog. Rehearsal runs the full transaction then rolls back. Review its `validated-before-commit` and final `rolled-back` records; neither means production was converted. Malformed targeted settings/buffs, unexpected schema, coverage mismatches and failed validation block conversion.

## Authorized maintenance window

1. Enter the existing `game_maintenance=drain` mode. Finish in-memory trades/dialogs and stop ingress. Inspect durable recovery blockers without inventing settlements. Drain alone is not proof that all writers stopped.
2. Stop bot, portal, scheduled importers and any manual writers. Verify process and service state. The deployed service names are `random-fun-bot` and `random-fun-bot-portal`.
3. Take and verify a consistent whole SQLite backup with its WAL state. Native backup is preferred; never copy only a live main file. Create a separately named offline working copy from that backup. Confirm no symlinks or hardlinks alias it to the source.
4. Repeat preflight on that exact working copy. Record its catalog revision and input hashes. Keep production stopped and the backup immutable.
5. Run explicit commit with real evidence references. Replace the illustrative revision, commits and reference labels below with the inspected values. `--expected-revision` is the preflight's revision, not the post-conversion revision.

After draining and authorization, the service stop point is:

```bash
sudo systemctl stop random-fun-bot
sudo systemctl stop random-fun-bot-portal
systemctl is-active random-fun-bot random-fun-bot-portal
# Require both inactive; also verify all importer/manual writers have stopped.
```

Example native backup from the stopped source, with a new destination path:

```bash
node --input-type=module - /absolute/data/bot.sqlite /srv/ranking/verified-backup.sqlite <<'JS'
import { DatabaseSync, backup } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { validateFinalCatalogSchema } from './lib/catalogPreRankingSchema.js';
const [sourcePath, destination] = process.argv.slice(2);
if (existsSync(destination)) throw new Error('Backup destination already exists');
const source = new DatabaseSync(sourcePath, { readOnly: true });
try { await backup(source, destination); } finally { source.close(); }
const copy = new DatabaseSync(destination, { readOnly: true });
try {
  validateFinalCatalogSchema(copy);
  if (copy.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok'
    || copy.prepare('PRAGMA foreign_key_check').get()) throw new Error('Backup validation failed');
} finally { copy.close(); }
JS
```

Repeat the same native backup procedure from the verified backup to distinct `working.sqlite` and restore-rehearsal paths. Reopen the restore using matching old catalog startup; keep the original backup unchanged.

```bash
node scripts/migrateCharacterRanking.js \
  --db /srv/ranking/working.sqlite \
  --danbooru-csv /srv/ranking/danbooru-tags.csv \
  --mudae-csv /srv/ranking/mudae-full-ranking.csv \
  --report /srv/ranking/commit.jsonl --commit \
  --actor operator-name --expected-revision 0 \
  --expected-danbooru-hash 483e26dda6cc1c6679100578c4182f8af4d5bf315d3fb4fe3e3793e4a7b42a17 \
  --expected-mudae-hash 89f3add50e8b95a134f9f09cc1fe7ce19f9191573eb1a7a05f64624cc2b8ae67 \
  --offline-working-copy --backup-restore-verified \
  --writers-stopped --conversations-drained \
  --source-app-commit OLD_COMMIT --source-runtime node22.23.2 \
  --target-app-commit NEW_COMMIT --target-runtime node22.23.2 \
  --backup-ref verified-backup --restore-ref verified-restore \
  --rehearsal-ref rehearsal.jsonl
```

6. Require final `committed` outcome and inspect the detailed report. Verify exact archived positions, consecutive new ranks, input/score policy, tag clears/overwrites, URLs, preserved UUID relationships and snapshots, foreign keys, integrity, targeted settings/buffs and unaffected-table hashes. Close every connection before promotion.
7. While all writers remain stopped, promote the validated **whole** working database to the configured database path. Preserve the outgoing main file and any WAL/SHM/journal together as recovery evidence. Do not leave outgoing sidecars beside the incoming file: an old WAL must never replay into it. Restore the expected owner and permissions. Keep the verified backup separate.
8. Install/select the matching new application and run its read-only final-schema and restart-recovery checks. Keep maintenance enabled. Start both matching services and check startup recovery, catalog revision/cache reload, portal previews, rank 1500 rules and preserved benefits. Only then reopen gameplay through the existing maintenance controls.

After promotion and successful readiness checks, the service start point is:

```bash
sudo systemctl start random-fun-bot
sudo systemctl start random-fun-bot-portal
systemctl is-active random-fun-bot random-fun-bot-portal
# Require both active, then verify application recovery/readiness while still drained.
```

Read-only final-schema/recovery check after promotion, from the target checkout:

```bash
node --input-type=module -e '
  import { openFinalCatalogReadOnly } from "./lib/catalogDb.js";
  import { assertCatalogRuntimeRestartReady } from "./lib/catalogRuntimeRecovery.js";
  const db = openFinalCatalogReadOnly("data/bot.sqlite");
  try { console.log(JSON.stringify(assertCatalogRuntimeRestartReady(db))); }
  finally { db.close(); }
'
```

An identical committed bootstrap retry reports `already-committed`; it does not recapture archives, reset live settings/buffs or advance revisions. Different input hashes require a later publication. A missing final report or an `uncertain`/`inspect-required` outcome never proves rollback: preserve evidence and inspect through a new read-only connection before retrying. Never edit a report to grant authority.

## Later ranking maintenance

Approval automatically recalculates positions. AniList publication preserves existing ranking inputs and adds discoveries with NULL inputs and efficiency zero. External refresh stays manual. Metadata-only and URL-only edits do not fetch counts.

Stored-input projection, with no HTTP or writes:

```bash
node scripts/recalculateCharacterRanking.js \
  --db /absolute/catalog.sqlite --report /absolute/stored-projection.jsonl
```

Save an attributed revision-bound preview. Add `--refresh-danbooru --all` for an explicit full refresh, or `--refresh-danbooru --ids UUID,UUID` for a selected scope. Without refresh flags, this projects stored inputs only. Any remote failure prevents the entire refresh preview; it never becomes NULL. No-tag rows need no request.

```bash
node scripts/recalculateCharacterRanking.js \
  --db /absolute/catalog.sqlite --report /absolute/refresh-preview.jsonl \
  --refresh-danbooru --all --save-preview \
  --actor operator-name --expected-revision 1

# Use the returned previewId and payloadHash with the same actor.
# Confirmation makes no HTTP requests and rejects stale or expired previews.
node scripts/recalculateCharacterRanking.js \
  --db /absolute/catalog.sqlite --report /absolute/refresh-confirm.jsonl \
  --commit --actor operator-name --preview-id RETURNED_UUID \
  --payload-hash RETURNED_SHA256 --idempotency-key UNIQUE_REQUEST_KEY
```

Previews expire ten minutes after evidence collection completes. Failed confirmations retain their request key for exact retries. These maintenance commands do not rerun bootstrap or reset gameplay settings/buffs. Mudae rank and URL edits use portal curation; no Mudae gallery/page requests occur.

## Rollback

Before gameplay reopens, stop the new application and every writer. Restore the verified whole database with the matching old application, handling its sidecars consistently. Verify old startup, integrity, relationships and recovery before reopening. Restoring a table or swapping binaries alone is insufficient.

After gameplay resumes, restoring the old backup discards later player actions. Use a reviewed forward correction or a separately designed state-preserving rollback. Destructive removal of retained legacy columns is outside this release.

## Local verification evidence

Local checks ran on Windows with Node 22.23.2 and disposable databases. After PR review fixes, the complete Node suite finished with 1,895 tests: 1,894 passed, one skipped, zero failed or cancelled. The expanded catalog typecheck, shell deployment harness and real Chrome acceptance also passed. Browser checks cover both portal entrypoints, admin/moderator, desktop/mobile, copyright warnings, removed controls, exact retries, and stale queue confirmations after input/navigation/late responses. The [implementation completion](./character-efficiency-ranking-plan.md#8-implementation-completion-and-local-evidence) records the verification scope.

The supplied CSV bytes were rehearsed against **synthetic** predecessor names/ranks and all 15,409 real exported UUIDs. The fixture included 1,541 marriages, source links, memberships, tag overwrites/clears and personal/server/queued buff snapshots. Native backup/restore, rollback-only conversion, committed conversion, identical retry, old-binary rejection of the new layout, new-binary rejection of the predecessor and old-binary startup after restoration passed. Both binaries were exercised from local application sources; no production catalog was opened.

One local sample took approximately 13.8 seconds for rollback-only conversion and 13.7 seconds for commit, with peak process RSS about 619 MiB. That sample preceded statement-reuse optimization; it is a conservative observation, not a production SLO. Old/new normal startup measured approximately 0.76/1.82 seconds on the same synthetic roster. The existing synthetic release benchmark also passed at 1,000 and 10,000 characters with 20 iterations, retaining search/rank/membership/ownership semantics. Production coverage, writer quiescence, service permissions and restoration still require the authorized target rehearsal above.
