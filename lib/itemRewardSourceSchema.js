export const ITEM_REWARD_SOURCE_DDL = `CREATE TABLE item_reward_source_schema (
  version INTEGER PRIMARY KEY CHECK(version=1)
);
INSERT INTO item_reward_source_schema VALUES(1);
CREATE TABLE reward_sources (
  reward_id TEXT PRIMARY KEY REFERENCES vault_rewards(vault_id),
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  UNIQUE(source_kind,source_id)
);
`;
