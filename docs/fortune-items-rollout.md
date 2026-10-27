# Fortune items Phase 1 rollout

## Deployment gate — offline schema upgrade required

Existing authoritative final-v12 catalogs require the additive Fortune extension **before starting this code**. Normal startup validates and refuses old schemas; it does not repair or upgrade them. The normal GitHub deployment workflow does not perform this upgrade. Coordinate maintenance before merging/deploying; do not merge assuming a restart alone is sufficient.

No live upgrade was performed during implementation.

## Operator procedure

1. Schedule maintenance and stop **all writers**: bot, portal, administrative jobs, imports and other processes using the catalog. Keep them stopped through validation. SQLite's transaction lock does not replace this operator requirement.
2. Back up the catalog using the deployment's established SQLite-safe backup procedure. If copying files directly, ensure no connections remain and handle WAL/SHM files correctly. Keep the old application release and backup for rollback.
3. From the new release directory, rehearse against the existing catalog:

   ```sh
   node scripts/upgradeFortuneCatalog.js /absolute/path/catalog.sqlite
   ```

   Default is rollback-only: expect `dryRun: true`, `committed: false`, `catalogVersion: 12`, `fortuneVersion: 1`.
4. After successful rehearsal, commit the extension:

   ```sh
   node scripts/upgradeFortuneCatalog.js /absolute/path/catalog.sqlite --commit
   ```

   Expect `committed: true`. A repeated commit is refused rather than silently treated as another migration. Do not use the character identity conversion command to upgrade an already-final-v12 file.
5. Run read-only schema and runtime preflight using the new release, substituting the real absolute path:

   ```sh
   node --input-type=module -e "import { openFinalCatalogReadOnly } from './lib/catalogDb.js'; import { inspectCatalogRuntimeRestart } from './lib/catalogRuntimeRecovery.js'; const db = openFinalCatalogReadOnly('/absolute/path/catalog.sqlite'); try { const report = inspectCatalogRuntimeRestart(db); console.log(JSON.stringify(report, null, 2)); if (!report.ready) process.exitCode = 1; } finally { db.close(); }"
   ```

   Investigate blockers; do not delete pending states or reroll missing rewards to force readiness. Recoverable pending work is expected and will be resumed by the bot.
6. Restart the new release and confirm recovery completes before normal game ingress. Verify prefix `itemlist`, item configuration, and vault controls in a controlled server.

Empty final catalogs and supported offline legacy conversions already include Fortune tables; they do not need the additive-v12 command. Unknown, partial or weakened schemas must be investigated rather than upgraded by guessing.

## Rollback

Do not run an older application against the extended schema. If rollback is required, stop all writers and restore the matching pre-upgrade backup and old application together. A backup rollback discards gameplay writes after that backup; agree that consequence before reopening the game.

## Delivery limitations

Discord messages and SQLite transactions cannot commit atomically. Candidates, costs, terminal choices, and inventory delivery are durable; message delivery acknowledgement can remain uncertain after a crash. Lens recovery inspects the canonical card before refunding an apparently unpublished reveal and defers unverifiable transport failures rather than guessing. Recast can be resumed privately using the owner-only button on its public reward card; ephemeral interaction tokens are not durable recovery storage.

## Release record

See `docs/item-release-changelog.md` for future item releases. The initial fixed date is 28/10/2026; adjust it before publication if release moves. Names remain masked per guild until successful acquisition.
