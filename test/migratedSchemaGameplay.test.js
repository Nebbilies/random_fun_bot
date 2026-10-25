import assert from 'node:assert/strict';
import test from 'node:test';
import { openCatalog } from '../lib/catalogDb.js';
import { migrateCharacterIdentities, createIdentityMapping, CHARACTER_REFERENCES } from '../lib/characterIdentityMigration.js';
import { marryCharacter, getMarriage } from '../lib/characterMarriage.js';
import { transferCharacter, swapCharacters } from '../lib/characterTrade.js';
import { addWish, getWishes } from '../lib/characterWishlist.js';
import { reserveRoll, publishRoll, claimRoll, getRoll } from '../lib/characterRolls.js';
import { addItemToInventory } from '../lib/itemStorage.js';
import { settleCharacterMigration } from '../lib/characterMigrationSettlement.js';
import { createItemAction, activateItemAction, updateItemSelection } from '../lib/itemActions.js';

// Exercise the actual rebuilt schema, not a hand-authored approximation of TEXT keys.
function fixture(t) {
  const db = openCatalog(':memory:');
  t.after(() => db.close());
  db.exec(`INSERT INTO characters(id,rank,favourites,name_full,gender) VALUES
    (11,1,100,'First','Female'),(22,2,90,'Second','Male'),(33,3,80,'Third',NULL);
    INSERT INTO character_identities SELECT id,name_full,image_url FROM characters;`);
  migrateCharacterIdentities(db, { dryRun: false, targetVersion: 11 });
  const id = legacy => db.prepare('SELECT character_id FROM character_identity_migration WHERE legacy_id=?').get(legacy).character_id;
  return { db, a: id(11), b: id(22), c: id(33) };
}
function integrity(db) {
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
}

test('actual migrated schema retains numeric entity keys and TEXT character references', t => {
  const { db } = fixture(t);
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  for (const [table, column] of Object.entries(CHARACTER_REFERENCES)) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    const reference = columns.find(row => row.name === column);
    assert.equal(reference.type, 'TEXT', `${table}.${column}`);
    if (reference.pk) assert.equal(reference.notnull, 1, `${table}.${column} primary key rejects NULL`);
    if (column !== 'id' && columns.some(row => row.name === 'id')) {
      assert.equal(columns.find(row => row.name === 'id').type, 'INTEGER', `${table}.id stays numeric`);
    }
  }
  integrity(db);
});

test('actual migrated schema supports ownership, trade, gift and wishes', t => {
  const { db, a, b, c } = fixture(t);
  assert.equal(marryCharacter(db, '1', a, '101', 100).status, 'married');
  assert.equal(marryCharacter(db, '1', b, '102', 100).status, 'married');
  assert.equal(swapCharacters(db, { guildId: '1', first: { characterId: a, ownerId: '101' }, second: { characterId: b, ownerId: '102' } }).status, 'traded');
  assert.equal(transferCharacter(db, { guildId: '1', characterId: a, fromOwnerId: '102', toOwnerId: '101' }).status, 'transferred');
  assert.equal(addWish(db, { guildId: '1', userId: '101', characterId: c }).status, 'added');
  assert.equal(getWishes(db, { guildId: '1', userId: '101' })[0].characterId, c);
  assert.equal(getMarriage(db, '1', a).ownerId, '101');
  integrity(db);
});

test('actual migrated schema supports reserve, publish and claim with UUID targets', t => {
  const { db } = fixture(t);
  const now = Date.parse('2026-10-15T17:00:00Z');
  const result = reserveRoll(db, { guildId: '1', channelId: '10', commandMessageId: '100', userId: '101', pool: 'w', now, random: () => 0 });
  assert.equal(result.status, 'reserved');
  assert.equal(typeof result.character.id, 'string');
  publishRoll(db, result.rollId, '200', now);
  assert.equal(getRoll(db, '1', '10', '200').characterId, result.character.id);
  const claimed = claimRoll(db, { guildId: '1', channelId: '10', messageId: '200', userId: '102', now: now + 100 });
  assert.equal(claimed.status, 'married');
  assert.equal(getMarriage(db, '1', result.character.id).ownerId, '102');
  integrity(db);
});

test('actual migrated schema executes an item target and persists UUID snapshots', t => {
  const { db, a, b } = fixture(t);
  const own = marryCharacter(db, '1', a, '101', 100).marriage;
  const victim = marryCharacter(db, '1', b, '102', 100).marriage;
  const item = addItemToInventory(db, '1', '101', 'severed_fate').item;
  const action = createItemAction(db, { guildId: '1', actorId: '101', channelId: '10', inventoryId: item.id,
    selections: { own: { characterId: a, marriageId: own.id, ownerId: '101' }, targets: [{ characterId: b, marriageId: victim.id, ownerId: '102' }] }, now: 100 });
  const outcome = activateItemAction(db, { actionId: action.id, guildId: '1', actorId: '101', now: 101 });
  assert.equal(outcome.status, 'resolved');
  assert.equal(getMarriage(db, '1', b), null);
  const persisted = JSON.parse(db.prepare('SELECT result_json FROM item_actions WHERE id=?').get(action.id).result_json);
  assert.equal(persisted.targets[0].characterId, b);
  integrity(db);
});


test('empty AUTOINCREMENT tables preserve deleted generation high-water marks', t => {
  const db = openCatalog(':memory:');
  t.after(() => db.close());
  db.exec("INSERT INTO characters(id,rank,favourites,name_full) VALUES(1,1,1,'A')");
  db.exec(`INSERT INTO marriages(id,guild_id,character_id,owner_id,married_at) VALUES(900,'1',1,'101','100'); DELETE FROM marriages;
    INSERT INTO character_rolls(id,guild_id,channel_id,command_message_id,character_id,character_name,state)
      VALUES(901,'1','10','100',1,'A','closed'); DELETE FROM character_rolls;
    INSERT INTO mystery_sessions(id,guild_id,origin_roll_id,event_id,character_id,rank_snapshot,roller_id,event_channel_id,state,started_at,deadline_at)
      VALUES(902,'1',901,'doors',1,1,'101','10','completed',100,200); DELETE FROM mystery_sessions;`);
  const sequences = () => db.prepare("SELECT name,seq FROM sqlite_sequence ORDER BY name").all();
  const before = sequences();
  migrateCharacterIdentities(db); // Rehearsal must restore even emptied sequence entries.
  assert.deepEqual(sequences(), before);
  db.exec(`INSERT INTO stage_characters(id,favourites) VALUES(1,1);
    CREATE TRIGGER force_migration_failure BEFORE DELETE ON stage_characters BEGIN SELECT RAISE(ABORT,'injected'); END;`);
  assert.throws(() => migrateCharacterIdentities(db, { dryRun: false, targetVersion: 11 }), /injected/);
  assert.deepEqual(sequences(), before);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 10);
  db.exec('DROP TRIGGER force_migration_failure');
  migrateCharacterIdentities(db, { dryRun: false, targetVersion: 11 });
  assert.deepEqual(sequences(), before);
  const id = db.prepare('SELECT id FROM characters').get().id;
  assert.equal(marryCharacter(db, '1', id, '101', 101).marriage.id, 901);
});

test('migrated identity primary keys reject NULL rather than silently allowing unusable identities', t => {
  const { db } = fixture(t);
  assert.throws(() => db.exec("INSERT INTO character_identities(id,name_full) VALUES(NULL,'bad')"), /NOT NULL/);
  assert.throws(() => db.exec("INSERT INTO characters(id,rank,favourites,name_full) VALUES(NULL,4,1,'bad')"), /NOT NULL/);
});

test('mapping canonicalizes UUID generator output before checking duplicates', () => {
  const id = 'abcdef01-2345-4678-9abc-def012345678';
  assert.equal(createIdentityMapping([1], () => id.toUpperCase()).get(1), id);
  let calls = 0;
  assert.throws(() => createIdentityMapping([1,2], () => calls++ ? id.toUpperCase() : id), /duplicate/);
});

test('sparse picker target slots survive maintenance cancellation and migration', t => {
  const db = openCatalog(':memory:');
  t.after(() => db.close());
  db.exec("INSERT INTO characters(id,rank,favourites,name_full) VALUES(1,1,1,'A')");
  const marriage = marryCharacter(db, '1', 1, '104', 100).marriage;
  const item = addItemToInventory(db, '1', '101', 'grand_masquerade').item;
  const action = createItemAction(db, { guildId: '1', actorId: '101', channelId: '10', inventoryId: item.id, now: 100 });
  const targets = [];
  targets[2] = { characterId: 1, marriageId: marriage.id, ownerId: '104', rank: 1, name: 'A' };
  assert.equal(updateItemSelection(db, action.id, '1', '101', { targets }, 101), true);
  settleCharacterMigration(db, { offline: true, backupVerified: true, now: 101 });
  migrateCharacterIdentities(db, { dryRun: false, targetVersion: 11 });
  const converted = JSON.parse(db.prepare('SELECT selections_json FROM item_actions WHERE id=?').get(action.id).selections_json).targets;
  assert.deepEqual(converted.slice(0,2), [null,null]);
  assert.equal(converted[2].characterId, db.prepare('SELECT id FROM characters').get().id);
  integrity(db);
});
