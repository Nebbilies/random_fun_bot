import { lstatSync, mkdtempSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { backup, DatabaseSync } from 'node:sqlite';
import { settleCharacterMigration } from '../lib/characterMigrationSettlement.js';
import { inventoryCharacterIdentities } from '../lib/characterIdentityMigration.js';

const HELP = `Usage: node scripts/rehearseCharacterSettlement.js --database /path/offline-working.sqlite
--database is required (absolute or relative). Never use production or a sole backup.
Rejects bot.sqlite, symlink aliases, hardlinks and non-files. --help or -h shows this help.
Backs up the read-only source into a NEW disposable temporary directory, then settles
ONLY that clone and inventories it read-only. Preserves the clone even on failure.
The offline/backupVerified acknowledgements apply ONLY to this generated clone with
unchanged source; they do NOT verify an actual production backup restore.
No conversion, schema normalization, Discord, network or default database opener.
`;

function parseArgs(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return { help: true };
  if (args.length !== 2 || args[0] !== '--database' || !args[1]?.trim() || args[1].startsWith('-')) {
    throw new Error('Expected exactly --database PATH; use --help. No default database is allowed.');
  }
  return { database: args[1] };
}

function sourcePath(database) {
  const requested = resolve(database);
  const refuse = path => basename(path).toLowerCase() === 'bot.sqlite';
  if (refuse(requested)) throw new Error('Refusing default/live bot.sqlite; supply a separately named offline working copy.');
  const actual = realpathSync(requested);
  if (refuse(actual)) throw new Error('Refusing symlink target/default/live bot.sqlite.');
  const canonical = path => process.platform === 'win32' ? path.toLowerCase() : path;
  if (lstatSync(requested).isSymbolicLink() || canonical(actual) !== canonical(requested)) {
    throw new Error('Refusing symlink aliases; supply a separate regular offline working file.');
  }
  const stat = statSync(actual);
  if (!stat.isFile()) throw new Error('Database must be a regular file.');
  if (stat.nlink !== 1) throw new Error('Refusing hardlinks; supply a separate offline working copy.');
  return actual;
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.help) { console.log(HELP); return; }
  const source = sourcePath(options.database);
  let clonePath;
  const report = { source, clonePath: null,
    acknowledgementScope: 'Generated disposable clone only; source unchanged. NOT verification of an actual production backup restore.',
    version: null, blockerCount: 0, blockers: [], settlement: null };
  let failure;
  try {
    const input = new DatabaseSync(source, { readOnly: true });
    try {
      clonePath = join(mkdtempSync(join(tmpdir(), 'catalog-settlement-rehearsal-')), 'working.sqlite');
      report.clonePath = clonePath;
      await backup(input, clonePath);
    } finally { input.close(); }
    // No initializer or conversion: only this freshly generated clone is writable.
    const clone = new DatabaseSync(clonePath);
    try {
      report.settlement = settleCharacterMigration(clone, { offline: true, backupVerified: true, retainOverflow: true, now: Date.now() });
    } finally { clone.close(); }
  } catch (error) {
    failure = error;
    report.blockers.push(...(error.blockers ?? [error.message]));
  }
  if (clonePath) {
    let inspection;
    try {
      inspection = new DatabaseSync(clonePath, { readOnly: true });
      const inventory = inventoryCharacterIdentities(inspection);
      report.version = inventory.version;
      report.blockers.push(...inventory.blockers);
    } catch (error) {
      failure ??= error;
      report.blockers.push(`Read-only clone inventory failed: ${error.message}`);
    } finally { inspection?.close(); }
  }
  report.blockers = [...new Set(report.blockers)];
  report.blockerCount = report.blockers.length;
  console.log(JSON.stringify(report, null, 2));
  if (failure || report.blockerCount) {
    console.error(`Rehearsal blocked. Preserve clone: ${clonePath ?? '(not created)'}. Review all reported blockers; reconcile the offline fixture before retrying. Source was opened read-only.`);
    process.exitCode = 1;
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
