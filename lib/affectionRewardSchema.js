/** Additive feature DDL; installed only by the authoritative affection schema. */
export const AFFECTION_REWARD_DDL = `CREATE TABLE reward_grants (
  source_key TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK(source_type IN ('vault','mystery_consolation','affection_milestone')),
  parent_reward_id TEXT NOT NULL UNIQUE,
  original_outcome_json TEXT NOT NULL CHECK(json_valid(original_outcome_json)),
  pre_perk_outcome_json TEXT CHECK(pre_perk_outcome_json IS NULL OR json_valid(pre_perk_outcome_json)),
  final_outcome_json TEXT CHECK(final_outcome_json IS NULL OR json_valid(final_outcome_json)),
  benefits_json TEXT NOT NULL CHECK(json_valid(benefits_json)),
  pools_json TEXT NOT NULL CHECK(json_valid(pools_json)),
  decision_json TEXT CHECK(decision_json IS NULL OR json_valid(decision_json)),
  captured_at INTEGER NOT NULL CHECK(captured_at>=0),
  finalized_at INTEGER CHECK(finalized_at IS NULL OR finalized_at>=captured_at),
  state TEXT NOT NULL CHECK(state IN ('captured','finalized','lost'))
);
CREATE TABLE reward_copies (
  copy_id TEXT PRIMARY KEY,
  source_key TEXT NOT NULL REFERENCES reward_grants(source_key),
  ordinal INTEGER NOT NULL CHECK(ordinal IN (0,1)),
  reward_id TEXT NOT NULL UNIQUE,
  outcome_json TEXT NOT NULL CHECK(json_valid(outcome_json)),
  state TEXT NOT NULL CHECK(state IN ('selected','overflow','delivered','declined')),
  inventory_id INTEGER,
  acquired_at INTEGER,
  expires_at INTEGER,
  settled_at INTEGER,
  UNIQUE(source_key,ordinal),
  CHECK((state='delivered' AND inventory_id IS NOT NULL AND acquired_at IS NOT NULL AND expires_at>acquired_at AND settled_at IS NOT NULL)
    OR (state!='delivered' AND inventory_id IS NULL AND acquired_at IS NULL AND expires_at IS NULL))
);
CREATE INDEX reward_copies_pending ON reward_copies(state,reward_id);
CREATE TABLE reward_use_costs (
  source_key TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  inventory_id INTEGER NOT NULL,
  chance REAL NOT NULL CHECK(chance>=0 AND chance<=1),
  actual_debit INTEGER NOT NULL CHECK(actual_debit IN (0,1)),
  refunded INTEGER NOT NULL DEFAULT 0 CHECK(refunded IN (0,1)),
  created_at INTEGER NOT NULL CHECK(created_at>=0)
);
`;
