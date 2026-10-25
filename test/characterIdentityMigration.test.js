import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { openCatalog } from '../lib/catalogDb.js';
import { CHARACTER_REFERENCES, inventoryCharacterIdentities, migrateCharacterIdentities,
  createIdentityMapping, STAGING_TABLES, RESET_META_KEYS } from '../lib/characterIdentityMigration.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'identity-migration-'));
  const path = join(directory, 'rehearsal.sqlite');
  const db = openCatalog(path); // Always explicit, synthetic temporary DB; never production.
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  db.exec(`INSERT INTO characters(id,rank,favourites,name_full) VALUES(12,1,50,'First'),(3,2,50,'Second');
    INSERT INTO character_identities VALUES(12,'First','portrait'),(3,'Second',NULL),(99,'Retained',NULL);
    INSERT INTO marriages VALUES(501,'guild',99,'owner','date');
    INSERT INTO character_anime VALUES(12,777);
    INSERT INTO anime(id,title_romaji,fetched_at) VALUES(777,'Anime','date');
    INSERT INTO franchises VALUES(42,'Franchise','automatic','date');
    INSERT INTO franchise_anime VALUES(42,777,'automatic');
    INSERT INTO franchise_aliases VALUES(42,'Alias','alias','manual');
    INSERT INTO franchise_membership_overrides VALUES(777,42,'date');
    INSERT INTO character_rolls(id,guild_id,channel_id,command_message_id,character_id,character_name,state,escape_marriage_id)
      VALUES(601,'guild','channel','cmd',99,'Retained','closed',501),
      (602,'guild','channel','prank',0,'Prank','prank',NULL),
      (603,'guild','channel','vault',0,'Vault','vault',NULL);
    INSERT INTO mystery_sessions(id,guild_id,origin_roll_id,event_id,character_id,rank_snapshot,roller_id,
      event_channel_id,state,state_json,started_at,deadline_at)
      VALUES(701,'guild',601,'event',12,1,'roller','channel','completed',NULL,1,2);
    INSERT INTO tag_candidates VALUES(99,'tag',15,'reason');
    INSERT INTO tag_match_progress VALUES(99,'date');
    INSERT INTO tag_decisions VALUES(99,'approve','tag','manual','date');
    INSERT INTO character_tag_reports VALUES(801,99,'reporter','date',NULL,NULL);
    INSERT INTO duckduckgo_tag_attempts VALUES(12,'query',NULL,NULL,'approve','tag','details','date');
    INSERT INTO character_wishes VALUES('guild','wisher',99,123);
    INSERT INTO counterfeit_crowns VALUES('guild','owner',99,501,'generation');
    INSERT INTO character_protection_locks VALUES('guild',99,'soulbound',NULL);
    INSERT INTO item_actions(id,kind,guild_id,actor_id,channel_id,inventory_id,state,selections_json,created_at,expires_at)
      VALUES('action','counterfeit_crown','guild','owner','channel',901,'resolved','{}',1,2);
    INSERT INTO active_user_buffs(guild_id,user_id,buff_id,data_json) VALUES('guild','owner','buff','{}');
    INSERT INTO user_inventory VALUES(901,'guild','owner','item',3,'date');
    INSERT INTO stage_characters(id,favourites) VALUES(1001,999);
    INSERT INTO stage_anime(id,fetched_at) VALUES(1002,'date');
    INSERT INTO stage_character_anime VALUES(1001,1002);
    INSERT INTO stage_anime_relations VALUES(1002,1003,'SEQUEL');
    INSERT INTO catalog_meta VALUES('published_at','published'),('franchise_published_at','published');`);
  for (const key of RESET_META_KEYS) db.prepare('INSERT INTO catalog_meta VALUES(?,?)').run(key, 'incomplete');
  return { db, path };
}
function snapshot(db) {
  const names = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(r => r.name);
  return { schema: db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all(),
    data: names.map(name => [name, db.prepare(`SELECT * FROM "${name}"`).all()]),
    version: db.prepare('PRAGMA user_version').get() };
}

test('preflight inventories all current legacy reference tables and retained identities', t => {
  const { db } = fixture(t);
  const report = inventoryCharacterIdentities(db);
  assert.deepEqual(report.blockers, []);
  assert.deepEqual(report.identities, [3, 12, 99]);
  assert.equal(report.sentinels, 2);
  for (const table of Object.keys(CHARACTER_REFERENCES)) assert.ok(table in report.counts, table);
});

test('rollback-only rehearsal leaves exact schema, data, FK mode and cursors intact', t => {
  const { db } = fixture(t);
  const before = snapshot(db);
  const report = migrateCharacterIdentities(db);
  assert.equal(report.committed, false);
  assert.equal(report.retainedOnly, 1);
  assert.deepEqual(snapshot(db), before);
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
});

test('coordinated primitive preserves references, tags, numeric OTHER IDs, ties and published anime/franchises', t => {
  const { db } = fixture(t);
  // High-water mark above existing rows must not be lost by table rebuild.
  db.exec("UPDATE sqlite_sequence SET seq=9999 WHERE name='marriages'");
  const excluded = new Set([...Object.keys(CHARACTER_REFERENCES), ...STAGING_TABLES, 'catalog_meta', 'sqlite_sequence']);
  const others = new Map(snapshot(db).data.filter(([table]) => !excluded.has(table)));
  const report = migrateCharacterIdentities(db, { dryRun: false, targetVersion: 11 });
  assert.equal(report.committed, true);
  const mapping = new Map(db.prepare('SELECT * FROM character_identity_migration').all().map(r => [r.legacy_id, r.character_id]));
  assert.equal(mapping.size, 3);
  for (const [table, column] of Object.entries(CHARACTER_REFERENCES)) {
    const type = db.prepare(`PRAGMA table_info(${table})`).all().find(c => c.name === column).type;
    assert.equal(type, 'TEXT', table);
    for (const row of db.prepare(`SELECT * FROM ${table}`).all()) {
      if (table === 'character_rolls' && ['vault', 'prank'].includes(row.state)) assert.equal(row[column], '0');
      else assert.ok([...mapping.values()].includes(row[column]), table);
    }
  }
  assert.deepEqual(db.prepare('SELECT rank,favourites,tie_order,id,likes_source FROM characters ORDER BY tie_order').all().map(r => ({ ...r })), [
    { rank: 1, favourites: 50, tie_order: 1, id: mapping.get(12), likes_source: 'anilist' },
    { rank: 2, favourites: 50, tie_order: 2, id: mapping.get(3), likes_source: 'anilist' },
  ]);
  assert.deepEqual(db.prepare('SELECT creation_method FROM character_identities').all().map(r => r.creation_method), ['imported', 'imported', 'imported']);
  assert.equal(db.prepare('SELECT character_id FROM character_wishes').get().character_id, mapping.get(99));
  assert.equal(db.prepare('SELECT source FROM tag_decisions').get().source, 'manual');
  assert.equal(db.prepare('SELECT count(*) AS n FROM duckduckgo_tag_attempts').get().n, 1);
  assert.equal(db.prepare('SELECT id FROM marriages').get().id, 501);
  assert.equal(db.prepare("SELECT seq FROM sqlite_sequence WHERE name='marriages'").get().seq, 9999);
  assert.equal(db.prepare('SELECT escape_marriage_id FROM character_rolls WHERE id=601').get().escape_marriage_id, 501);
  assert.equal(db.prepare('SELECT origin_roll_id FROM mystery_sessions').get().origin_roll_id, 601);
  assert.equal(db.prepare('SELECT anime_id FROM character_anime').get().anime_id, 777);
  for (const [table, data] of others) assert.deepEqual(db.prepare(`SELECT * FROM ${table}`).all(), data, table);
  for (const table of STAGING_TABLES) assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0);
  for (const key of RESET_META_KEYS) assert.equal(db.prepare('SELECT * FROM catalog_meta WHERE key=?').get(key), undefined);
  assert.equal(db.prepare("SELECT value FROM catalog_meta WHERE key='published_at'").get().value, 'published');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 11);
  assert.throws(() => migrateCharacterIdentities(db), /preflight refused/);
});

test('failure after first table rebuild rolls back all DDL/data', t => {
  const { db } = fixture(t);
  // An unsupported identity DDL is encountered after characters has been rebuilt.
  db.exec('DROP TABLE character_identities; CREATE TABLE character_identities(id INT PRIMARY KEY,name_full TEXT,image_url TEXT); INSERT INTO character_identities VALUES(12,NULL,NULL),(3,NULL,NULL),(99,NULL,NULL);');
  const before = snapshot(db);
  assert.throws(() => migrateCharacterIdentities(db), /Unsupported DDL/);
  assert.deepEqual(snapshot(db), before);
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
});

for (const [label, sql, reason] of [
  ['orphan', "INSERT INTO character_wishes VALUES('g','u',404,1)", /Unresolved reference/],
  ['zero on character roll', "UPDATE character_rolls SET character_id=0 WHERE id=601", /Unresolved reference/],
  ['zero identity', "INSERT INTO character_identities VALUES(0,'Bad',NULL)", /invalid legacy identity/],
  ['unknown column', 'CREATE TABLE future_refs(target_character_id INTEGER);', /Unclassified reference/],
  ['unknown JSON', 'CREATE TABLE future_snapshots(payload_json TEXT);', /Unclassified JSON/],
  ['invalid likes', 'UPDATE characters SET favourites=-1 WHERE id=12', /Invalid likes/],
  ['vault decision', `INSERT INTO vault_rewards(vault_id,guild_id,user_id,channel_id,original_json,state,created_at) VALUES('vault','g','u','c','{}','decision',1)`, /Live vault_rewards/],
  ['unknown FK', 'CREATE TABLE future_refs(target INTEGER REFERENCES characters(id));', /Unclassified foreign reference/],
  ['pending roll', "UPDATE character_rolls SET state='pending' WHERE id=601", /Live character_rolls/],
  ['mystery', "UPDATE mystery_sessions SET state='running'", /Live mystery_sessions/],
  ['hostage', "UPDATE item_actions SET state='awaiting_delivery'", /Live item_actions/],
  ['reservation', "INSERT INTO item_character_reservations VALUES('guild',99,'action','owner',501)", /reservations\/escrow/],
  ['escrow', "INSERT INTO item_action_costs VALUES('action',901,'{}')", /reservations\/escrow/],
  ['pending delivery', "UPDATE item_actions SET delivery_pending=1", /Live item_actions/],
  ['selection snapshot', `UPDATE item_actions SET selections_json='{"own":{"characterId":99,"marriageId":501}}'`, /shape-specific/],
  ['result snapshot', `UPDATE item_actions SET result_json='{"characters":[{"characterId":99}]}'`, /shape-specific/],
  ['crown snapshot', `UPDATE item_actions SET crown_json='[{"character_id":99}]'`, /shape-specific/],
  ['mystery snapshot', `UPDATE mystery_sessions SET state_json='{"animeId":777}'`, /shape-specific/],
  ['buff snapshot', `UPDATE active_user_buffs SET data_json='{"franchiseId":42}'`, /shape-specific/],
  ['invalid JSON', "UPDATE item_actions SET selections_json='broken'", /Invalid JSON/],
  ['trigger', 'CREATE TRIGGER extra AFTER INSERT ON marriages BEGIN SELECT 1; END;', /Views\/triggers/],
]) test(`preflight refuses ${label} without writes`, t => {
  const { db } = fixture(t);
  db.exec(sql);
  const before = snapshot(db);
  assert.throws(() => migrateCharacterIdentities(db), reason);
  assert.deepEqual(snapshot(db), before);
});

test('published identity absent from retained table is included; staging-only IDs are not retained', t => {
  const { db } = fixture(t);
  db.exec('DELETE FROM character_identities WHERE id=12');
  migrateCharacterIdentities(db, { dryRun: false, targetVersion: 11 });
  assert.equal(db.prepare('SELECT count(*) AS n FROM character_identities').get().n, 3);
  assert.equal(db.prepare("SELECT count(*) AS n FROM character_sources WHERE external_id='1001'").get().n, 0);
});

test('empty catalog and supported legacy version gates', t => {
  const dir = mkdtempSync(join(tmpdir(), 'empty-identity-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = openCatalog(join(dir, 'empty.sqlite'));
  try {
    for (let version = 1; version <= 10; version++) {
      db.exec(`PRAGMA user_version=${version}`);
      assert.equal(migrateCharacterIdentities(db).identities, 0);
    }
    for (const version of [0, 11]) {
      db.exec(`PRAGMA user_version=${version}`);
      assert.throws(() => migrateCharacterIdentities(db), /Unsupported legacy/);
    }
  } finally { db.close(); }
});

test('UUID mapping rejects invalid and duplicate UUIDs; explicit commit gate leaves DB unchanged', t => {
  assert.throws(() => createIdentityMapping([1], () => 'not-uuid'), /Invalid/);
  assert.throws(() => createIdentityMapping([1, 2], () => '00000000-0000-4000-8000-000000000000'), /Invalid/);
  const { db } = fixture(t);
  const before = snapshot(db);
  assert.throws(() => migrateCharacterIdentities(db, { dryRun: false }), /targetVersion/);
  assert.deepEqual(snapshot(db), before);
});

test('CLI requires explicit path, blocks default path before opening and rehearse always rolls back', t => {
  const script = 'scripts/migrateCharacterIdentities.js';
  for (const args of [[], ['--database', 'data/bot.sqlite'], ['--commit']]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
  }
  const { db, path } = fixture(t);
  const before = snapshot(db);
  for (const args of [[], ['--rehearse']]) {
    const result = spawnSync(process.execPath, [script, '--database', path, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(snapshot(db), before);
  }
});
