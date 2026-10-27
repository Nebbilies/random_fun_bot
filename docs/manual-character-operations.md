# Manual catalog operations and recovery

## Safety status

Development acceptance and operator authorization are separate. Never infer release approval from a green suite. The final requirement-to-test evidence must contain no unresolved identity/data-loss/security/concurrency blockers before authorizing a production-derived backup rehearsal. Production conversion is a separately recorded action; the rehearsal CLI is not a production commit tool.

## Runtime and deployment prerequisite

CI and the deployment script pin **Node v22.23.2**. Earlier Node 22 versions (including v22.14.0) lack the SQLite backup/transaction-state APIs exercised by this release and are not supported for cutover. Upgrade and verify the service's actual Node executable, not only the interactive shell. Preserve the previous runtime for rollback. Main pushes automatically deploy; disable that workflow before merging for a manual database cutover, and re-enable only after code/database/runtime/configuration acceptance.

## Drain before stopping

1. Deploy the reviewed drain-capable application version **before** requesting cutover. On a disposable staging database first, exercise `node scripts/catalogMaintenance.js --database /explicit/catalog.sqlite --mode drain`.
2. Each bot process must use the same persisted database gate. New roll/item/trade/gift/divorce/wish actions pause. Existing published claims, mystery answers, Hostage decisions and pending confirmations may finish under their captured rules. Read-only commands and cancellation remain available.
3. Inspect `--mode status`. This enumerates persisted rolls, mysteries and item actions; `persistedActionsDrained` does **not** mean all writers are stopped or all in-memory conversations are drained. Confirm trade/gift/divorce dialogs have finished/expired in every process.
4. Stop every bot, portal, tag tool, importer, scheduled task and other SQLite writer. Verify no process can reconnect. Source/enrichment publication must also stop. Do not introduce a new cost by force-resolving a blocked action with random outcomes.
5. Supported offline settlement may cancel only reviewed no-cost/undelivered cases with exact escrow release. Proven ordinary published rolls whose captured claim deadline has passed may close without refunds or changes to ownership, costs or history. Pending/unexpired rolls, all escape/Siren/mystery-linked rolls, delivered Hostages and unknown payload variants require draining or reviewed reconciliation; never invent refunds.

The drain CLI uses an explicit existing path; it does not select the default production database. `--mode resume` clears the gate only when the operator has decided normal operation is safe.

## Consistent backup and rehearsal (separate authorization required)

- Use SQLite backup or stop all writers cleanly before copying. Never copy only a live main file while its WAL is active.
- Preserve one untouched sensitive recovery backup plus the exact pre-conversion application commit/runtime/configuration. Perform rehearsal only on a second disposable copy with external integrations disabled.
- Record source schema/commit, backup integrity, table/reference/history counts, maximum sequences, active-state blockers and representative anonymized historical payload shapes. Database access itself needs authorization.
- Run the explicit-path inventory and rollback-only rehearsal CLI. Do not bypass `--permission-confirmed` for any AniList API call; rehearsal should use no external integrations.
- Record measured conversion duration, restart through normal writable/read-only entrypoints, UUID/source uniqueness, foreign-key/integrity results, exact retained ownership/history, tied ordering and all critical gameplay/portal smoke results.
- Independently restore another disposable environment from the untouched backup using the pre-conversion application version. Verify ownership, history, claims and portal permissions. A successful conversion is not a successful recovery test.
- Establish a maintenance window from measured conversion/restart/recovery times and deployment requirements, with an explicit buffer. Record a go/no-go decision; never use a guessed downtime promise.

## Disposable settlement rehearsal

With explicit permission to read an offline working copy, run:

```bash
node scripts/rehearseCharacterSettlement.js --database /offline/working.sqlite
```

This opens the supplied file **read-only**, uses SQLite backup to create a new private temporary directory, and settles **only the generated clone**. It prints a compact report and the clone path and preserves that clone on success or failure. It does not convert, start Discord, normalize schemas, or modify the source. Its clone acknowledgements do not certify a production restore or stopped production writers. Protect the clone as sensitive data; retain it until diagnosis is complete and remove it explicitly when no longer needed.

Only strictly classified expired ordinary published rolls close; their historical rows remain. Valid determined overflow rewards are retained byte-for-byte, even when inventory is full: no award, replacement, decline, extra capacity, reroll or acknowledgement clearing. Conversion carries these reviewed rewards forward as recoverable pending work, not terminal history. Other supported settlement behavior remains transactional. Any unsupported state rolls all settlement writes back. Retained reward rules accept the exact current format or the exact pre-Grand-Masquerade-update format (with `masqueradeMaxRankMultiplier` instead of `masqueradeConfirmationMs`), validating the historical bounds without adding defaults or rewriting captured JSON. Partial/mixed formats and other unknown historical payloads remain blockers.

Use the returned clone path for subsequent read-only inventory or rollback-only `--rehearse`. Settlement commits on the disposable clone; conversion rehearsal rolls back **conversion only**, not the preceding settlement. This is not production reconciliation authorization or a completed restore test.

## Offline working-copy conversion (not production authorization)

`scripts/migrateCharacterIdentities.js` defaults to **read-only inventory**. `--rehearse` converts authoritative fully upgraded legacy v10 to authoritative final v12 inside a transaction and always rolls back. Neither mode normalizes older/custom schemas. Paths must already exist; default `bot.sqlite` names, aliases resolving to them, and hard-linked databases are refused. A separately named file alone does not prove it is offline: the operator remains responsible for identifying the working copy correctly.

Explicit `--commit` is available **only for a separate OFFLINE WORKING COPY**, never the source database or untouched recovery backup. It is mutually exclusive with `--rehearse`; all acknowledgements and references below are mandatory and accepted only with commit. This is an operator boundary, not service shutdown, deployment, production orchestration or release approval.

```text
node scripts/migrateCharacterIdentities.js --database /offline/working-copy.sqlite
node scripts/migrateCharacterIdentities.js --database /offline/working-copy.sqlite --rehearse
node scripts/migrateCharacterIdentities.js --database /offline/working-copy.sqlite --commit \
  --offline-working-copy --backup-restore-verified --writers-stopped --conversations-drained \
  --source-app-commit abcdef1234567 --source-runtime node-22.23.2 \
  --target-app-commit fedcba7654321 --target-runtime node-22.23.2 \
  --backup-ref backup-artifact-17 --restore-ref restore-evidence-17 \
  --rehearsal-ref rehearsal-evidence-17 --report /offline/evidence/new-operation.jsonl
```

Use the actual reviewed application commits/runtime identifiers and independently verified backup, restore and rehearsal artifact labels. References are **non-secret labels**, not credentials, signed URLs, connection strings or payloads. The tool records assertions; it cannot verify that a reference proves authorization or that every external process has stopped. Do not put secrets in command arguments or reports. Protect reports as sensitive operational evidence (canonical paths and row diagnostics may identify data).

Before commit, complete the drain, backup/restore verification and writer/conversation shutdown steps above. The existing `game_maintenance=drain` gate must persist in the working copy. It is checked **inside `BEGIN IMMEDIATE`**, not inferred from command-line acknowledgements. Active-state inventory and authoritative DDL validation run under the same transaction. After conversion, final-schema/integrity/foreign-key checks and the normal final runtime restart guard run **before COMMIT**, without a nested transaction. Unsupported or corrupt runtime records block restart and roll conversion back. Valid terminal vault announcements with `delivered_at IS NULL` are recoverable through the vault runtime without re-awarding inventory. Do not clear acknowledgements, settle/refund rows, or delete escrow to bypass a blocker. Obtain reviewed domain reconciliation instead. The tool does not resume the drain gate.

The report path must be new in an existing directory, separate from the database/SQLite sidecars. It is exclusively precreated, and a start record is written and fsynced before database writes. JSONL evidence contains an operation ID, canonical path, source/target schema and application/runtime references, timestamps/duration, before/after table counts and sequences, validation and outcome. The validated-before-commit record is also fsynced inside the conversion transaction; failure to write it prevents commit. No identity mapping or secret configuration is exported.

Preserve evidence and the working copy on **any** error. A start/validation record without a durable outcome means **uncertain**, especially after a hard interruption. A failure to write final evidence **after COMMIT is not a rollback**; the error reports the known database outcome. `not-committed` means the dedicated connection was closed and a fresh read-only inspection still found v10; it is not permission to reuse the only backup. Never infer outcome solely from the process exit code or a truncated report. Inspect the database read-only and reconcile against the report and untouched backup before another authorized attempt.

After successful commit, close the conversion writer (the tool does this), then use explicit-path `openCatalog(path)` and `openCatalogReadOnly(path)` from `lib/catalogDb.js` in a disposable, network-disabled acceptance environment, and `inspectCatalogRuntimeRestart` from `lib/catalogRuntimeRecovery.js`. Verify authoritative v12, maintenance gate, FK/integrity results, ownership/history/reference counts, sequence high-water marks, UUID/source uniqueness and representative application smoke behavior before any traffic decision. **Do not rerun conversion on v12**: it refuses; the migration CLI's inventory is legacy-only, not a v12 acceptance tool. Inspect with the final read-only opener and runtime guard, which do not settle or replay anything. Restore an independently named disposable copy from the consistent recovery backup using SQLite's backup API and the compatible pre-conversion application/runtime; verify v10 ownership/history and integrity independently of conversion success. No production-readiness declaration follows from these steps or the tests.

## Final-v12 restart preflight

The bot invokes the read-only `assertCatalogRuntimeRestartReady` before Discord login. Valid supported paid states are recoverable work, not whole-bot blockers: ordinary pending deliveries, bound escape timers, versioned mystery phases, durable unopened vaults, and existing item/reward reconciliation. After Discord becomes ready, recovery runs before message/reaction/interaction ingress is enabled, and periodic retry preserves work during transient transport failures. Captured terms, ownership bindings, deadlines and costs are not reselected or recharged.

Missing/corrupt terms, missing paid delivery/session records and ambiguous historical mystery outcomes still produce named table/row blockers. Do not delete rows, disable this guard, fabricate refunds or mark actions complete to make startup pass. Preserve the database for reviewed reconciliation. Trade/gift conversations remain memory-only and disappear without changing ownership. Discord send-before-database-acknowledgement is not exactly-once delivery: nonce deduplication is best effort and time-limited; only durable canonical bindings authorize claims/rewards. A clean planned drain remains preferable to crash recovery.

Published ordinary claims with valid durable terms can be handled after restart. Memory-only trade/gift dialogs are abandoned without ownership transfer; old inventory controls expire at cutover, and collector-only dialogs receive an expired response. No exactly-once guarantee is claimed for a crash between Discord send and message-id persistence.

## Failure and recovery

If conversion fails, preserve the error and row/path diagnostics; verify transaction rollback and stop. Do not manually patch unidentified historical references or silently drop rows. Keep the working copy for diagnosis and the untouched backup unchanged.

If post-conversion acceptance fails before reopening traffic, stop every writer again. Restore the entire consistent backup using the reviewed SQLite recovery procedure (including avoiding stale sidecar files), restore the exact pre-conversion application/runtime, run integrity and ownership/history smoke checks, then explicitly resume traffic. Do not point the old application at a partially upgraded database or overwrite the only backup.

Any writes accepted after conversion complicate rollback; do not reopen traffic until smoke checks and the release decision are complete. No generic undo or automatic cross-schema write reconciliation is implemented.
