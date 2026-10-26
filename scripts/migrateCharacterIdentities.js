import { realpathSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { inventoryCharacterIdentities, convertLegacyCatalogToFinal } from '../lib/characterIdentityMigration.js';

const HELP = `Offline UUID migration foundation (rehearsal only; no production migration).
Usage: node scripts/migrateCharacterIdentities.js --database /absolute/path/to/rehearsal.sqlite [--rehearse]
Without --rehearse: read-only inventory/preflight. With --rehearse: authoritative v12 conversion and validation in a transaction, always ROLLBACK.
No default database, no network calls, no commit option. Never point this tool at production.

Before rehearsal:
  1. Stop bot, portal and importers. Settle live actions with domain-specific cancellation/refund APIs.
     Generic SQL deletion/refunds are unsafe (especially delivered vs undelivered Hostage Notes).
  2. Make a consistent SQLite backup including WAL contents (SQLite backup API or offline backup
     after clean shutdown/checkpoint); do not copy only a live main database file.
  3. Verify backup integrity and restoration with the compatible pre-migration application version.
  4. Run this tool against a separate disposable restored backup, never the original or recovery backup.
  5. Compare ownership, wishes, tag decisions, ties, history and reference counts; time the rehearsal.
Input must be fully upgraded legacy v10. Older schemas require normalization with the compatible legacy application on a disposable copy.
Reviewed identity JSON shapes are converted; unknown variants and unresolved references are refused.
Production schema/consumer coordination, cancellation, acceptance and recovery gates remain outstanding.
`;

export function main(args = process.argv.slice(2)) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { console.log(HELP); return; }
  let database;
  let rehearse = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--database' && !database && args[i + 1] && !args[i + 1].startsWith('--')) database = args[++i];
    else if (args[i] === '--rehearse' && !rehearse) rehearse = true;
    else throw new Error(`Unknown, duplicate or incomplete argument: ${args[i]}\n${HELP}`);
  }
  if (!database) throw new Error(`--database is required.\n${HELP}`);
  // Resolve before SQLite opens anything. Reject repository production path,
  // symlinks to it, and bot.sqlite anywhere as an additional accident guard.
  const requested = resolve(database);
  const production = resolve(dirname(fileURLToPath(import.meta.url)), '../data/bot.sqlite');
  if (requested.toLowerCase() === production.toLowerCase() || /(?:^|[\\/])bot\.sqlite$/i.test(requested)) {
    throw new Error('Refusing production/default bot.sqlite; use a separately named disposable rehearsal copy.');
  }
  const path = realpathSync(requested);
  if (path.toLowerCase() === production.toLowerCase() || /(?:^|[\\/])bot\.sqlite$/i.test(path)) {
    throw new Error('Refusing production/default bot.sqlite; use a separately named disposable rehearsal copy.');
  }
  const db = new DatabaseSync(path, { readOnly: !rehearse });
  try {
    const report = rehearse ? convertLegacyCatalogToFinal(db) : inventoryCharacterIdentities(db);
    console.log(JSON.stringify(report, null, 2));
    if (report.blockers?.length) process.exitCode = 1;
  } finally { db.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
