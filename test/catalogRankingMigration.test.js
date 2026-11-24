import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { installEmptyFinalCatalog as installPredecessor, validateFinalCatalogSchema as validatePredecessor } from '../lib/catalogPreRankingSchema.js';
import { validateFinalCatalogSchema } from '../lib/catalogFinalSchema.js';
import { migrateCharacterRanking } from '../lib/catalogRankingMigration.js';
const ids = [1, 2].map(n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
function fixture() {
  const db = new DatabaseSync(':memory:');
  installPredecessor(db); db.exec('PRAGMA foreign_keys=ON');
  for (let i = 0; i < 2; i++) {
    db.prepare("INSERT INTO character_identities(id,creation_method) VALUES(?,'manual')").run(ids[i]);
    db.prepare("INSERT INTO characters(id,rank,favourites,tie_order,likes_source) VALUES(?,?,0,?,'generated')").run(ids[i], i + 1, i + 1);
  }
  return db;
}
const inputs = { hashes: { danbooru: 'a'.repeat(64), mudae: 'b'.repeat(64) }, records: [
  { id: ids[0], tag: null, danbooru_post_count: null, mudae_claim_rank: null, mudae_character_url: null },
  { id: ids[1], tag: 'series', danbooru_post_count: 149200, mudae_claim_rank: 1, mudae_character_url: 'https://mudae.net/character/1/a' },
] };
test('ranking cutover rehearses without changes then atomically archives old positions and imports the snapshot', () => {
  const db = fixture();
  try {
    assert.throws(() => validateFinalCatalogSchema(db), /migration required/);
    assert.equal(migrateCharacterRanking(db, { inputs, actor: 'operator', now: 1000 }).committed, false);
    assert.equal(validatePredecessor(db, { readOnly: false }), true);
    const result = migrateCharacterRanking(db, { inputs, actor: 'operator', now: 1000, dryRun: false });
    assert.equal(result.committed, true);
    assert.deepEqual(db.prepare('SELECT id,legacy_rank,rank,efficiency FROM characters ORDER BY rank').all().map(r => ({ ...r })), [
      { id: ids[1], legacy_rank: 2, rank: 1, efficiency: 2 }, { id: ids[0], legacy_rank: 1, rank: 2, efficiency: 0 },
    ]);
    assert.equal(db.prepare('SELECT status FROM tag_decisions WHERE character_id=?').get(ids[0]).status, 'no_match');
    assert.deepEqual(db.prepare('SELECT main_franchise_id FROM characters ORDER BY rank').all().map(row => row.main_franchise_id), [null, null]);
    assert.equal(validateFinalCatalogSchema(db, { readOnly: false }), true);
    assert.throws(() => validatePredecessor(db), /schema/);
    assert.equal(migrateCharacterRanking(db, { inputs, actor: 'operator', now: 2000, dryRun: false }).noOp, true);
    assert.equal(db.prepare('SELECT count(*) n FROM catalog_mutations').get().n, 1);
    assert.throws(() => db.exec('UPDATE characters SET legacy_rank=3'), /immutable/);
    db.exec('DROP INDEX characters_by_main_franchise; ALTER TABLE characters DROP COLUMN main_franchise_id;');
    assert.equal(migrateCharacterRanking(db, { inputs, actor: 'operator', now: 3000, dryRun: false }).noOp, true);
    assert.equal(validateFinalCatalogSchema(db, { readOnly: false, mainFranchise: false }), true);
  } finally { db.close(); }
});
test('cutover changes only eligibility fields and rolls back malformed targeted buffs', () => {
  const db = fixture();
  try {
    db.exec(`INSERT INTO game_config_overrides VALUES('1','itemEffects.rolling_fever.favouritesThreshold','9000');
      INSERT INTO active_user_buffs(guild_id,user_id,buff_id,data_json,remaining_rolls,starts_at,expires_at)
      VALUES('1','2','rolling_fever','{"rolls":10,"favouritesThreshold":9000,"refundRolls":2}',7,100,9000);`);
    const before = { ...db.prepare('SELECT * FROM active_user_buffs').get() };
    migrateCharacterRanking(db, { inputs, actor: 'operator', now: 1000, dryRun: false });
    const after = { ...db.prepare('SELECT * FROM active_user_buffs').get() };
    assert.deepEqual({ ...after, data_json: before.data_json }, before);
    assert.deepEqual(JSON.parse(after.data_json), { rolls: 10, refundRolls: 2, maxRank: 1500 });
    assert.equal(db.prepare("SELECT value_json FROM game_config_overrides WHERE scope_id='1' AND key='itemEffects.rolling_fever.maxRank'").get().value_json, '1500');
  } finally { db.close(); }
  const malformed = fixture();
  try {
    malformed.exec("INSERT INTO active_user_buffs(guild_id,user_id,buff_id,data_json) VALUES('1','2','pinata','bad')");
    assert.throws(() => migrateCharacterRanking(malformed, { inputs, actor: 'operator', dryRun: false }), /buff/);
    assert.equal(validatePredecessor(malformed, { readOnly: false }), true);
  } finally { malformed.close(); }
});

test('legacy NULL buff snapshots retain benefits and cutover reports tag changes after rollback', () => {
  const db = fixture();
  try {
    db.exec(`INSERT INTO active_user_buffs(guild_id,user_id,buff_id,data_json,remaining_rolls,starts_at,expires_at)
      VALUES('1','2','pinata',NULL,4,100,9000)`);
    db.prepare("INSERT INTO tag_decisions VALUES(?,'approve','original_tag','manual','test')").run(ids[0]);
    const before = { ...db.prepare('SELECT * FROM active_user_buffs').get() };
    const rehearsed = migrateCharacterRanking(db, { inputs, actor: 'operator', now: 1000 });
    assert.equal(rehearsed.changes.find(row => row.id === ids[0]).before.tag, 'original_tag');
    assert.equal(rehearsed.changes.find(row => row.id === ids[0]).after.tag, null);
    assert.deepEqual(rehearsed.preservation.before, rehearsed.preservation.after);
    assert.equal(rehearsed.preservation.before.character_identities.count, 2);
    assert.deepEqual({ ...db.prepare('SELECT * FROM active_user_buffs').get() }, before);
    assert.equal(validatePredecessor(db), true);
    migrateCharacterRanking(db, { inputs, actor: 'operator', now: 1000, dryRun: false });
    const after = { ...db.prepare('SELECT * FROM active_user_buffs').get() };
    assert.deepEqual({ ...after, data_json: before.data_json }, before);
    assert.deepEqual(JSON.parse(after.data_json), { maxRank: 1500 });
    const audit = db.prepare('SELECT before_json,after_json FROM catalog_mutations').get();
    assert.equal(JSON.parse(audit.before_json).tags[0].tag_name, 'original_tag');
    assert.equal(JSON.parse(audit.after_json).tags.find(row => row.character_id === ids[0]).status, 'no_match');
  } finally { db.close(); }
});

test('late cutover failure restores the exact predecessor and an identical retry never resets live settings', () => {
  const db = fixture();
  const snapshot = () => ({ schema: db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all(),
    characters: db.prepare('SELECT * FROM characters ORDER BY id').all(), meta: db.prepare('SELECT * FROM catalog_meta ORDER BY key').all(),
    rules: db.prepare('SELECT * FROM game_config_overrides ORDER BY scope_id,key').all() });
  try {
    const before = snapshot();
    assert.throws(() => migrateCharacterRanking(db, { inputs, actor: 'operator', dryRun: false,
      beforeCommit() { throw new Error('injected late failure'); } }), /injected late failure/);
    assert.deepEqual(snapshot(), before);
    assert.equal(validatePredecessor(db), true);
    const first = migrateCharacterRanking(db, { inputs, actor: 'operator', dryRun: false });
    db.exec("UPDATE game_config_overrides SET value_json='700' WHERE key='itemEffects.pinata.maxRank'");
    const current = snapshot();
    const retry = migrateCharacterRanking(db, { inputs, actor: 'operator', dryRun: false });
    assert.equal(retry.noOp, true); assert.equal(retry.mutationId, first.mutationId);
    assert.deepEqual(snapshot(), current);
    assert.throws(() => migrateCharacterRanking(db, { inputs: { ...inputs, hashes: { ...inputs.hashes, mudae: 'c'.repeat(64) } }, actor: 'operator' }), /Different bootstrap inputs/);
  } finally { db.close(); }
});
