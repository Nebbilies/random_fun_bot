// Historical predecessor tests exercise the old binary's contract explicitly.
// Production startup rejects these layouts; ranking startup/cutover tests use catalogDb directly.
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { openCatalog as openNumericCatalog, openCatalogReadOnly as openNumericReadOnly } from '../../lib/catalogDb.js';
import { installEmptyFinalCatalog, validateFinalCatalogSchema } from '../../lib/catalogPreRankingSchema.js';
import { ensureFortuneCatalog } from '../../lib/catalogPreRankingUpgrade.js';

export function createFinalCatalog(path) {
  const db = new DatabaseSync(path); db.exec('PRAGMA foreign_keys=ON');
  installEmptyFinalCatalog(db); return db;
}
export function openFinalCatalog(path, { readOnly = false } = {}) {
  const db = new DatabaseSync(path, { readOnly });
  try {
    if (!readOnly) ensureFortuneCatalog(db);
    validateFinalCatalogSchema(db, { readOnly });
    if (!readOnly) db.exec('PRAGMA foreign_keys=ON');
    return db;
  } catch (error) { db.close(); throw error; }
}
export function openFinalCatalogReadOnly(path) { return openFinalCatalog(path, { readOnly: true }); }
export function openCatalog(path) {
  if (path === ':memory:' || !existsSync(path)) return openNumericCatalog(path);
  const check = new DatabaseSync(path, { readOnly: true });
  const version = check.prepare('PRAGMA user_version').get().user_version; check.close();
  return version === 12 ? openFinalCatalog(path) : openNumericCatalog(path);
}
export function openCatalogReadOnly(path) {
  const check = new DatabaseSync(path, { readOnly: true });
  const version = check.prepare('PRAGMA user_version').get().user_version; check.close();
  return version === 12 ? openFinalCatalogReadOnly(path) : openNumericReadOnly(path);
}
