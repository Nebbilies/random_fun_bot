import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openCatalog } from '../lib/catalogDb.js';
import { addItemToInventory } from '../lib/itemStorage.js';
import { createItemAction, activateItemAction, confirmHostageDelivery } from '../lib/itemActions.js';
import { marryCharacter } from '../lib/characterMarriage.js';
import { settleCharacterMigration, CharacterMigrationSettlementError } from '../lib/characterMigrationSettlement.js';
import { inventoryCharacterIdentities, migrateCharacterIdentities } from '../lib/characterIdentityMigration.js';

const options = { offline: true, backupVerified: true, now: 10_000 };
const rows = (db, table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(row => ({ ...row }));
function snapshot(db) {
  return db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all()
    .map(({ name }) => [name, rows(db, `"${name}"`)]);
}
function fixture(t) {
  const db = openCatalog(':memory:');
  t.after(() => db.close());
  return db;
}
function hostage(db) {
  const choices = [];
  for (const [id, rank, owner] of [[1, 100, '101'], [2, 200, '202'], [3, 300, '202']]) {
    db.prepare('INSERT INTO characters(id,rank,favourites,name_full) VALUES(?,?,1,?)').run(id, rank, `Character ${id}`);
    const marriage = marryCharacter(db, '1', id, owner, 100).marriage;
    choices.push({ characterId: id, marriageId: marriage.id, ownerId: owner });
  }
  db.prepare('INSERT INTO counterfeit_crowns VALUES(?,?,?,?,?)').run('1', '202', 3, choices[2].marriageId, 'generation');
  const item = addItemToInventory(db, '1', '101', 'hostage_note').item;
  const action = createItemAction(db, { guildId: '1', actorId: '101', channelId: '10', inventoryId: item.id,
    selections: { own: choices[0], targets: [choices[1]] }, now: 100 });
  assert.equal(activateItemAction(db, { actionId: action.id, guildId: '1', actorId: '101', now: 101 }).status, 'awaiting_delivery');
  return { action, item };
}
function confirming(db) {
  const item = addItemToInventory(db, '1', '303', 'alchemist').item;
  return createItemAction(db, { guildId: '1', actorId: '303', channelId: '10', inventoryId: item.id, now: 100 });
}
function vault(db, { id = 'v', state = 'decision', item = 'hostage_note', result = null } = {}) {
  const outcome = JSON.stringify({ tier: 'rare', item: { id: item, maxCharges: 1 }, captured: 'do not reroll' });
  db.prepare(`INSERT INTO vault_rewards(vault_id,guild_id,user_id,channel_id,original_json,reward_json,state,result,created_at,deadline)
    VALUES(?,'1','404','10',?,?,?,?,100,200)`).run(id, outcome, state === 'overflow' ? outcome : null, state, result);
  return outcome;
}

test('settled maintenance history passes UUID preflight and converts without losing escrow evidence', t => {
  const db = fixture(t);
  const { action } = hostage(db);
  confirming(db);
  settleCharacterMigration(db, options);
  assert.deepEqual(inventoryCharacterIdentities(db).blockers, []);
  const before = db.prepare('SELECT result_json FROM item_actions WHERE id=?').get(action.id).result_json;
  migrateCharacterIdentities(db, { dryRun: false, targetVersion: 11 });
  const row = db.prepare('SELECT selections_json,result_json FROM item_actions WHERE id=?').get(action.id);
  assert.equal(typeof JSON.parse(row.selections_json).own.characterId, 'string');
  assert.equal(row.result_json, before);
  assert.equal(JSON.parse(row.result_json).releasedEscrow.length, 1);
});

test('explicit acknowledgements, current schema and transaction ownership are required', t => {
  const db = fixture(t);
  const before = snapshot(db);
  assert.throws(() => settleCharacterMigration(db), /acknowledgements/);
  assert.throws(() => settleCharacterMigration(db, { ...options, now: NaN }), /time/);
  db.exec('BEGIN');
  assert.throws(() => settleCharacterMigration(db, options), /transaction/i);
  db.exec('ROLLBACK'); // Caller transaction was not rolled back by the service.
  assert.deepEqual(snapshot(db), before);
  db.exec('PRAGMA user_version=9');
  assert.throws(() => settleCharacterMigration(db, options), /expected current legacy schema 10/);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 9);
});

test('undelivered escrow releases without duplicate refund even at capacity; Crown and relationships survive', t => {
  const db = fixture(t);
  const { action, item } = hostage(db);
  const confirmation = confirming(db);
  for (let i = 0; i < 4; i++) addItemToInventory(db, '1', '101', 'hostage_note');
  const inventory = rows(db, 'user_inventory');
  const marriages = rows(db, 'marriages');
  db.exec("INSERT INTO character_wishes(guild_id,user_id,character_id,created_at) VALUES('1','101',3,100)");
  const wishes = rows(db, 'character_wishes');
  const original = db.prepare('SELECT * FROM item_actions WHERE id=?').get(action.id);
  const report = settleCharacterMigration(db, options);
  assert.deepEqual(new Set(report.canceledActions), new Set([action.id, confirmation.id]));
  assert.deepEqual(report.releasedEscrow, [item.id]);
  assert.equal(report.refundedConsumedCosts, 0);
  assert.deepEqual(rows(db, 'user_inventory'), inventory);
  assert.deepEqual(rows(db, 'marriages'), marriages);
  assert.deepEqual(rows(db, 'character_wishes'), wishes);
  assert.equal(rows(db, 'item_character_reservations').length, 0);
  assert.equal(rows(db, 'item_action_costs').length, 0);
  assert.equal(rows(db, 'counterfeit_crowns')[0].generation_id, 'generation');
  const canceled = db.prepare('SELECT * FROM item_actions WHERE id=?').get(action.id);
  assert.equal(canceled.state, 'canceled');
  assert.equal(canceled.delivery_pending, 0);
  assert.equal(canceled.selections_json, original.selections_json);
  assert.equal(canceled.crown_json, original.crown_json);
  const result = JSON.parse(canceled.result_json);
  assert.equal(result.canceledBy, 'uuid_maintenance');
  assert.deepEqual(JSON.parse(result.releasedEscrow[0].snapshotJson), { ...item });
  const after = snapshot(db);
  assert.deepEqual(settleCharacterMigration(db, options).canceledActions, []);
  assert.deepEqual(snapshot(db), after);
});

test('delivered Hostage lacks refund journal and blocks other safe cancellations', t => {
  const db = fixture(t);
  const { action } = hostage(db);
  confirming(db);
  assert.equal(confirmHostageDelivery(db, action.id, '999', 200), true);
  assert.equal(rows(db, 'item_action_costs').length, 0);
  const before = snapshot(db);
  assert.throws(() => settleCharacterMigration(db, options), error => error instanceof CharacterMigrationSettlementError
    && /delivered Hostage.*exact refund unsupported/.test(error.message));
  assert.deepEqual(snapshot(db), before);
});

for (const change of [
  "UPDATE user_inventory SET charges=charges+1 WHERE user_id='101'",
  'DELETE FROM item_action_costs',
  'DELETE FROM item_character_reservations WHERE character_id=3',
  "UPDATE marriages SET owner_id='changed' WHERE character_id=3",
  "UPDATE item_action_costs SET snapshot_json='not json'",
  "INSERT INTO counterfeit_crowns VALUES('1','202',2,2,'new-generation')",
  "UPDATE item_actions SET state='unknown'",
  "UPDATE item_actions SET kind='unknown'",
]) test(`unsafe Hostage rejected without mutation: ${change}`, t => {
  const db = fixture(t);
  hostage(db);
  db.exec(change);
  const before = snapshot(db);
  assert.throws(() => settleCharacterMigration(db, options), CharacterMigrationSettlementError);
  assert.deepEqual(snapshot(db), before);
});

test('orphan and terminal escrow/reservations block rather than deleting evidence', t => {
  const db = fixture(t);
  const { action } = hostage(db);
  db.prepare("UPDATE item_actions SET state='canceled' WHERE id=?").run(action.id);
  const before = snapshot(db);
  assert.throws(() => settleCharacterMigration(db, options), /terminal action retains/);
  assert.deepEqual(snapshot(db), before);
  db.prepare('DELETE FROM item_actions WHERE id=?').run(action.id);
  const orphaned = snapshot(db);
  assert.throws(() => settleCharacterMigration(db, options), /Orphan escrow\/reservation/);
  assert.deepEqual(snapshot(db), orphaned);
});

for (const [state, command] of [['pending', 'normal'], ['open', 'normal'], ['pending', 'siren:synthetic']]) {
  test(`live ${state} ${command} roll blocks without inferring allowance/buff/Siren refunds`, t => {
    const db = fixture(t);
    confirming(db);
    db.prepare(`INSERT INTO character_rolls(guild_id,channel_id,command_message_id,character_id,character_name,state,published_at)
      VALUES('1','10',?,1,'Captured',?,100)`).run(command, state);
    const before = snapshot(db);
    assert.throws(() => settleCharacterMigration(db, options), /missing exact allowance\/buff\/Siren cost provenance/);
    assert.deepEqual(snapshot(db), before);
  });
}

test('live mystery blocks even with a closed origin roll', t => {
  const db = fixture(t);
  db.exec(`INSERT INTO character_rolls(guild_id,channel_id,command_message_id,character_id,character_name,state,published_at)
    VALUES('1','10','normal',1,'Captured','closed',100);
    INSERT INTO mystery_sessions(guild_id,origin_roll_id,event_id,character_id,rank_snapshot,state,roller_id,event_channel_id,started_at,deadline_at)
    VALUES('1',1,'doors',1,50,'running','101','10',100,200)`);
  const before = snapshot(db);
  assert.throws(() => settleCharacterMigration(db, options), /origin roll refund provenance unavailable/);
  assert.deepEqual(snapshot(db), before);
});

test('vault Keep and determined overflow preserve outcomes without gambling or duplicate delivery', t => {
  const db = fixture(t);
  const original = vault(db);
  vault(db, { id: 'won', state: 'overflow', result: 'won' });
  assert.deepEqual(settleCharacterMigration(db, options).deliveredVaults, ['v', 'won']);
  assert.equal(rows(db, 'user_inventory').length, 2);
  const rewards = rows(db, 'vault_rewards');
  assert.equal(rewards[0].original_json, original);
  assert.equal(rewards[0].reward_json, original);
  assert.equal(rewards[0].result, 'kept');
  assert.equal(rewards[1].result, 'won');
  assert.ok(rewards.every(row => row.state === 'delivered' && row.delivered_at === null));
  const before = snapshot(db);
  settleCharacterMigration(db, options);
  assert.deepEqual(snapshot(db), before);
});

test('full vault inventory rolls back earlier cancellation, Crown restoration and reward delivery', t => {
  const db = fixture(t);
  hostage(db);
  for (let i = 0; i < 4; i++) addItemToInventory(db, '1', '404', 'hostage_note');
  vault(db, { id: 'first' });
  vault(db, { id: 'second' });
  const before = snapshot(db);
  assert.throws(() => settleCharacterMigration(db, options), /inventory full/);
  assert.deepEqual(snapshot(db), before);
});

test('late SQL failure rolls back all durable settlement; retry succeeds', t => {
  const db = fixture(t);
  hostage(db);
  vault(db);
  db.exec("CREATE TRIGGER reject_vault BEFORE UPDATE ON vault_rewards BEGIN SELECT RAISE(ABORT,'injected settlement failure'); END");
  const before = snapshot(db);
  assert.throws(() => settleCharacterMigration(db, options), /injected settlement failure/);
  assert.deepEqual(snapshot(db), before);
  db.exec('DROP TRIGGER reject_vault');
  assert.equal(settleCharacterMigration(db, options).canceledActions.length, 1);
});

test('terminal history and spent costs remain byte-for-byte unchanged', t => {
  const db = fixture(t);
  const action = confirming(db);
  db.prepare("UPDATE item_actions SET state='resolved',result_json=?,delivery_pending=1 WHERE id=?")
    .run('{"status":"resolved","message":"historic result"}', action.id);
  db.exec(`INSERT INTO character_rolls(guild_id,channel_id,command_message_id,character_id,character_name,state,published_at)
    VALUES('1','10','historic',1,'Captured','closed',100)`);
  vault(db, { state: 'lost' });
  const before = snapshot(db);
  settleCharacterMigration(db, options);
  assert.deepEqual(snapshot(db), before);
});
