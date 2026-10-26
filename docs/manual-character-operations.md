# Manual catalog operations and recovery

## Safety status

Development acceptance and operator authorization are separate. Never infer release approval from a green suite. The final requirement-to-test evidence must contain no unresolved identity/data-loss/security/concurrency blockers before authorizing a production-derived backup rehearsal. Production conversion is a separately recorded action; the rehearsal CLI is not a production commit tool.

## Drain before stopping

1. Deploy the reviewed drain-capable application version **before** requesting cutover. On a disposable staging database first, exercise `node scripts/catalogMaintenance.js --database /explicit/catalog.sqlite --mode drain`.
2. Each bot process must use the same persisted database gate. New roll/item/trade/gift/divorce/wish actions pause. Existing published claims, mystery answers, Hostage decisions and pending confirmations may finish under their captured rules. Read-only commands and cancellation remain available.
3. Inspect `--mode status`. This enumerates persisted rolls, mysteries and item actions; `persistedActionsDrained` does **not** mean all writers are stopped or all in-memory conversations are drained. Confirm trade/gift/divorce dialogs have finished/expired in every process.
4. Stop every bot, portal, tag tool, importer, scheduled task and other SQLite writer. Verify no process can reconnect. Source/enrichment publication must also stop. Do not introduce a new cost by force-resolving a blocked action with random outcomes.
5. Supported offline settlement may cancel only reviewed no-cost/undelivered cases with exact escrow release. Delivered Hostages, active mysteries, live rolls/Siren and unknown payload variants require draining or reviewed reconciliation; never invent refunds.

The drain CLI uses an explicit existing path; it does not select the default production database. `--mode resume` clears the gate only when the operator has decided normal operation is safe.

## Consistent backup and rehearsal (separate authorization required)

- Use SQLite backup or stop all writers cleanly before copying. Never copy only a live main file while its WAL is active.
- Preserve one untouched sensitive recovery backup plus the exact pre-conversion application commit/runtime/configuration. Perform rehearsal only on a second disposable copy with external integrations disabled.
- Record source schema/commit, backup integrity, table/reference/history counts, maximum sequences, active-state blockers and representative anonymized historical payload shapes. Database access itself needs authorization.
- Run the explicit-path inventory and rollback-only rehearsal CLI. Do not bypass `--permission-confirmed` for any AniList API call; rehearsal should use no external integrations.
- Record measured conversion duration, restart through normal writable/read-only entrypoints, UUID/source uniqueness, foreign-key/integrity results, exact retained ownership/history, tied ordering and all critical gameplay/portal smoke results.
- Independently restore another disposable environment from the untouched backup using the pre-conversion application version. Verify ownership, history, claims and portal permissions. A successful conversion is not a successful recovery test.
- Establish a maintenance window from measured conversion/restart/recovery times and deployment requirements, with an explicit buffer. Record a go/no-go decision; never use a guessed downtime promise.

## Final-v12 restart preflight

The bot invokes `assertCatalogRuntimeRestartReady` before enabling recovery writes, timers, handlers or Discord login. Pending/ambiguous deliveries, active mysteries or escapes, and unreconciled item/vault states produce named table/row blockers. This protects ownership and spent costs; it is not an automatic replay/refund implementation. Do not delete rows, disable this guard, or mark actions complete to make startup pass. Preserve the database and obtain a reviewed reconciliation/recovery procedure for the listed states. A clean drain before a planned restart avoids these blockers. A crash can still require intervention.

Published ordinary claims with valid durable terms can be handled after restart. Memory-only trade/gift dialogs are abandoned without ownership transfer; old inventory controls expire at cutover, and collector-only dialogs receive an expired response. No exactly-once guarantee is claimed for a crash between Discord send and message-id persistence.

## Failure and recovery

If conversion fails, preserve the error and row/path diagnostics; verify transaction rollback and stop. Do not manually patch unidentified historical references or silently drop rows. Keep the working copy for diagnosis and the untouched backup unchanged.

If post-conversion acceptance fails before reopening traffic, stop every writer again. Restore the entire consistent backup using the reviewed SQLite recovery procedure (including avoiding stale sidecar files), restore the exact pre-conversion application/runtime, run integrity and ownership/history smoke checks, then explicitly resume traffic. Do not point the old application at a partially upgraded database or overwrite the only backup.

Any writes accepted after conversion complicate rollback; do not reopen traffic until smoke checks and the release decision are complete. No generic undo or automatic cross-schema write reconciliation is implemented.
