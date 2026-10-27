// Versioned final-catalog extension. Only explicit creation/conversion/offline upgrade installs it.
export const FORTUNE_DDL = `CREATE TABLE fortune_schema (
  version INTEGER PRIMARY KEY CHECK(version=1)
);
INSERT INTO fortune_schema VALUES(1);
CREATE TABLE fortune_holds (
  inventory_id INTEGER PRIMARY KEY REFERENCES user_inventory(id) ON DELETE RESTRICT,
  guild_id TEXT NOT NULL, user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('lens','recast')),
  reference_id TEXT NOT NULL UNIQUE
);
CREATE TABLE fortune_armed (
  guild_id TEXT NOT NULL, user_id TEXT NOT NULL,
  inventory_id INTEGER NOT NULL UNIQUE REFERENCES user_inventory(id) ON DELETE RESTRICT,
  armed_at INTEGER NOT NULL CHECK(armed_at>=0),
  PRIMARY KEY(guild_id,user_id)
);
CREATE TABLE fortune_lens (
  vault_id TEXT PRIMARY KEY REFERENCES vault_sessions(vault_id) ON DELETE RESTRICT,
  inventory_id INTEGER NOT NULL,
  candidates_json TEXT NOT NULL CHECK(json_valid(candidates_json) AND json_array_length(candidates_json)=3),
  state TEXT NOT NULL CHECK(state IN ('pending','presented','refunded')),
  created_at INTEGER NOT NULL CHECK(created_at>=0), presented_at INTEGER
);
CREATE TABLE fortune_recasts (
  vault_id TEXT PRIMARY KEY REFERENCES vault_rewards(vault_id) ON DELETE RESTRICT,
  guild_id TEXT NOT NULL, user_id TEXT NOT NULL,
  inventory_id INTEGER NOT NULL,
  original_json TEXT NOT NULL CHECK(json_valid(original_json)),
  alternatives_json TEXT NOT NULL CHECK(json_valid(alternatives_json) AND json_array_length(alternatives_json) BETWEEN 1 AND 3),
  duration_ms INTEGER NOT NULL CHECK(duration_ms>0),
  state TEXT NOT NULL CHECK(state IN ('pending','presented','chosen')),
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  presented_at INTEGER, deadline INTEGER, choice INTEGER CHECK(choice BETWEEN -1 AND 2),
  CHECK((state='pending' AND presented_at IS NULL AND deadline IS NULL AND choice IS NULL)
    OR (state='presented' AND presented_at IS NOT NULL AND deadline IS NOT NULL AND presented_at>=created_at AND deadline=presented_at+duration_ms AND choice IS NULL)
    OR (state='chosen' AND presented_at IS NOT NULL AND deadline IS NOT NULL AND presented_at>=created_at AND deadline=presented_at+duration_ms AND choice IS NOT NULL))
);
CREATE UNIQUE INDEX fortune_recasts_one_owner ON fortune_recasts(guild_id,user_id) WHERE state IN ('pending','presented');
`;
