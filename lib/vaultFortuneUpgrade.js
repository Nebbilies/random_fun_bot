import {
  AFFECTION_DDL,
  AFFECTION_AWARDS_DDL,
  activateAffectionSchema,
} from "./affectionSchema.js";
import { CHARACTER_GENDER_DDL } from "./characterGenderSchema.js";
import { OWNERSHIP_HISTORY_DDL } from "./ownershipHistorySchema.js";
import { ITEM_REWARD_SOURCE_DDL } from "./itemRewardSourceSchema.js";
import { migrateItemExpiry } from "./itemExpiryMigration.js";
import {
  MAIN_FRANCHISE_DDL,
  isMainFranchiseColumnCatalogSchema,
  isPreMainFranchiseCatalogSchema,
  isPreSoulmateReclaimCatalogSchema,
  isPreAffectionCatalogSchema,
  isPreGenderCatalogSchema,
  isPreExpiryCatalogSchema,
  isPreFortuneCatalogSchema,
  isPrePhase2CatalogSchema,
  validateFinalCatalogSchema,
} from "./catalogFinalSchema.js";
import { FORTUNE_DDL } from "./vaultFortuneSchema.js";
import {
  isAegisDurationMigrationPending,
  migrateAegisDuration,
} from "./aegisDurationMigration.js";

/** Owns the write transaction and restores the caller's timeout. */
function catalogUpgrade(db, dryRun, apply) {
  if (db.isTransaction)
    throw new Error("Catalog upgrade requires its own transaction");
  const busyTimeout = Number(db.prepare("PRAGMA busy_timeout").get().timeout);
  // Bot and portal can start together. Full production validation holds the
  // migration lock longer than the ordinary 5s connection timeout. Let SQLite's
  // busy handler wait up to 60s (no spin/retry loop), retaining any longer caller
  // policy. Restore the connection policy on success and failure alike.
  const upgradeBusyTimeout = Math.max(busyTimeout, 60000);
  if (busyTimeout !== upgradeBusyTimeout)
    db.exec(`PRAGMA busy_timeout=${upgradeBusyTimeout}`);
  let ownsTransaction = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    ownsTransaction = true;
    const result = apply();
    validateFinalCatalogSchema(db, { readOnly: false });
    db.exec(dryRun ? "ROLLBACK" : "COMMIT");
    return result;
  } catch (error) {
    if (ownsTransaction && db.isTransaction !== false) db.exec("ROLLBACK");
    throw error;
  } finally {
    if (busyTimeout !== upgradeBusyTimeout)
      db.exec(`PRAGMA busy_timeout=${busyTimeout}`);
  }
}

function addMainFranchiseIfNeeded(db) {
  if (isMainFranchiseColumnCatalogSchema(db)) {
    db.exec(MAIN_FRANCHISE_DDL);
    db.exec(`INSERT INTO character_main_franchises (character_id, franchise_id)
      SELECT id, main_franchise_id FROM characters WHERE main_franchise_id IS NOT NULL`);
    const mismatch = db
      .prepare(
        `WITH legacy AS (
      SELECT id, main_franchise_id FROM characters WHERE main_franchise_id IS NOT NULL
    ) SELECT EXISTS (SELECT * FROM legacy EXCEPT SELECT * FROM character_main_franchises)
      OR EXISTS (SELECT * FROM character_main_franchises EXCEPT SELECT * FROM legacy) AS mismatch`,
      )
      .get().mismatch;
    if (mismatch)
      throw new Error(
        "Main franchise assignments differ from the legacy column",
      );
    db.exec(
      "DROP INDEX characters_by_main_franchise; ALTER TABLE characters DROP COLUMN main_franchise_id",
    );
    return true;
  }
  if (!isPreMainFranchiseCatalogSchema(db)) return false;
  validateFinalCatalogSchema(db, { readOnly: false, mainFranchise: false });
  db.exec(MAIN_FRANCHISE_DDL);
  return true;
}

/** Upgrades only recognized ranked layouts for main franchise storage. */
export function upgradeMainFranchiseCatalog(db, { dryRun = true } = {}) {
  return catalogUpgrade(db, dryRun, () => {
    const changed = addMainFranchiseIfNeeded(db);
    return { dryRun, committed: changed && !dryRun };
  });
}

/** Applies recognized v12 upgrades and supports rollback-only rehearsal. */
export function upgradeFortuneCatalog(
  db,
  { dryRun = true, now = Date.now() } = {},
) {
  return catalogUpgrade(db, dryRun, () => {
    if (isPreFortuneCatalogSchema(db)) {
      validateFinalCatalogSchema(db, { readOnly: false, fortune: false });
      db.exec(FORTUNE_DDL);
    }
    if (isPreExpiryCatalogSchema(db)) {
      validateFinalCatalogSchema(db, { readOnly: false, expiry: false });
      migrateItemExpiry(db, { now });
    }
    if (isPrePhase2CatalogSchema(db)) {
      validateFinalCatalogSchema(db, { readOnly: false, phase2: false });
      db.exec(OWNERSHIP_HISTORY_DDL);
      db.exec(ITEM_REWARD_SOURCE_DDL);
    }
    if (isPreGenderCatalogSchema(db)) {
      validateFinalCatalogSchema(db, { readOnly: false, gender: false });
      db.exec(CHARACTER_GENDER_DDL);
    }
    if (isPreAffectionCatalogSchema(db)) {
      validateFinalCatalogSchema(db, { readOnly: false, affection: false });
      db.exec(AFFECTION_DDL);
      activateAffectionSchema(db, now);
    }
    if (isPreSoulmateReclaimCatalogSchema(db)) {
      validateFinalCatalogSchema(db, {
        readOnly: false,
        soulmateReclaim: false,
      });
      db.exec(
        "ALTER TABLE affection_awards RENAME TO affection_awards_reclaim_previous",
      );
      db.exec(AFFECTION_AWARDS_DDL);
      db.exec(`INSERT INTO affection_awards(rowid,source_key,guild_id,user_id,character_id,base,amount,total,milestones_json,created_at)
        SELECT rowid,source_key,guild_id,user_id,character_id,base,amount,total,milestones_json,created_at
        FROM affection_awards_reclaim_previous ORDER BY rowid;
        DROP TABLE affection_awards_reclaim_previous;`);
    }
    migrateAegisDuration(db, { now });
    addMainFranchiseIfNeeded(db);
    return {
      dryRun,
      committed: !dryRun,
      catalogVersion: 12,
      fortuneVersion: 1,
      itemExpiryVersion: 1,
      ownershipHistoryVersion: 1,
      itemRewardSourceVersion: 1,
      affectionVersion: 1,
    };
  });
}

/** Avoid a write lock on already-current opens. The upgrade itself must recheck
 * after BEGIN IMMEDIATE because another first-start process may have won. */
export function ensureFortuneCatalog(db) {
  if (
    isMainFranchiseColumnCatalogSchema(db) ||
    isPreMainFranchiseCatalogSchema(db) ||
    isPreSoulmateReclaimCatalogSchema(db) ||
    isPreAffectionCatalogSchema(db) ||
    isPreGenderCatalogSchema(db) ||
    isPreFortuneCatalogSchema(db) ||
    isPreExpiryCatalogSchema(db) ||
    isPrePhase2CatalogSchema(db) ||
    isAegisDurationMigrationPending(db)
  )
    upgradeFortuneCatalog(db, { dryRun: false });
}
