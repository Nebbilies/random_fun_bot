// Authoritative durable runtime tables. Installed only by explicit final-schema
// creation/conversion, never by bot startup or individual runtime helpers.
export const ROLL_DELIVERY_DDL = `CREATE TABLE roll_delivery (
  roll_id INTEGER PRIMARY KEY REFERENCES character_rolls(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK(version = 1),
  roller_id TEXT NOT NULL,
  remaining INTEGER NOT NULL CHECK(remaining >= 0),
  logical_delivery_id TEXT NOT NULL UNIQUE,
  character_snapshot_json TEXT NOT NULL,
  presentation_json TEXT NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('reserved', 'acknowledged', 'bound')),
  message_id TEXT,
  acknowledged_at INTEGER,
  CHECK((phase = 'reserved' AND message_id IS NULL AND acknowledged_at IS NULL)
    OR (phase IN ('acknowledged', 'bound') AND message_id IS NOT NULL AND acknowledged_at IS NOT NULL))
);`;
export const VAULT_SESSIONS_DDL = `CREATE TABLE vault_sessions (
  vault_id TEXT PRIMARY KEY, command_message_id TEXT UNIQUE, paid_roll_id TEXT,
  guild_id TEXT NOT NULL, user_id TEXT NOT NULL, channel_id TEXT NOT NULL,
  remaining INTEGER NOT NULL CHECK(typeof(remaining)='integer' AND remaining >= 0),
  captured_json TEXT NOT NULL CHECK(CASE WHEN json_valid(captured_json) THEN json_type(captured_json)='object' ELSE 0 END),
  deadline INTEGER NOT NULL CHECK(typeof(deadline)='integer' AND deadline >= created_at),
  created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at >= 0),
  message_id TEXT, delivered_at INTEGER,
  state TEXT NOT NULL DEFAULT 'unopened' CHECK(state IN ('unopened','revealed','expired')),
  reward_id TEXT UNIQUE
);
CREATE INDEX vault_sessions_pending ON vault_sessions(state, deadline);
CREATE TRIGGER vault_sessions_reveal_link AFTER INSERT ON vault_rewards
BEGIN
  UPDATE vault_sessions SET state = 'revealed', reward_id = NEW.vault_id
  WHERE vault_id = NEW.vault_id;
END;`;
import { FORTUNE_DDL } from "./vaultFortuneSchema.js";
export const CATALOG_RUNTIME_DDL = `${ROLL_DELIVERY_DDL}\n${VAULT_SESSIONS_DDL}\n${FORTUNE_DDL}`;
