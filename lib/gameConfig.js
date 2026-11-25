import { hasSeasonSchema } from "./seasonSchema.js";
import { adjustSeasonSchedules } from "../features/seasons/seasonStore.js";
import {
  GAME_CONFIG_DEFAULTS,
  GAME_CONFIG_REGISTRY,
  GAME_CONFIG_SECTIONS,
  setConfigPath,
  validateConfigValue,
  validateGameConfig,
} from "./gameConfigSchema.js";

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}
function scopeId(guildId) {
  if (guildId == null) return "";
  if (typeof guildId !== "string" || !/^\d{1,32}$/.test(guildId))
    throw failure("CONFIG_VALIDATION", "Invalid guild ID");
  return guildId;
}
function hasTable(db, name) {
  return Boolean(
    db
      ?.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name),
  );
}

/** Caller may run this inside the catalog migration transaction. Never creates audit history. */
export function initGameConfig(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS game_config_state (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1), revision INTEGER NOT NULL DEFAULT 0
  );
  INSERT OR IGNORE INTO game_config_state(singleton, revision) VALUES (1, 0);
  CREATE TABLE IF NOT EXISTS game_config_overrides (
    scope_id TEXT NOT NULL, key TEXT NOT NULL, value_json TEXT NOT NULL,
    PRIMARY KEY(scope_id, key)
  );`);
  // The state row is a durable import marker; schema creation precedes the one-time import.
  const imported = db
    .prepare(
      "SELECT 1 FROM game_config_overrides WHERE key = '__legacy_imported'",
    )
    .get();
  if (!imported) {
    const insert = db.prepare(
      "INSERT OR IGNORE INTO game_config_overrides(scope_id,key,value_json) VALUES(?,?,?)",
    );
    if (hasTable(db, "guild_roll_limits")) {
      for (const row of db
        .prepare("SELECT guild_id,max_rolls FROM guild_roll_limits")
        .all()) {
        insert.run(
          row.guild_id,
          "rolls.maxRolls",
          JSON.stringify(row.max_rolls),
        );
      }
    }
    if (hasTable(db, "guild_game_rates")) {
      for (const row of db
        .prepare("SELECT guild_id,vault_rate,prank_rate FROM guild_game_rates")
        .all()) {
        insert.run(
          row.guild_id,
          "vault.dropRate",
          JSON.stringify(row.vault_rate),
        );
        insert.run(
          row.guild_id,
          "rolls.prankRate",
          JSON.stringify(row.prank_rate),
        );
      }
    }
    insert.run("", "__legacy_imported", "true");
  }
  // Legacy administrative setters remain observable even before their callers migrate.
  /** @type {Array<[string, Array<[string, string]>]>} */
  const bridges = [
    ["guild_roll_limits", [["max_rolls", "rolls.maxRolls"]]],
    [
      "guild_game_rates",
      [
        ["vault_rate", "vault.dropRate"],
        ["prank_rate", "rolls.prankRate"],
      ],
    ],
  ];
  for (const [table, mappings] of bridges) {
    if (!hasTable(db, table)) continue;
    for (const operation of ["INSERT", "UPDATE"]) {
      // Replace deployed unconditional UPDATE bridges, not just fresh installations.
      if (operation === "UPDATE")
        db.exec(`DROP TRIGGER IF EXISTS game_config_${table}_update`);
      db.exec(`CREATE TRIGGER IF NOT EXISTS game_config_${table}_${operation.toLowerCase()}
        AFTER ${operation} ON ${table} BEGIN
        ${mappings
          .map(
            ([
              column,
              key,
            ]) => `INSERT INTO game_config_overrides(scope_id,key,value_json)
          SELECT NEW.guild_id,'${key}',CAST(NEW.${column} AS TEXT)
          WHERE ${operation === "UPDATE" && table === "guild_game_rates" ? `OLD.${column} IS NOT NEW.${column}` : "1"}
          ON CONFLICT(scope_id,key) DO UPDATE SET value_json=excluded.value_json;`,
          )
          .join("\n")}
        UPDATE game_config_state SET revision=revision+1 WHERE singleton=1;
      END;`);
    }
    db.exec(`CREATE TRIGGER IF NOT EXISTS game_config_${table}_delete AFTER DELETE ON ${table} BEGIN
      DELETE FROM game_config_overrides WHERE scope_id=OLD.guild_id AND key IN (${mappings.map(([, key]) => `'${key}'`).join(",")});
      UPDATE game_config_state SET revision=revision+1 WHERE singleton=1;
    END;`);
  }
}

function readState(db) {
  if (!db) return { revision: 0, rows: [] };
  if (!hasTable(db, "game_config_state")) {
    const rows = [];
    if (hasTable(db, "guild_roll_limits")) {
      for (const row of db
        .prepare("SELECT guild_id,max_rolls FROM guild_roll_limits")
        .all()) {
        rows.push({
          scope_id: row.guild_id,
          key: "rolls.maxRolls",
          value_json: JSON.stringify(row.max_rolls),
        });
      }
    }
    if (hasTable(db, "guild_game_rates")) {
      for (const row of db
        .prepare("SELECT guild_id,vault_rate,prank_rate FROM guild_game_rates")
        .all()) {
        rows.push(
          {
            scope_id: row.guild_id,
            key: "vault.dropRate",
            value_json: JSON.stringify(row.vault_rate),
          },
          {
            scope_id: row.guild_id,
            key: "rolls.prankRate",
            value_json: JSON.stringify(row.prank_rate),
          },
        );
      }
    }
    return { revision: 0, rows };
  }
  // One statement gives a consistent revision + values snapshot without nesting transactions.
  const snapshot = db
    .prepare(
      `SELECT s.revision,o.scope_id,o.key,o.value_json
    FROM game_config_state s LEFT JOIN game_config_overrides o ON 1=1 WHERE s.singleton=1`,
    )
    .all();
  return {
    revision: snapshot[0]?.revision ?? 0,
    rows: snapshot.filter((row) => row.key != null),
  };
}

function resolve(state, scope) {
  const effective = structuredClone(GAME_CONFIG_DEFAULTS);
  const sources = Object.fromEntries(
    Object.keys(GAME_CONFIG_REGISTRY).map((key) => [key, "builtin"]),
  );
  const overrides = {};
  for (const selected of scope ? ["", scope] : [""]) {
    for (const row of state.rows) {
      if (
        row.scope_id !== selected ||
        !Object.hasOwn(GAME_CONFIG_REGISTRY, row.key)
      )
        continue;
      const value = JSON.parse(row.value_json);
      setConfigPath(effective, row.key, value);
      sources[row.key] = selected ? "guild" : "global";
      if (selected === scope) overrides[row.key] = value;
    }
  }
  return {
    guildId: scope || null,
    revision: state.revision,
    effective,
    defaults: structuredClone(GAME_CONFIG_DEFAULTS),
    sources,
    overrides,
    registry: GAME_CONFIG_REGISTRY,
    sections: GAME_CONFIG_SECTIONS,
  };
}

/** No process-local caches; every call sees the latest committed SQLite snapshot.
 * @param {any} [db]
 * @param {string | null} [guildId]
 */
export function getConfigView(db = null, guildId = null) {
  // Read-only callers may probe a missing/invalid Discord scope; never turn that into a write scope.
  const scope =
    typeof guildId === "string" && /^\d{1,32}$/.test(guildId) ? guildId : "";
  return resolve(readState(db), scope);
}
/** @param {any} [db] @param {string | null} [guildId] */
export function getGameConfig(db = null, guildId = null) {
  return getConfigView(db, guildId).effective;
}

function checkScopeCombinations(state) {
  validateGameConfig(resolve(state, "").effective);
  for (const scope of new Set(
    state.rows.map((row) => row.scope_id).filter(Boolean),
  )) {
    try {
      validateGameConfig(resolve(state, scope).effective);
    } catch (error) {
      throw new Error(`Guild ${scope}: ${error.message}`);
    }
  }
}

/** Atomic partial section save/reset, guarded by a database-wide optimistic revision.
 * @param {any} db
 * @param {{guildId?: string | null, section?: string, values?: Record<string, any>, reset?: true | string[], expectedRevision?: number, activateSchedule?: boolean}} request
 */
export function saveConfigSection(db, request = {}) {
  const {
    guildId = null,
    section,
    values = {},
    reset = [],
    expectedRevision,
    activateSchedule = false,
  } = request;
  const scope = scopeId(guildId);
  if (!db || !hasTable(db, "game_config_state"))
    throw failure("CONFIG_STORAGE", "Configuration storage is not initialized");
  if (
    typeof section !== "string" ||
    !GAME_CONFIG_SECTIONS.includes(section) ||
    !values ||
    typeof values !== "object" ||
    Array.isArray(values) ||
    (reset !== true && !Array.isArray(reset)) ||
    typeof expectedRevision !== "number" ||
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 0
  ) {
    throw failure(
      "CONFIG_VALIDATION",
      "Invalid section save or missing revision",
    );
  }
  const changes = Object.entries(values);
  const resets =
    reset === true
      ? Object.keys(GAME_CONFIG_REGISTRY).filter((key) =>
          key.startsWith(`${section}.`),
        )
      : reset;
  try {
    for (const key of [...changes.map(([key]) => key), ...resets]) {
      if (
        typeof key !== "string" ||
        !Object.hasOwn(GAME_CONFIG_REGISTRY, key) ||
        GAME_CONFIG_REGISTRY[key].section !== section
      ) {
        throw new Error(`Unknown rule in section ${section}: ${String(key)}`);
      }
    }
    for (const [key, value] of changes) {
      if (resets.includes(key))
        throw new Error(`Cannot save and reset ${key} together`);
      validateConfigValue(key, value);
    }
  } catch (error) {
    throw failure("CONFIG_VALIDATION", error.message);
  }
  if (section === "schedules" && !activateSchedule) {
    throw failure(
      "CONFIG_ACTIVATION_REQUIRED",
      "Schedule changes require explicit activation and start fresh allowance cycles",
    );
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    const before = readState(db);
    if (before.revision !== expectedRevision)
      throw failure(
        "CONFIG_STALE",
        "Configuration changed; reload before saving",
      );
    const remove = db.prepare(
      "DELETE FROM game_config_overrides WHERE scope_id=? AND key=?",
    );
    const insert =
      db.prepare(`INSERT INTO game_config_overrides(scope_id,key,value_json) VALUES(?,?,?)
      ON CONFLICT(scope_id,key) DO UPDATE SET value_json=excluded.value_json`);
    for (const key of resets) remove.run(scope, key);
    for (const [key, value] of changes)
      insert.run(scope, key, JSON.stringify(value));
    const after = readState(db);
    try {
      if (!scope) checkScopeCombinations(after);
      else validateGameConfig(resolve(after, scope).effective);
    } catch (error) {
      throw failure("CONFIG_VALIDATION", error.message);
    }
    if (section === "schedules") activateSchedules(db, before, after, scope);
    db.prepare(
      "UPDATE game_config_state SET revision=revision+1 WHERE singleton=1",
    ).run();
    const result = resolve({ ...after, revision: after.revision + 1 }, scope);
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    if (error.code?.startsWith("CONFIG_")) throw error;
    throw failure("CONFIG_STORAGE", "Unable to save game configuration");
  }
}

function activateSchedules(db, before, after, scope) {
  // Discover every affected guild, including guilds inheriting all values.
  const guilds = new Set(
    scope ? [scope] : after.rows.map((row) => row.scope_id).filter(Boolean),
  );
  const seasons = hasSeasonSchema(db);
  if (seasons && !scope)
    for (const row of db
      .prepare(
        "SELECT DISTINCT guild_id FROM season_rollovers WHERE phase IN ('queued','posting','announced')",
      )
      .all())
      guilds.add(row.guild_id);
  if (!scope)
    for (const table of [
      "roll_allowances",
      "claim_allowances",
      "claim_events",
      "daily_roll_claims",
    ]) {
      if (hasTable(db, table))
        for (const row of db
          .prepare(`SELECT DISTINCT guild_id FROM ${table}`)
          .all())
          guilds.add(row.guild_id);
    }
  const remove = (table, guild) => {
    if (hasTable(db, table))
      db.prepare(`DELETE FROM ${table} WHERE guild_id=?`).run(guild);
  };
  for (const guild of guilds) {
    const oldRules = resolve(before, guild).effective.schedules;
    const newRules = resolve(after, guild).effective.schedules;
    if (seasons)
      adjustSeasonSchedules(db, guild, oldRules, newRules, Date.now());
    if (
      oldRules.rollIntervalMs !== newRules.rollIntervalMs ||
      oldRules.timezoneOffsetMinutes !== newRules.timezoneOffsetMinutes
    ) {
      remove("roll_allowances", guild);
    }
    if (
      oldRules.claimIntervalMs !== newRules.claimIntervalMs ||
      oldRules.timezoneOffsetMinutes !== newRules.timezoneOffsetMinutes
    ) {
      remove("claim_allowances", guild);
      remove("claim_events", guild);
    }
    // Daily claim records are deliberately retained; runtime owns daily bucket interpretation.
  }
}
