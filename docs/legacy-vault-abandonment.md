# Bounded legacy vault abandonment (offline only)

This operation is authorized only for observed roll IDs **16994, 17061, 17073,
17087, 17137, 17168, 17317, 17358**. The last two were separately approved after a
fresh snapshot revealed newer data. The original six are already terminal in that
snapshot. Select only the reviewed unresolved rows present in the chosen source;
do not pass all approved IDs indiscriminately. It does not infer whether a vault was sent/opened, invent
an outcome, refund a cost, replace an item, delete a row, or close a zero-sentinel
roll. Rows retain `state='vault'`; conversion changes numeric zero to text `'0'`
under the unchanged authoritative final schema.

1. Stop all writers/services. Preserve and independently restore-test the backup.
   Use a verified, separately named SQLite backup/restore, not production or the
   sole recovery backup. Source must be an independent file without SQLite
   sidecars; do not delete live WAL files to satisfy this requirement.
2. Review the exact selected rows, their original scope/bindings, and missing session/
   outcome provenance. Decide explicitly to abandon these ambiguous vaults
   **without refund or replacement**. No automatic compensation is supported.
3. Run with explicit paths and a truthful reason/operator (example paths only):

   ```sh
   node scripts/abandonLegacyVaultRolls.js \
     --database /offline/verified-source.sqlite \
     --output /offline/abandoned-clone.sqlite \
     --roll-ids 17317,17358 \
     --abandon-without-refund-or-replacement \
     --offline-working-copy --writers-stopped --backup-restore-verified \
     --operator reviewed-operator --reason "Explicitly abandon ambiguous legacy vaults without compensation" \
     --report /offline/new-abandonment.jsonl
   ```

   Source is opened read-only. A SQLite backup is modified only in a temporary
   sibling directory, gated against authoritative v10 DDL inside the write
   transaction, then exclusively published to a previously absent output. Output
   and report may not alias source/sidecars or existing files. Default
   `bot.sqlite`, hardlinks and production-name symlink aliases are refused.

4. Preserve the external JSONL evidence with the backup and conversion artifacts.
   Start and precommit records are fsynced before writes/commit. `published` means
   a standalone clone was published, **not** that migration/runtime is ready.
   A missing final record or evidence-write error is uncertain: inspect paths
   read-only, never assume rollback or blindly retry. Do not overwrite evidence.
5. Run the existing identity inventory/rehearsal/guarded commit workflow against
   **the new clone**, with persisted `game_maintenance=drain` and its existing
   conversion acknowledgements/artifact references. Inspect final v12 read-only
   with the runtime restart guard before any service startup. Other blockers,
   unselected vaults, escrow and missing character provenance are not waived.
   Ordinary verified expiry settlement and validated retained overflow remain
   separate domain operations; abandonment does not perform them.

## Durable contract and trust boundary

`catalog_meta.legacy_vault_abandonment_v1` holds a strict version-1 object with
per-roll original v10 binding snapshots, SHA-256 fingerprints, source-file hash,
operation UUID, acknowledgement timestamp, reason and operator assertion.
Inventory and runtime share a non-cached validator: exact schema/keys, bounded
IDs, original row equality, fingerprint, and absence of mystery/delivery/session/
reward bindings are rechecked at use. Same-channel rewards without a source
binding are ambiguous and refused. New bindings or stale/malformed evidence
block restart even if a matching session otherwise exists. No broad bypass is
installed; no evidence leaves existing behavior unchanged.

The source hash and operator identity are provenance assertions linked to the
external report, not cryptographic authentication of a hostile database editor.
A party able to rewrite both SQLite data and evidence is outside this trust
boundary. Keep external evidence independently protected. No schema change,
startup repair, network activity, generic ledger, undo or recovery redesign is
part of this operation.

## Retiring the final-schema exceptions

The separate `scripts/retireLegacyVaults.js` operation retires the two reviewed
final-schema exceptions, 17317 and 17358. The original v10 abandonment operation
and its validator remain unchanged. Normal command cleanup immediately returns
from legacy validation when the abandonment contract no longer exists.

Dry-run is read-only and requires explicit paths and both reviewed IDs:

```sh
node scripts/retireLegacyVaults.js --database /explicit/catalog.sqlite --roll-ids 17317,17358
```

First rehearse against a fresh SQLite backup. For production, drain new game
actions, let active dialogs/actions finish, and stop all bot and portal writers.
Apply to the current database, never promote an old rehearsal snapshot:

```sh
node scripts/retireLegacyVaults.js --database /explicit/catalog.sqlite \
  --roll-ids 17317,17358 --apply --writers-stopped \
  --backup /protected/new-before-retirement.sqlite \
  --archive /protected/new-retirement.jsonl \
  --operator reviewed-operator --reason "Retire reviewed obsolete vault exceptions"
```

Backup/archive paths must not exist or alias the database or its sidecars.
The operation validates the final schema, exact abandonment evidence, absence of
bindings and restart readiness. It takes a write transaction, repeats inspection,
creates a consistent SQLite backup, and durably archives the original contract,
rolls, notices and backup checksum before deleting anything. Only the two roll
records, their notices and the contract are deleted. Affection legacy markers,
player resources and modern rewards are retained. Schema/integrity and restart
checks run again before commit. No automatic refunds or startup migration run.

An absent contract with both reviewed rows absent returns `not-applicable` without
writing files; partial/malformed retirement fails. Inspect uncertain outcomes
read-only against the preserved backup and archive; never assume rollback or
retry with overwritten evidence. Before resuming writers, verify startup and
recovery. Once players resume, do not restore an older database over new progress.
