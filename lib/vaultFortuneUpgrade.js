import { migrateItemExpiry } from './itemExpiryMigration.js';
import { isPreExpiryCatalogSchema, isPreFortuneCatalogSchema, validateFinalCatalogSchema } from './catalogFinalSchema.js';
import { FORTUNE_DDL } from './vaultFortuneSchema.js';

/** Bounded additive v12 upgrade. Owns its transaction; never adopts or rolls back
 * a caller's transaction. Rechecks the schema under the first-start write lock.
 * Also usable as an optional rollback-only diagnostic rehearsal. */
export function upgradeFortuneCatalog(db, { dryRun = true, now = Date.now() } = {}) {
  if (db.isTransaction) throw new Error('Fortune upgrade requires its own transaction');
  const busyTimeout = Number(db.prepare('PRAGMA busy_timeout').get().timeout);
  // Bot and portal can start together. Full production validation holds the
  // migration lock longer than the ordinary 5s connection timeout. Let SQLite's
  // busy handler wait up to 60s (no spin/retry loop), retaining any longer caller
  // policy. Restore the connection policy on success and failure alike.
  const upgradeBusyTimeout = Math.max(busyTimeout, 60000);
  if (busyTimeout !== upgradeBusyTimeout) db.exec(`PRAGMA busy_timeout=${upgradeBusyTimeout}`);
  let ownsTransaction = false;
  try {
    db.exec('BEGIN IMMEDIATE');
    ownsTransaction = true;
    if (isPreFortuneCatalogSchema(db)) {
      validateFinalCatalogSchema(db, { readOnly: false, fortune: false });
      db.exec(FORTUNE_DDL);
    }
    if (isPreExpiryCatalogSchema(db)) {
      validateFinalCatalogSchema(db, { readOnly: false, expiry: false });
      migrateItemExpiry(db, { now });
    }
    validateFinalCatalogSchema(db, { readOnly: false });
    db.exec(dryRun ? 'ROLLBACK' : 'COMMIT');
    return { dryRun, committed: !dryRun, catalogVersion: 12, fortuneVersion: 1, itemExpiryVersion: 1 };
  } catch (error) {
    if (ownsTransaction && db.isTransaction !== false) db.exec('ROLLBACK');
    throw error;
  } finally {
    if (busyTimeout !== upgradeBusyTimeout) db.exec(`PRAGMA busy_timeout=${busyTimeout}`);
  }
}

/** Avoid a write lock on already-current opens. The upgrade itself must recheck
 * after BEGIN IMMEDIATE because another first-start process may have won. */
export function ensureFortuneCatalog(db) {
  if (isPreFortuneCatalogSchema(db) || isPreExpiryCatalogSchema(db)) upgradeFortuneCatalog(db, { dryRun: false });
}
