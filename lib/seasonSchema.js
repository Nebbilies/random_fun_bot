const participants = {
  marriages: "owner_id",
  roll_allowances: "user_id",
  claim_allowances: "user_id",
  claim_events: "user_id",
  daily_roll_claims: "user_id",
  character_wishes: "user_id",
  player_soulmates: "user_id",
  character_affection: "user_id",
  user_inventory: "user_id",
  item_actions: "actor_id",
  mystery_sessions: "roller_id",
  vault_sessions: "user_id",
};

const receiptKeys = {
  character_rolls: ["id"],
  mystery_sessions: ["id"],
  vault_sessions: ["vault_id"],
  vault_rewards: ["vault_id"],
  item_actions: ["id"],
  affection_requests: ["source_key"],
  affection_invocations: ["invocation_id"],
  affection_contexts: ["source_key"],
  affection_decisions: [
    "source_key",
    "guild_id",
    "user_id",
    "effect",
    "ordinal",
  ],
  affection_awards: ["source_key", "guild_id", "user_id", "character_id"],
  reward_grants: ["source_key"],
  reward_use_costs: ["source_key"],
};
export const SEASON_RECEIPT_TABLES = Object.keys(receiptKeys);

export function seasonReceiptKey(table, alias) {
  const columns = receiptKeys[table].map((column) => `${alias}.${column}`);
  return columns.length === 1
    ? `CAST(${columns[0]} AS TEXT)`
    : `json_array(${columns.join(",")})`;
}
const guardedTables = [
  ...new Set([
    ...Object.keys(participants),
    ...SEASON_RECEIPT_TABLES,
    "affection_entitlements",
    "character_ownership_losses",
    "active_user_buffs",
    "character_protection_locks",
    "counterfeit_crowns",
    "item_character_reservations",
    "user_inventory_limits",
    "fortune_holds",
    "fortune_armed",
    "fortune_recasts",
    "treasure_puzzle_wins",
  ]),
];

function enrolPlayer(table, event, user) {
  return `CREATE TRIGGER season_player_${table}_${event.toLowerCase()} AFTER ${event} ON ${table}
    WHEN length(NEW.guild_id)>0 AND length(NEW.${user})>0
    BEGIN
      INSERT OR IGNORE INTO guild_seasons(guild_id,season,started_at)
        VALUES(NEW.guild_id,1,CAST(ROUND(unixepoch('subsec')*1000) AS INTEGER));
      INSERT OR IGNORE INTO season_players(guild_id,season,user_id)
        SELECT guild_id,season,NEW.${user} FROM guild_seasons WHERE guild_id=NEW.guild_id;
    END;`;
}

function guardTable(table, event) {
  const scope = event === "INSERT" ? "NEW" : "OLD";
  return `CREATE TRIGGER season_guard_${table}_${event.toLowerCase()} BEFORE ${event} ON ${table}
    WHEN EXISTS (SELECT 1 FROM season_rollovers r JOIN guild_seasons s USING(guild_id,season)
      WHERE r.guild_id=${scope}.guild_id AND r.phase IN ('announced','posting')
      AND r.cutoff_at<=CAST(ROUND(unixepoch('subsec')*1000) AS INTEGER))
    BEGIN SELECT RAISE(ABORT,'The next season is starting. Please try again shortly.'); END;`;
}

function receiptTracking(table) {
  return `CREATE TRIGGER season_stamp_${table} AFTER INSERT ON ${table}
    BEGIN
      INSERT OR IGNORE INTO guild_seasons(guild_id,season,started_at)
        VALUES(NEW.guild_id,1,CAST(ROUND(unixepoch('subsec')*1000) AS INTEGER));
      DELETE FROM season_receipts WHERE kind='${table}' AND record_key=${seasonReceiptKey(table, "NEW")};
      INSERT INTO season_receipts(kind,record_key,guild_id,season)
        SELECT '${table}',${seasonReceiptKey(table, "NEW")},guild_id,season FROM guild_seasons
        WHERE guild_id=NEW.guild_id AND season>0;
    END;
    CREATE TRIGGER season_forget_${table} AFTER DELETE ON ${table}
    BEGIN DELETE FROM season_receipts WHERE kind='${table}' AND record_key=${seasonReceiptKey(table, "OLD")}; END;
    CREATE VIEW season_current_${table} AS SELECT payload.rowid AS rowid, payload.* FROM ${table} payload
      LEFT JOIN guild_seasons s ON s.guild_id=payload.guild_id
      LEFT JOIN season_receipts stored ON stored.kind='${table}' AND stored.record_key=${seasonReceiptKey(table, "payload")}
      WHERE COALESCE(stored.season,0)=COALESCE(s.season,0)
        AND NOT EXISTS (SELECT 1 FROM season_rollovers r WHERE r.guild_id=payload.guild_id
          AND r.season=s.season AND r.phase IN ('announced','posting')
          AND r.cutoff_at<=CAST(ROUND(unixepoch('subsec')*1000) AS INTEGER));`;
}

export const SEASON_AFFECTION_AWARD_DDL = [
  receiptTracking("affection_awards"),
  ...["INSERT", "UPDATE", "DELETE"].map((event) =>
    guardTable("affection_awards", event),
  ),
].join("\n");

export const SEASON_DDL = `CREATE TABLE season_schema (
  version INTEGER PRIMARY KEY CHECK(version = 1)
) STRICT;
CREATE TABLE guild_seasons (
  guild_id TEXT PRIMARY KEY NOT NULL,
  season INTEGER NOT NULL CHECK(season >= 0),
  started_at INTEGER,
  CHECK(season = 0 OR started_at IS NOT NULL)
) STRICT;
CREATE TABLE guild_season_settings (
  guild_id TEXT PRIMARY KEY NOT NULL,
  channel_id TEXT,
  target_days INTEGER NOT NULL DEFAULT 30 CHECK(target_days > 0),
  revision INTEGER NOT NULL DEFAULT 0,
  channel_checked_at INTEGER,
  channel_error TEXT
) STRICT;
CREATE TABLE season_players (
  guild_id TEXT NOT NULL,
  season INTEGER NOT NULL CHECK(season >= 0),
  user_id TEXT NOT NULL,
  PRIMARY KEY(guild_id, season, user_id)
) STRICT;
CREATE TABLE season_rollovers (
  guild_id TEXT NOT NULL,
  season INTEGER NOT NULL CHECK(season >= 0),
  revision INTEGER NOT NULL CHECK(revision > 0),
  phase TEXT NOT NULL CHECK(phase IN ('queued','posting','announced','applied','canceled')),
  channel_id TEXT NOT NULL,
  reminder_at INTEGER NOT NULL,
  cutoff_at INTEGER NOT NULL CHECK(cutoff_at > reminder_at),
  requester TEXT NOT NULL,
  announced_at INTEGER,
  completed_at INTEGER,
  pruned_at INTEGER,
  last_error TEXT,
  PRIMARY KEY(guild_id, season)
) STRICT;
CREATE INDEX season_rollovers_due ON season_rollovers(phase, reminder_at, cutoff_at);
CREATE TABLE season_messages (
  guild_id TEXT NOT NULL,
  season INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('reminder','ping','start')),
  part INTEGER NOT NULL DEFAULT 0 CHECK(part >= 0),
  channel_id TEXT NOT NULL,
  users_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(users_json)),
  nonce TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','sent')),
  message_id TEXT,
  content TEXT,
  attempted_at INTEGER,
  retry_at INTEGER,
  search_before TEXT,
  last_error TEXT,
  PRIMARY KEY(guild_id, season, revision, kind, part),
  FOREIGN KEY(guild_id, season) REFERENCES season_rollovers(guild_id, season)
) STRICT;
CREATE TABLE season_soulmate_waivers (
  guild_id TEXT NOT NULL,
  season INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY(guild_id, season, user_id)
) STRICT;
CREATE TABLE season_profiles (
  guild_id TEXT NOT NULL,
  season INTEGER NOT NULL CHECK(season >= 0),
  user_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  summary_json TEXT NOT NULL CHECK(json_valid(summary_json)),
  PRIMARY KEY(guild_id, season, user_id)
) STRICT;
CREATE INDEX season_profiles_player ON season_profiles(guild_id, user_id, season DESC);
CREATE TABLE season_receipts (
  kind TEXT NOT NULL,
  record_key TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  season INTEGER NOT NULL CHECK(season>0),
  PRIMARY KEY(kind,record_key)
) STRICT;
CREATE INDEX season_receipts_guild ON season_receipts(guild_id,season,kind,record_key);
${SEASON_RECEIPT_TABLES.map(receiptTracking).join("\n")}
${Object.entries(participants)
  .map(([table, user]) => enrolPlayer(table, "INSERT", user))
  .join("\n")}
${enrolPlayer("marriages", "UPDATE", participants.marriages)}
${guardedTables.flatMap((table) => ["INSERT", "UPDATE", "DELETE"].map((event) => guardTable(table, event))).join("\n")}`;

export function hasSeasonSchema(db) {
  return (
    typeof db?.prepare === "function" &&
    Boolean(
      db
        .prepare(
          "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='season_schema'",
        )
        .get(),
    )
  );
}

export function currentSeasonRows(db, table) {
  return hasSeasonSchema(db) ? `season_current_${table}` : table;
}

export function installSeasonSchema(db) {
  db.exec(SEASON_DDL);
  db.exec(`
    INSERT INTO season_schema VALUES (1);
    INSERT INTO season_players (guild_id, season, user_id)
      SELECT DISTINCT guild_id, 0, user_id FROM (
        SELECT guild_id, owner_id AS user_id FROM marriages
        UNION ALL SELECT guild_id, former_owner_id FROM character_ownership_losses
        UNION ALL SELECT guild_id, user_id FROM roll_allowances
        UNION ALL SELECT guild_id, user_id FROM claim_allowances
        UNION ALL SELECT guild_id, user_id FROM claim_events
        UNION ALL SELECT guild_id, user_id FROM daily_roll_claims
        UNION ALL SELECT guild_id, user_id FROM character_wishes
        UNION ALL SELECT guild_id, user_id FROM character_affection
        UNION ALL SELECT guild_id, user_id FROM player_soulmates
        UNION ALL SELECT guild_id, user_id FROM affection_contexts
        UNION ALL SELECT guild_id, user_id FROM user_inventory
        UNION ALL SELECT guild_id, user_id FROM user_inventory_limits
        UNION ALL SELECT guild_id, user_id FROM active_user_buffs
        UNION ALL SELECT guild_id, user_id FROM vault_rewards
        UNION ALL SELECT guild_id, roller_id FROM mystery_sessions
        UNION ALL SELECT guild_id, actor_id FROM item_actions
      ) WHERE length(guild_id) > 0 AND length(user_id) > 0;
    INSERT INTO guild_seasons(guild_id, season)
      SELECT DISTINCT guild_id, 0 FROM season_players;
  `);
}
