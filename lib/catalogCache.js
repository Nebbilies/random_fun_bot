import { loadCharacterIndex, prepareCharacterSearchIndex } from './gameCharacterLookup.js';
import { loadFranchiseIndex, prepareFranchiseSearchIndex, isFranchiseCatalogCurrent } from './franchiseLookup.js';

const sharedCaches = new WeakMap();

/** One revision-aware search snapshot per open database, shared by bot runtimes. */
export function getCatalogCache(db) {
  if (!sharedCaches.has(db)) sharedCaches.set(db, createCatalogCache(db));
  return sharedCaches.get(db);
}

function revision(db) {
  if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='catalog_state'").get()) {
    const row=db.prepare('SELECT revision FROM catalog_state WHERE singleton=1').get();
    if (!row || !Number.isSafeInteger(row.revision) || row.revision < 0) throw new Error('Invalid catalog revision');
    return `release:${row.revision}`;
  }
  return JSON.stringify(db.prepare("SELECT key,value FROM catalog_meta WHERE key IN ('catalog_revision','published_at','franchise_published_at','franchise_snapshot_published_at','franchise_source_published_at','franchise_source_token') ORDER BY key").all());
}
const key = db => JSON.stringify([revision(db), isFranchiseCatalogCurrent(db)]);

/** Reload both search models from one SQLite read snapshot. No notifications or
 * process-local publication assumptions: every access checks the durable revision.
 * A failed reload preserves the last cache but throws rather than serving stale data.
 */
export function createCatalogCache(db) {
  let cached=null, cachedKey=null;
  function get() {
    if (cached && key(db)===cachedKey) return cached;
    db.exec('BEGIN');
    try {
      const nextKey=key(db);
      const next={revision:revision(db), franchiseCurrent:isFranchiseCatalogCurrent(db),
        characterIndex:prepareCharacterSearchIndex(loadCharacterIndex(db)),
        franchiseIndex:prepareFranchiseSearchIndex(loadFranchiseIndex(db)),
        directFranchiseIndex:prepareFranchiseSearchIndex(loadFranchiseIndex(db,{directOnly:true}))};
      db.exec('COMMIT'); cached=next; cachedKey=nextKey; return cached;
    } catch(error) { db.exec('ROLLBACK'); throw error; }
  }
  return { get };
}
