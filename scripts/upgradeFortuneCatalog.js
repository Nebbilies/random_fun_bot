import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { upgradeFortuneCatalog } from '../lib/vaultFortuneUpgrade.js';

export function main(args = process.argv.slice(2)) {
  const commit = args.includes('--commit');
  const paths = args.filter(arg => arg !== '--commit');
  if (paths.length !== 1 || paths[0].startsWith('--') || !existsSync(paths[0]))
    throw new Error('Optional diagnostics: node scripts/upgradeFortuneCatalog.js <existing-offline-catalog.sqlite> [--commit]. Routine writable application startup applies the additive Fortune update automatically. For offline diagnostics, stop writers and back up first. Default is rollback-only rehearsal.');
  const db = new DatabaseSync(resolve(paths[0]));
  try {
    db.exec('PRAGMA foreign_keys=ON');
    const report = upgradeFortuneCatalog(db, { dryRun: !commit });
    console.log(JSON.stringify(report, null, 2));
    return report;
  } finally { db.close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
