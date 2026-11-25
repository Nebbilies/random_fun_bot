import {
  loadCharacterIndex,
  prepareCharacterSearchIndex,
} from "./gameCharacterLookup.js";
import {
  loadFranchiseIndex,
  prepareFranchiseSearchIndex,
  isFranchiseCatalogCurrent,
} from "./franchiseLookup.js";
import { loadRollCandidatePools } from "./rollCandidatePools.js";

const sharedCaches = new WeakMap();
const ROLL_POOL_REFRESH_RETRY_MS = 15_000;

/** One revision-aware search snapshot per open database, shared by bot runtimes. */
export function getCatalogCache(db) {
  if (!sharedCaches.has(db)) sharedCaches.set(db, createCatalogCache(db));
  return sharedCaches.get(db);
}

function releaseRevision(db) {
  const row = db
    .prepare("SELECT revision FROM catalog_state WHERE singleton=1")
    .get();
  if (!row || !Number.isSafeInteger(row.revision) || row.revision < 0)
    throw new Error("Invalid catalog revision");
  return `release:${row.revision}`;
}

function revision(db) {
  if (
    db
      .prepare(
        "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='catalog_state'",
      )
      .get()
  )
    return releaseRevision(db);
  return JSON.stringify(
    db
      .prepare(
        "SELECT key,value FROM catalog_meta WHERE key IN ('catalog_revision','published_at','franchise_published_at','franchise_snapshot_published_at','franchise_source_published_at','franchise_source_token') ORDER BY key",
      )
      .all(),
  );
}
const key = (db) =>
  JSON.stringify([revision(db), isFranchiseCatalogCurrent(db)]);

/** Reload both search models from one SQLite read snapshot. No notifications or
 * process-local publication assumptions: every access checks the durable revision.
 * A failed reload preserves the last cache but throws rather than serving stale data.
 */
export function createCatalogCache(db) {
  let cached = null,
    cachedKey = null;
  /** @type {{ revision: string, poolFor: import('./rollCandidatePools.js').GetRollCandidatePool } | null} */
  let rollPools = null;
  let refreshQueued = false;
  let retryRefreshAt = 0;

  function warmRollPools() {
    if (db.isTransaction) return;
    let started = false;
    try {
      if (db.prepare("PRAGMA user_version").get().user_version !== 12) return;
      db.exec("BEGIN");
      started = true;
      const next = {
        revision: releaseRevision(db),
        poolFor: loadRollCandidatePools(db),
      };
      db.exec("COMMIT");
      rollPools = next;
      retryRefreshAt = 0;
    } catch (error) {
      if (started && db.isTransaction) db.exec("ROLLBACK");
      retryRefreshAt = Date.now() + ROLL_POOL_REFRESH_RETRY_MS;
      console.error("Roll candidate pool refresh failed:", error);
    }
  }

  // Called during reservation. Refresh once the synchronous write transaction has ended.
  /** @type {import('./rollCandidatePools.js').GetRollCandidatePool} */
  const getRollPool = (pool, constraint) => {
    if (rollPools && rollPools.revision === releaseRevision(db))
      return rollPools.poolFor(pool, constraint);
    if (
      refreshQueued ||
      Date.now() < retryRefreshAt ||
      (!rollPools &&
        db.prepare("PRAGMA user_version").get().user_version !== 12)
    )
      return;
    refreshQueued = true;
    setImmediate(() => {
      refreshQueued = false;
      if (db.isOpen) warmRollPools();
    }).unref();
  };
  function get() {
    if (cached && key(db) === cachedKey) return cached;
    db.exec("BEGIN");
    try {
      const nextKey = key(db);
      const next = {
        revision: revision(db),
        franchiseCurrent: isFranchiseCatalogCurrent(db),
        characterIndex: prepareCharacterSearchIndex(loadCharacterIndex(db)),
        franchiseIndex: prepareFranchiseSearchIndex(loadFranchiseIndex(db)),
        directFranchiseIndex: prepareFranchiseSearchIndex(
          loadFranchiseIndex(db, { directOnly: true }),
        ),
      };
      db.exec("COMMIT");
      cached = next;
      cachedKey = nextKey;
      return cached;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  return { get, warmRollPools, getRollPool };
}
