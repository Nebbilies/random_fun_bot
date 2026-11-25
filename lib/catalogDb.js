import {
  mkdirSync,
  mkdtempSync,
  existsSync,
  statSync,
  openSync,
  closeSync,
  renameSync,
} from "node:fs";
import {
  installEmptyFinalCatalog,
  validateFinalCatalogSchema,
  assertCharacterRankingInstalled,
  hasCharacterRanking,
  isMainFranchiseColumnCatalogSchema,
  isPreMainFranchiseCatalogSchema,
} from "./catalogFinalSchema.js";
import { dirname, join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { initItemStorage } from "./itemStorage.js";
import { initVaultRewards } from "./vaultRewards.js";
import { initGameConfig } from "./gameConfig.js";
import { isCharacterId } from "./characterIdentity.js";
import { publishSourceCatalog } from "./sourceCatalogPublication.js";
import {
  ensureFortuneCatalog,
  upgradeMainFranchiseCatalog,
} from "./vaultFortuneUpgrade.js";
import {
  previewCatalogMutation,
  confirmCatalogMutation,
} from "./catalogMutations.js";
import { nestedCatalogMutationConnection } from "./catalogMutationProtocol.js";
import { migrateAegisDuration } from "./aegisDurationMigration.js";
import { hasSeasonSchema, installSeasonSchema } from "./seasonSchema.js";

const DEFAULT_FILE = fileURLToPath(
  new URL("../data/bot.sqlite", import.meta.url),
);

export function openCatalog(path = DEFAULT_FILE) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout=5000");
  const version = Number(db.prepare("PRAGMA user_version").get()?.user_version);
  if (version === 12) {
    try {
      assertCharacterRankingInstalled(db);
      ensureFortuneCatalog(db);
      ensureSeasonSchema(db);
      db.exec("BEGIN");
      validateFinalCatalogSchema(db, { readOnly: false });
      db.exec("COMMIT; PRAGMA foreign_keys = ON");
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }
  if (version < 0 || version > 10) {
    db.close();
    throw new Error(`Unsupported catalog database version ${version}`);
  }
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  try {
    return initializeLegacyCatalog(db, version);
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Authoritative legacy initializer, also used on an isolated in-memory connection
 * by offline conversion preflight. No file access or final-schema dispatch. */
export function initializeLegacyCatalog(db, version = 0) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
    CREATE TABLE IF NOT EXISTS catalog_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS guild_prefixes (
      guild_id TEXT PRIMARY KEY, prefix TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS guild_roll_limits (
      guild_id TEXT PRIMARY KEY, max_rolls INTEGER NOT NULL CHECK (max_rolls > 0)
    );
    CREATE TABLE IF NOT EXISTS guild_game_rates (
      guild_id TEXT PRIMARY KEY,
      vault_rate REAL NOT NULL DEFAULT 0.01 CHECK (vault_rate >= 0.0 AND vault_rate <= 1.0),
      prank_rate REAL NOT NULL DEFAULT 0.01 CHECK (prank_rate >= 0.0 AND prank_rate <= 1.0),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)
    );
    CREATE TABLE IF NOT EXISTS stage_characters (
      id INTEGER PRIMARY KEY, favourites INTEGER NOT NULL, name_full TEXT,
      name_native TEXT, name_alternatives TEXT, gender TEXT, age TEXT,
      date_of_birth TEXT, description TEXT, image_url TEXT, site_url TEXT,
      anime_titles TEXT, anime_ids TEXT, anime_adult INTEGER
    );
    CREATE INDEX IF NOT EXISTS stage_character_rank ON stage_characters (favourites ASC, id DESC);
    CREATE TABLE IF NOT EXISTS characters (
      id INTEGER PRIMARY KEY, rank INTEGER NOT NULL UNIQUE, favourites INTEGER NOT NULL,
      name_full TEXT, name_native TEXT, name_alternatives TEXT, gender TEXT,
      age TEXT, date_of_birth TEXT, description TEXT, image_url TEXT,
      site_url TEXT, anime_titles TEXT, anime_ids TEXT, anime_adult INTEGER
    );
    CREATE TABLE IF NOT EXISTS character_identities (
      id INTEGER PRIMARY KEY, name_full TEXT, image_url TEXT
    );
    CREATE TABLE IF NOT EXISTS anime (
      id INTEGER PRIMARY KEY, title_romaji TEXT, title_english TEXT, title_native TEXT,
      synonyms TEXT NOT NULL DEFAULT '[]', genres TEXT NOT NULL DEFAULT '[]',
      tags TEXT NOT NULL DEFAULT '[]', start_date TEXT, season_year INTEGER,
      format TEXT, status TEXT, average_score INTEGER, popularity INTEGER,
      is_adult INTEGER, cover_image TEXT, site_url TEXT, fetched_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS stage_anime (
      id INTEGER PRIMARY KEY, title_romaji TEXT, title_english TEXT, title_native TEXT,
      synonyms TEXT NOT NULL DEFAULT '[]', genres TEXT NOT NULL DEFAULT '[]',
      tags TEXT NOT NULL DEFAULT '[]', start_date TEXT, season_year INTEGER,
      format TEXT, status TEXT, average_score INTEGER, popularity INTEGER,
      is_adult INTEGER, cover_image TEXT, site_url TEXT, fetched_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS character_anime (
      character_id INTEGER NOT NULL, anime_id INTEGER NOT NULL,
      PRIMARY KEY (character_id, anime_id)
    );
    CREATE INDEX IF NOT EXISTS character_anime_by_anime ON character_anime (anime_id, character_id);
    CREATE TABLE IF NOT EXISTS stage_character_anime (
      character_id INTEGER NOT NULL, anime_id INTEGER NOT NULL,
      PRIMARY KEY (character_id, anime_id)
    );
    CREATE TABLE IF NOT EXISTS anime_relations (
      from_anime_id INTEGER NOT NULL, to_anime_id INTEGER NOT NULL,
      relation_type TEXT NOT NULL,
      PRIMARY KEY (from_anime_id, to_anime_id, relation_type)
    );
    CREATE INDEX IF NOT EXISTS anime_relations_by_target ON anime_relations (to_anime_id, from_anime_id);
    CREATE TABLE IF NOT EXISTS stage_anime_relations (
      from_anime_id INTEGER NOT NULL, to_anime_id INTEGER NOT NULL,
      relation_type TEXT NOT NULL,
      PRIMARY KEY (from_anime_id, to_anime_id, relation_type)
    );
    CREATE TABLE IF NOT EXISTS franchises (
      id INTEGER PRIMARY KEY AUTOINCREMENT, display_name TEXT NOT NULL,
      name_source TEXT NOT NULL DEFAULT 'automatic', created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS franchise_anime (
      franchise_id INTEGER NOT NULL, anime_id INTEGER NOT NULL,
      source TEXT NOT NULL DEFAULT 'automatic',
      PRIMARY KEY (franchise_id, anime_id)
    );
    CREATE INDEX IF NOT EXISTS franchise_anime_by_anime ON franchise_anime (anime_id, franchise_id);
    CREATE TABLE IF NOT EXISTS franchise_aliases (
      franchise_id INTEGER NOT NULL, alias TEXT NOT NULL,
      normalized_alias TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'automatic',
      PRIMARY KEY (franchise_id, normalized_alias)
    );
    CREATE INDEX IF NOT EXISTS franchise_alias_by_name ON franchise_aliases (normalized_alias);
    CREATE TABLE IF NOT EXISTS franchise_membership_overrides (
      anime_id INTEGER PRIMARY KEY, franchise_id INTEGER,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS marriages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL, character_id INTEGER NOT NULL,
      owner_id TEXT NOT NULL, married_at TEXT NOT NULL,
      UNIQUE (guild_id, character_id)
    );
    CREATE INDEX IF NOT EXISTS marriages_by_owner
      ON marriages (guild_id, owner_id, married_at DESC);
    CREATE TABLE IF NOT EXISTS roll_allowances (
      guild_id TEXT NOT NULL, user_id TEXT NOT NULL,
      period INTEGER NOT NULL, used INTEGER NOT NULL,
      PRIMARY KEY (guild_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS daily_roll_claims (
      guild_id TEXT NOT NULL, user_id TEXT NOT NULL, period INTEGER NOT NULL,
      PRIMARY KEY (guild_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS claim_allowances (
      guild_id TEXT NOT NULL, user_id TEXT NOT NULL, period INTEGER NOT NULL,
      PRIMARY KEY (guild_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS claim_events (
      guild_id TEXT NOT NULL, user_id TEXT NOT NULL, claimed_at INTEGER NOT NULL,
      PRIMARY KEY (guild_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS character_rolls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL, channel_id TEXT NOT NULL,
      command_message_id TEXT NOT NULL UNIQUE, message_id TEXT UNIQUE,
      character_id INTEGER NOT NULL, character_name TEXT NOT NULL,
      state TEXT NOT NULL, published_at INTEGER, expires_at INTEGER,
      UNIQUE (guild_id, channel_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS character_rolls_character
      ON character_rolls (guild_id, character_id, state);
    CREATE TABLE IF NOT EXISTS guild_mystery_settings (
      guild_id TEXT PRIMARY KEY, event_channel_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mystery_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL, origin_roll_id INTEGER NOT NULL UNIQUE,
      event_id TEXT NOT NULL, character_id INTEGER NOT NULL,
      rank_snapshot INTEGER NOT NULL, roller_id TEXT NOT NULL,
      event_channel_id TEXT NOT NULL, event_message_id TEXT,
      state TEXT NOT NULL, state_json TEXT, started_at INTEGER NOT NULL,
      next_at INTEGER, deadline_at INTEGER NOT NULL, winner_id TEXT,
      resolved_at INTEGER, outcome TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS mystery_sessions_one_active_guild
      ON mystery_sessions (guild_id)
      WHERE state IN ('reserved', 'running', 'countdown', 'claim_open');
    CREATE TABLE IF NOT EXISTS treasure_puzzle_wins (
      guild_id TEXT NOT NULL, puzzle_id TEXT NOT NULL, won_at INTEGER NOT NULL,
      PRIMARY KEY (guild_id, puzzle_id)
    );
    CREATE TABLE IF NOT EXISTS roll_notices (
      roll_id INTEGER NOT NULL, user_id TEXT NOT NULL,
      PRIMARY KEY (roll_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS tag_candidates (
      character_id INTEGER NOT NULL, tag_name TEXT NOT NULL,
      post_count INTEGER NOT NULL DEFAULT 0, reason TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (character_id, tag_name)
    );
    CREATE TABLE IF NOT EXISTS tag_match_progress (
      character_id INTEGER PRIMARY KEY, matched_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tag_search_cache (
      query TEXT PRIMARY KEY, response TEXT NOT NULL, fetched_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tag_decisions (
      character_id INTEGER PRIMARY KEY, status TEXT NOT NULL,
      tag_name TEXT, source TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS character_tag_reports (
      id INTEGER PRIMARY KEY, character_id INTEGER NOT NULL,
      reporter_id TEXT NOT NULL, reported_at TEXT NOT NULL,
      resolved_at TEXT, outcome TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS open_character_tag_reporter
      ON character_tag_reports (character_id, reporter_id) WHERE resolved_at IS NULL;
    CREATE TABLE IF NOT EXISTS duckduckgo_tag_attempts (
      character_id INTEGER PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
      query TEXT NOT NULL, first_url TEXT, second_url TEXT,
      outcome TEXT NOT NULL, tag_name TEXT, details TEXT NOT NULL,
      searched_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS character_wishes (
      guild_id TEXT NOT NULL, user_id TEXT NOT NULL, character_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (guild_id, user_id, character_id)
    );
    CREATE INDEX IF NOT EXISTS character_wishes_by_character
      ON character_wishes (guild_id, character_id);
  `);
    if (version === 1)
      db.exec(`INSERT OR IGNORE INTO character_identities (id, name_full, image_url)
    SELECT id, name_full, image_url FROM characters`);
    if (version < 6) {
      const rollColumns = new Set(
        db
          .prepare("PRAGMA table_info(character_rolls)")
          .all()
          .map((column) => column.name),
      );
      if (!rollColumns.has("mystery_session_id")) {
        db.exec(
          "ALTER TABLE character_rolls ADD COLUMN mystery_session_id INTEGER",
        );
      }
      if (!rollColumns.has("exclusive_user_id")) {
        db.exec(
          "ALTER TABLE character_rolls ADD COLUMN exclusive_user_id TEXT",
        );
      }
    }
    if (version < 7) {
      const rollColumns = new Set(
        db
          .prepare("PRAGMA table_info(character_rolls)")
          .all()
          .map((column) => column.name),
      );
      for (const [name, type] of Object.entries({
        escape_marriage_id: "INTEGER",
        escape_owner_id: "TEXT",
        protected_until: "INTEGER",
        escape_outcome: "TEXT",
        escape_winner_id: "TEXT",
        escape_resolved_at: "INTEGER",
      })) {
        if (!rollColumns.has(name))
          db.exec(`ALTER TABLE character_rolls ADD COLUMN ${name} ${type}`);
      }
    }
    initItemStorage(db);
    initVaultRewards(db);
    const configRollColumns = new Set(
      db
        .prepare("PRAGMA table_info(character_rolls)")
        .all()
        .map((column) => column.name),
    );
    if (!configRollColumns.has("rules_json"))
      db.exec("ALTER TABLE character_rolls ADD COLUMN rules_json TEXT");
    const dailyColumns = new Set(
      db
        .prepare("PRAGMA table_info(daily_roll_claims)")
        .all()
        .map((column) => column.name),
    );
    if (!dailyColumns.has("reset_at"))
      db.exec("ALTER TABLE daily_roll_claims ADD COLUMN reset_at INTEGER");
    initGameConfig(db);
    migrateAegisDuration(db);
    db.exec("PRAGMA user_version = 10; COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return db;
}

export function openCatalogReadOnly(path = DEFAULT_FILE) {
  const db = new DatabaseSync(path, { readOnly: true });
  const version = Number(db.prepare("PRAGMA user_version").get()?.user_version);
  if (version === 12) {
    try {
      db.exec("BEGIN");
      validateFinalCatalogSchema(db, { readOnly: true });
      db.exec("COMMIT");
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }
  if (version < 0 || version > 10) {
    db.close();
    throw new Error(`Unsupported catalog database version ${version}`);
  }
  return db;
}

/** Explicit final creation: requires an explicit absent path or zero-byte file.
 * Never initializes an existing SQLite database (even an empty v10 catalog). */
export function createFinalCatalog(path) {
  if (typeof path !== "string" || !path || path === ":memory:")
    throw new Error("Explicit file path required");
  if (existsSync(path)) {
    if (!statSync(path).isFile() || statSync(path).size !== 0)
      throw new Error("Final creation requires an empty file");
  } else {
    closeSync(openSync(path, "wx"));
  }
  const db = new DatabaseSync(path);
  try {
    if (
      db.prepare("SELECT 1 FROM sqlite_schema LIMIT 1").get() ||
      db.prepare("PRAGMA user_version").get()?.user_version !== 0
    )
      throw new Error("Final creation requires an empty file");
    db.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
    try {
      installEmptyFinalCatalog(db);
      installSeasonSchema(db);
      validateFinalCatalogSchema(db, { readOnly: false });
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Strict post-cutover startup. Writable opens apply known additive upgrades. */
export function openFinalCatalog(path, { readOnly = false } = {}) {
  if (
    typeof path !== "string" ||
    !path ||
    path === ":memory:" ||
    !existsSync(path)
  ) {
    throw new Error("Explicit existing final catalog file required");
  }
  const db = new DatabaseSync(path, { readOnly });
  try {
    assertCharacterRankingInstalled(db);
    if (!readOnly) {
      db.exec("PRAGMA busy_timeout=5000");
      ensureFortuneCatalog(db);
      ensureSeasonSchema(db);
    }
    db.exec("BEGIN");
    validateFinalCatalogSchema(db, { readOnly });
    db.exec("COMMIT");
    if (!readOnly) db.exec("PRAGMA foreign_keys=ON");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function openFinalCatalogReadOnly(path) {
  return openFinalCatalog(path, { readOnly: true });
}

function ensureSeasonSchema(db) {
  if (hasSeasonSchema(db)) return;
  const timeout = Number(db.prepare("PRAGMA busy_timeout").get()?.timeout);
  const upgradeTimeout = Math.max(timeout, 60_000);
  if (upgradeTimeout !== timeout)
    db.exec(`PRAGMA busy_timeout=${upgradeTimeout}`);
  try {
    transaction(db, () => {
      if (hasSeasonSchema(db)) return;
      validateFinalCatalogSchema(db, { readOnly: false });
      installSeasonSchema(db);
      validateFinalCatalogSchema(db, { readOnly: false });
    });
  } finally {
    if (upgradeTimeout !== timeout) db.exec(`PRAGMA busy_timeout=${timeout}`);
  }
}

async function backupMainFranchiseColumnCatalog(db, backupDirectory) {
  mkdirSync(backupDirectory, { recursive: true });
  const directory = mkdtempSync(join(backupDirectory, "main-franchise-"));
  const backupPath = join(directory, "bot.sqlite");
  const partialPath = `${backupPath}.partial`;
  await backup(db, partialPath);
  const snapshot = new DatabaseSync(partialPath);
  try {
    // The disposable snapshot can use SQLite's native integrity check instead of replaying it in memory.
    validateFinalCatalogSchema(snapshot, {
      readOnly: false,
      mainFranchiseColumn: true,
    });
    const assignments =
      "SELECT id, main_franchise_id FROM characters WHERE main_franchise_id IS NOT NULL ORDER BY id";
    const sourceAssignments = db.prepare(assignments);
    const snapshotAssignments = snapshot.prepare(assignments);
    sourceAssignments.setReadBigInts(true);
    snapshotAssignments.setReadBigInts(true);
    if (
      !isDeepStrictEqual(sourceAssignments.all(), snapshotAssignments.all())
    ) {
      throw new Error(
        "Main franchise backup does not contain the same assignments",
      );
    }
  } finally {
    snapshot.close();
  }
  renameSync(partialPath, backupPath);
  return backupPath;
}

/** Called with application writers stopped, before the deployment restarts them. */
export async function validateCatalogForDeployment(
  path,
  { backupDirectory = join(dirname(path), "backups") } = {},
) {
  const db = new DatabaseSync(path, { readOnly: true });
  let needsUpgrade;
  let backupPath = null;
  try {
    db.exec("PRAGMA busy_timeout=5000; BEGIN");
    const hasMainFranchiseColumn = isMainFranchiseColumnCatalogSchema(db);
    needsUpgrade =
      hasMainFranchiseColumn || isPreMainFranchiseCatalogSchema(db);
    if (!needsUpgrade) validateFinalCatalogSchema(db, { readOnly: true });
    if (hasMainFranchiseColumn) {
      backupPath = await backupMainFranchiseColumnCatalog(db, backupDirectory);
      console.log(`Pre-migration main franchise backup: ${backupPath}`);
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }
  if (!needsUpgrade) return { backupPath };

  const writer = new DatabaseSync(path);
  try {
    writer.exec("PRAGMA foreign_keys=ON");
    upgradeMainFranchiseCatalog(writer, { dryRun: false });
  } finally {
    writer.close();
  }
  openFinalCatalogReadOnly(path).close();
  return { backupPath };
}

/**
 * @typedef {{id: string | number, name: string | null, portraitUrl: string | null,
 *   inCatalog: boolean, tagName: string | null}} CharacterIdentity
 */

/**
 * @param {DatabaseSync} db
 * @param {string | number} characterId
 * @returns {CharacterIdentity | null}
 */
export function getCharacterIdentity(db, characterId) {
  const row =
    /** @type {{id: string | number, name: string | null, portraitUrl: string | null,
    inCatalog: number, tagName: string | null} | undefined} */ (
      db
        .prepare(
          `SELECT identity.id, identity.name_full AS name,
    identity.image_url AS portraitUrl,
    EXISTS(SELECT 1 FROM characters WHERE id = identity.id) AS inCatalog,
    decision.tag_name AS tagName
    FROM character_identities AS identity
    LEFT JOIN tag_decisions AS decision
      ON decision.character_id = identity.id AND decision.status = 'approve'
    WHERE identity.id = ?`,
        )
        .get(characterId)
    );
  return row ? { ...row, inCatalog: Boolean(row.inCatalog) } : null;
}

export function getMeta(db, key) {
  return (
    db.prepare("SELECT value FROM catalog_meta WHERE key = ?").get(key)
      ?.value ?? null
  );
}

export function setMeta(db, key, value) {
  db.prepare(
    "INSERT INTO catalog_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, String(value));
}

export function transaction(db, callback) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = callback();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

// A bounded leaderboard makes interrupted scans cheap to resume.
/**
 * @typedef {{id: number, favourites?: number | null}} CatalogCandidate
 */

/**
 * @param {DatabaseSync} db
 * @param {CatalogCandidate} character
 * @param {number | null} [limit] Null keeps every discovered candidate.
 */
export function keepCandidate(db, character, limit = 15_000) {
  const { id } = character;
  const favourites = character.favourites ?? 0;
  if (!Number.isInteger(id) || !Number.isInteger(favourites))
    throw new Error("Invalid AniList character");
  const existing = db
    .prepare("SELECT id FROM stage_characters WHERE id = ?")
    .get(id);
  if (existing) {
    if (limit === null)
      db.prepare("UPDATE stage_characters SET favourites = ? WHERE id = ?").run(
        favourites,
        id,
      );
    return true;
  }
  if (limit === null) {
    db.prepare(
      "INSERT INTO stage_characters (id, favourites) VALUES (?, ?)",
    ).run(id, favourites);
    return true;
  }
  const count = Number(
    db.prepare("SELECT COUNT(*) AS count FROM stage_characters").get()?.count,
  );
  const worst =
    count >= limit
      ? /** @type {{id: number, favourites: number} | undefined} */
        (
          db
            .prepare(
              "SELECT id, favourites FROM stage_characters ORDER BY favourites ASC, id DESC LIMIT 1",
            )
            .get()
        )
      : null;
  if (
    worst &&
    (favourites < worst.favourites ||
      (favourites === worst.favourites && id > worst.id))
  )
    return false;
  db.prepare("INSERT INTO stage_characters (id, favourites) VALUES (?, ?)").run(
    id,
    favourites,
  );
  if (worst)
    db.prepare("DELETE FROM stage_characters WHERE id = ?").run(worst.id);
  return true;
}

/**
 * @param {DatabaseSync} db
 * @param {() => void} [beforeInsert]
 */
export function publishCatalog(db, beforeInsert = () => {}) {
  return transaction(db, () => {
    beforeInsert();
    if (
      db
        .prepare(
          "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='character_sources'",
        )
        .get()
    ) {
      return publishSourceCatalog(db);
    }
    const incomplete = db
      .prepare(
        `SELECT stage.id FROM stage_characters AS stage
      LEFT JOIN characters AS current ON current.id = stage.id
      WHERE stage.name_full IS NULL AND current.id IS NULL LIMIT 1`,
      )
      .get();
    if (incomplete)
      throw new Error("Cannot publish incomplete catalog metadata");
    db.exec(`CREATE TEMP TABLE next_characters AS SELECT * FROM characters;
      UPDATE next_characters SET favourites =
        (SELECT stage.favourites FROM stage_characters AS stage WHERE stage.id = next_characters.id)
        WHERE id IN (SELECT id FROM stage_characters);
      DELETE FROM next_characters WHERE id IN
        (SELECT id FROM stage_characters WHERE name_full IS NOT NULL);
      INSERT INTO next_characters
        SELECT id, 0, favourites, name_full, name_native, name_alternatives,
          gender, age, date_of_birth, description, image_url, site_url,
          anime_titles, anime_ids, anime_adult
        FROM stage_characters WHERE name_full IS NOT NULL;
      CREATE TEMP TABLE next_ranks AS
        SELECT id, ROW_NUMBER() OVER (ORDER BY favourites DESC, id ASC) AS rank
        FROM next_characters;
      CREATE UNIQUE INDEX next_ranks_by_id ON next_ranks (id);
      UPDATE next_characters SET rank =
        (SELECT rank FROM next_ranks WHERE next_ranks.id = next_characters.id);
      INSERT INTO character_identities (id, name_full, image_url)
        SELECT id, name_full, image_url FROM stage_characters WHERE name_full IS NOT NULL
        ON CONFLICT(id) DO UPDATE SET
          name_full = excluded.name_full, image_url = excluded.image_url;`);
    // Publication is additive: update retained rows rather than delete/reinsert,
    // which would cascade-delete completed per-character enrichment attempts.
    // Move existing ranks out of the way before assigning the new unique ranks.
    const maxRank = Number(
      db.prepare("SELECT COALESCE(MAX(rank), 0) AS n FROM characters").get()?.n,
    );
    const nextCount = Number(
      db.prepare("SELECT COUNT(*) AS n FROM next_characters").get()?.n,
    );
    if (!Number.isSafeInteger(2 * maxRank + nextCount + 1))
      throw new Error("Catalog rank overflow");
    db.prepare("UPDATE characters SET rank = rank + ?").run(
      maxRank + nextCount + 1,
    );
    db.exec(`INSERT INTO characters SELECT * FROM next_characters WHERE true
      ON CONFLICT(id) DO UPDATE SET
        rank=excluded.rank, favourites=excluded.favourites,
        name_full=excluded.name_full, name_native=excluded.name_native,
        name_alternatives=excluded.name_alternatives, gender=excluded.gender,
        age=excluded.age, date_of_birth=excluded.date_of_birth,
        description=excluded.description, image_url=excluded.image_url,
        site_url=excluded.site_url, anime_titles=excluded.anime_titles,
        anime_ids=excluded.anime_ids, anime_adult=excluded.anime_adult;
      DELETE FROM tag_candidates; DELETE FROM tag_match_progress;
      DROP TABLE next_ranks;
      DROP TABLE next_characters;`);
    db.prepare(
      `UPDATE character_tag_reports SET resolved_at = ?, outcome = 'unavailable'
      WHERE resolved_at IS NULL AND NOT EXISTS
      (SELECT 1 FROM characters WHERE characters.id = character_tag_reports.character_id)`,
    ).run(new Date().toISOString());
    setMeta(db, "published_at", new Date().toISOString());
    return Number(
      db.prepare("SELECT COUNT(*) AS count FROM characters").get()?.count,
    );
  });
}

/**
 * @param {DatabaseSync} db
 * @param {string | number} characterId
 * @param {'approve' | 'no_match'} status
 * @param {string | null} [tagName]
 * @param {string} [source]
 */
export function saveDecision(
  db,
  characterId,
  status,
  tagName = null,
  source = "manual",
  tagEvidence = null,
) {
  if (!["approve", "no_match"].includes(status))
    throw new Error("Invalid tag decision");
  if (status === "approve" && !tagName)
    throw new Error("Tag required for approval");
  if (hasCharacterRanking(db)) {
    const nested = nestedCatalogMutationConnection(db);
    const attribution = { account: `tag-writer:${source}`, role: "admin" };
    const preview = previewCatalogMutation(nested, {
      ...attribution,
      operation: "tag",
      input: { characterId, status, tagName, source },
      tagEvidence,
    });
    return confirmCatalogMutation(nested, {
      ...attribution,
      previewId: preview.previewId,
      payloadHash: preview.payloadHash,
      idempotencyKey: preview.previewId,
    });
  }
  // Legacy/automatic matchers also participate in durable invalidation. Human
  // v12 portal decisions use the attributed catalog mutation service instead.
  const typed = db
    .prepare(
      "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='catalog_state'",
    )
    .get();
  const ownsTransaction = !db.isTransaction;
  if (ownsTransaction) db.exec("BEGIN IMMEDIATE");
  try {
    const revision = typed
      ? Number(
          db
            .prepare("SELECT revision FROM catalog_state WHERE singleton=1")
            .get()?.revision,
        )
      : 0;
    if (
      typed &&
      (!Number.isSafeInteger(revision) ||
        revision < 0 ||
        revision >= Number.MAX_SAFE_INTEGER)
    )
      throw new Error("Catalog revision overflow");
    db.prepare(
      `INSERT INTO tag_decisions (character_id, status, tag_name, source, updated_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(character_id) DO UPDATE SET
      status = excluded.status, tag_name = excluded.tag_name,
      source = excluded.source, updated_at = excluded.updated_at`,
    ).run(
      characterId,
      status,
      status === "approve" ? tagName : null,
      source,
      new Date().toISOString(),
    );
    if (typed) {
      db.prepare("UPDATE catalog_state SET revision=? WHERE singleton=1").run(
        revision + 1,
      );
    }
    if (ownsTransaction) db.exec("COMMIT");
  } catch (error) {
    if (ownsTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

export function reportCharacterTag(db, characterId, reporterId) {
  if (
    !(
      isCharacterId(characterId) ||
      (Number.isSafeInteger(characterId) && characterId > 0)
    ) ||
    typeof reporterId !== "string" ||
    !reporterId
  ) {
    throw new Error("Invalid character tag report");
  }
  return (
    db
      .prepare(
        `INSERT OR IGNORE INTO character_tag_reports
    (character_id, reporter_id, reported_at)
    SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM characters WHERE id = ?)`,
      )
      .run(characterId, reporterId, new Date().toISOString(), characterId)
      .changes === 1
  );
}

export function resolveCharacterTagReports(db, characterId, outcome) {
  if (!["corrected", "dismissed"].includes(outcome))
    throw new Error("Invalid report resolution");
  return db
    .prepare(
      `UPDATE character_tag_reports SET resolved_at = ?, outcome = ?
    WHERE character_id = ? AND resolved_at IS NULL`,
    )
    .run(new Date().toISOString(), outcome, characterId).changes;
}
