import { NORMAL_MILESTONES } from './affectionRules.js';
import { AFFECTION_REWARD_DDL } from './affectionRewardSchema.js';
import { validateSavedAffectionContext } from './affectionSnapshot.js';

// Public integration DDL contract. Permanent sources/awards/entitlements have NO
// deleting FK to rolls, inventory, marriages or delivery rows. No runtime CREATE.
const time = name => `${name} INTEGER NOT NULL CHECK(typeof(${name})='integer' AND ${name} BETWEEN 0 AND 9007199254740991)`;
const scope = `guild_id TEXT NOT NULL CHECK(length(trim(guild_id))>0), user_id TEXT NOT NULL CHECK(length(trim(user_id))>0)`;
const object = name => `${name} TEXT NOT NULL CHECK(CASE WHEN json_valid(${name}) THEN json_type(${name})='object' ELSE 0 END)`;
export const AFFECTION_AWARDS_DDL = `CREATE TABLE affection_awards (
  source_key TEXT NOT NULL, ${scope}, character_id TEXT NOT NULL REFERENCES character_identities(id),
  base INTEGER NOT NULL CHECK(base IN (1,5,8,10,12,20,100)),
  amount INTEGER NOT NULL CHECK(typeof(amount)='integer' AND amount BETWEEN 0 AND 200),
  total INTEGER NOT NULL CHECK(typeof(total)='integer' AND total BETWEEN 0 AND 2100),
  milestones_json TEXT NOT NULL CHECK(json_valid(milestones_json) AND json_type(milestones_json)='array'),
  ${time('created_at')}, PRIMARY KEY(source_key,guild_id,user_id,character_id)
);`;
export const AFFECTION_DDL = `CREATE TABLE affection_schema (
  version INTEGER PRIMARY KEY CHECK(version=1), capture_version INTEGER NOT NULL CHECK(capture_version=1),
  ${time('activated_at')}
);
CREATE TABLE character_affection (
  ${scope}, character_id TEXT NOT NULL REFERENCES character_identities(id),
  total INTEGER NOT NULL CHECK(typeof(total)='integer' AND total BETWEEN 0 AND 2100), ${time('updated_at')},
  PRIMARY KEY(guild_id,user_id,character_id)
);
CREATE TABLE player_soulmates (
  ${scope}, character_id TEXT REFERENCES character_identities(id),
  selected_at INTEGER, ${time('switch_available_at')},
  revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY(guild_id,user_id),
  CHECK(selected_at IS NULL OR (typeof(selected_at)='integer' AND selected_at BETWEEN 0 AND 9007199254740991))
);
CREATE INDEX player_soulmates_character ON player_soulmates(guild_id,character_id,user_id);
CREATE TABLE affection_requests (
  source_key TEXT PRIMARY KEY, ${scope}, channel_id TEXT NOT NULL,
  ${object('outcome_json')}, ${time('created_at')}
);
CREATE TABLE affection_invocations (
  invocation_id TEXT PRIMARY KEY, ${scope}, channel_id TEXT NOT NULL, kind TEXT NOT NULL,
  ${object('result_json')}, ${time('created_at')}
);
CREATE TABLE affection_contexts (
  source_key TEXT PRIMARY KEY, ${scope}, channel_id TEXT NOT NULL,
  character_id TEXT NOT NULL REFERENCES character_identities(id),
  capture_version INTEGER NOT NULL CHECK(capture_version=1), ${object('snapshot_json')},
  state TEXT NOT NULL CHECK(state IN ('captured','completed','canceled')),
  ${time('created_at')}, completed_at INTEGER,
  CHECK((state='captured' AND completed_at IS NULL) OR (state!='captured' AND typeof(completed_at)='integer' AND completed_at BETWEEN created_at AND 9007199254740991))
);
CREATE INDEX affection_contexts_pending ON affection_contexts(state,created_at);
${AFFECTION_AWARDS_DDL}
CREATE TABLE affection_decisions (
  source_key TEXT NOT NULL, ${scope}, effect TEXT NOT NULL CHECK(effect IN
    ('windfall','item_conservation','unbroken_bond','claim_conservation','fortunes_favor','negation','echo')),
  ordinal INTEGER NOT NULL DEFAULT 0 CHECK(typeof(ordinal)='integer' AND ordinal>=0),
  chance REAL NOT NULL CHECK(chance>=0 AND chance<=1), triggered INTEGER NOT NULL CHECK(triggered IN (0,1)),
  ${time('created_at')}, PRIMARY KEY(source_key,guild_id,user_id,effect,ordinal)
);
CREATE TABLE affection_entitlements (
  source_key TEXT NOT NULL, ${scope}, character_id TEXT NOT NULL REFERENCES character_identities(id),
  milestone_key TEXT NOT NULL, threshold INTEGER NOT NULL CHECK(typeof(threshold)='integer' AND threshold BETWEEN 1 AND 2100),
  tier TEXT CHECK(tier IN ('common','rare','epic','legendary')), item_id TEXT,
  outcome_json TEXT CHECK(outcome_json IS NULL OR (json_valid(outcome_json) AND json_type(outcome_json)='object')),
  reward_id TEXT UNIQUE, state TEXT NOT NULL CHECK(state IN ('owed','selected','delivered','declined')),
  ${time('earned_at')}, channel_id TEXT NOT NULL,
  PRIMARY KEY(guild_id,user_id,character_id,milestone_key),
  CHECK((state='owed' AND outcome_json IS NULL AND reward_id IS NULL) OR (state!='owed' AND outcome_json IS NOT NULL AND reward_id IS NOT NULL)),
  CHECK(tier IS NOT NULL OR item_id IS NOT NULL)
);
CREATE INDEX affection_entitlements_pending ON affection_entitlements(guild_id,user_id,state,earned_at);
CREATE TABLE affection_legacy_sources (
  kind TEXT NOT NULL, source_key TEXT NOT NULL, ${time('recorded_at')}, PRIMARY KEY(kind,source_key)
);
${['DELETE','UPDATE'].map(event=>`CREATE TRIGGER marriages_affection_${event.toLowerCase()} AFTER ${event} ON marriages
${event==='UPDATE'?'WHEN OLD.guild_id IS NOT NEW.guild_id OR OLD.owner_id IS NOT NEW.owner_id OR OLD.character_id IS NOT NEW.character_id':''}
BEGIN
  UPDATE player_soulmates SET character_id=NULL, revision=revision+1
  WHERE guild_id=OLD.guild_id AND user_id=OLD.owner_id AND character_id=OLD.character_id;
END;`).join('\n')}
${AFFECTION_REWARD_DDL}`;

/** Lifecycle-only activation: positive legacy evidence, never eligibility backfill.
 * All existing rows (including terminal records) are inventoried before new ingress.
 * Missing capture without a matching entry must NOT be treated as legacy.
 */
export function activateAffectionSchema(db, now = Date.now()) {
  db.prepare('INSERT INTO affection_schema VALUES(1,1,?)').run(now);
  for (const [table,key,kind] of [
    ['character_rolls','command_message_id','roll'], ['character_rolls','id','roll_id'],
    ['mystery_sessions','id','mystery'], ['vault_sessions','vault_id','vault'],
    ['vault_rewards','vault_id','reward'], ['item_actions','id','item_action'],
    ['fortune_lens','vault_id','fortune_lens'], ['fortune_recasts','vault_id','fortune_recast'],
  ]) db.prepare(`INSERT INTO affection_legacy_sources(kind,source_key,recorded_at)
      SELECT ?,CAST(${key} AS TEXT),? FROM ${table}`).run(kind,now);
}
export function isLegacyAffectionSource(db, kind, sourceKey) {
  return Boolean(db.prepare('SELECT 1 FROM affection_legacy_sources WHERE kind=? AND source_key=?').get(kind,String(sourceKey)));
}
export function validateAffectionState(db) {
  if (db.prepare('SELECT count(*) n FROM affection_schema').get().n!==1
    || !db.prepare('SELECT 1 FROM affection_schema WHERE version=1 AND capture_version=1').get()) throw new Error('Invalid affection_schema version');
  // JSON shape/scope checks beyond syntactic SQL constraints; never repair or draw.
  for (const row of db.prepare('SELECT * FROM affection_contexts').iterate()) {
    const snapshot=validateSavedAffectionContext(row);
    const ids=new Set([row.character_id,snapshot.soulmate?.characterId].filter(Boolean));
    for (const id of ids) if (!db.prepare('SELECT 1 FROM character_identities WHERE id=?').get(id)) {
      throw new Error('Invalid affection context snapshot identity; inspect before startup');
    }
  }
  for (const row of db.prepare('SELECT * FROM affection_entitlements').iterate()) {
    const milestone=NORMAL_MILESTONES.find(m=>m.key===row.milestone_key);
    if (!milestone || milestone.threshold!==row.threshold || !(milestone.itemId || milestone.tier)
      || (milestone.itemId && milestone.itemId!==row.item_id)
      || (milestone.tier && milestone.tier!==row.tier)) throw new Error('Invalid affection entitlement milestone');
    if (row.outcome_json===null) continue;
    const outcome=JSON.parse(row.outcome_json);
    if (!outcome.item || typeof outcome.item.id!=='string' || outcome.item.id!==row.item_id
      || outcome.item.tier!==outcome.tier || !['common','rare','epic','legendary','unique'].includes(outcome.tier)
      || (row.tier && row.tier!==outcome.tier)
      || !Number.isSafeInteger(outcome.item.maxCharges) || outcome.item.maxCharges<1
      || outcome.item.startingCharges!==outcome.item.maxCharges) throw new Error('Invalid affection entitlement outcome');
  }
}
