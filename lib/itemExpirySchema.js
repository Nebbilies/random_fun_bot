// Shared by runtime storage and the authoritative catalog schema. No runtime imports.
// SQLite requires a constant non-NULL default for additive ALTER on populated
// tables. 1 is fail-closed (already expired), never an acquisition lifetime;
// migration replaces it transactionally and shared insertion always stamps it.
export const INVENTORY_EXPIRY_COLUMN = `expires_at INTEGER NOT NULL DEFAULT 1 CHECK(typeof(expires_at) = 'integer' AND expires_at BETWEEN 1 AND 9007199254740991)`;
export const ITEM_EXPIRY_DDL = `CREATE TABLE item_expiry_schema (
  version INTEGER PRIMARY KEY CHECK(version=1),
  rollout_at INTEGER NOT NULL CHECK(typeof(rollout_at)='integer' AND rollout_at>=0)
);
CREATE TABLE item_use_reservations (
  action_id TEXT PRIMARY KEY REFERENCES item_actions(id) ON DELETE RESTRICT,
  inventory_id INTEGER NOT NULL UNIQUE REFERENCES user_inventory(id) ON DELETE RESTRICT,
  started_at INTEGER NOT NULL CHECK(typeof(started_at)='integer' AND started_at>=0)
);
CREATE INDEX user_inventory_live_idx ON user_inventory(guild_id, user_id, expires_at, id);
CREATE INDEX user_inventory_expiry_idx ON user_inventory(expires_at, id);
`;
