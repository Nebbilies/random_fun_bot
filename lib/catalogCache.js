import { loadCharacterIndex } from './gameCharacterLookup.js';
import { loadFranchiseIndex } from './franchiseLookup.js';

function revision(db) {
  if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='catalog_state'").get()) {
    const row=db.prepare('SELECT revision FROM catalog_state WHERE singleton=1').get();
    if (!row || !Number.isSafeInteger(row.revision) || row.revision < 0) throw new Error('Invalid catalog revision');
    return `release:${row.revision}`;
  }
  return JSON.stringify(db.prepare("SELECT key,value FROM catalog_meta WHERE key IN ('catalog_revision','published_at','franchise_published_at') ORDER BY key").all());
}

/** Reload both search models from one SQLite read snapshot. No notifications or
 * process-local publication assumptions: every access checks the durable revision.
 * A failed reload preserves the last cache but throws rather than serving stale data.
 */
export function createCatalogCache(db) {
  let cached=null;
  function get() {
    if (cached && revision(db)===cached.revision) return cached;
    db.exec('BEGIN');
    try {
      const next={revision:revision(db),characterIndex:loadCharacterIndex(db),franchiseIndex:loadFranchiseIndex(db)};
      db.exec('COMMIT'); cached=next; return cached;
    } catch(error) { db.exec('ROLLBACK'); throw error; }
  }
  return { get };
}
