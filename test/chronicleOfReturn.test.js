import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recoverItemActionRuntime } from '../lib/itemActionRuntime.js';
import { adaptCharacterSnapshot } from '../lib/characterIdentitySnapshots.js';
import { installEmptyFinalCatalog } from '../lib/catalogFinalSchema.js';
import { withOwnershipOperationClock, getLatestOwnershipLoss } from '../lib/characterOwnershipHistory.js';
import { openCatalog } from '../lib/catalogDb.js';
import { addItemToInventory, getInventory } from '../lib/itemStorage.js';
import { getConfigView, saveConfigSection } from '../lib/gameConfig.js';
import { getMarriage } from '../lib/characterMarriage.js';
import { registerPendingTransfer } from '../lib/characterAvailability.js';
import { getItemAction } from '../lib/itemActionStorage.js';
import { createItemAction, activateItemAction, updateItemSelection, cancelItemAction, expireItemActions } from '../lib/itemActions.js';

const WINDOW = 604800000;
function fixture(t) {
  const db = openCatalog(':memory:');
  t.after(() => db.close());
  // Isolate action behavior from the separately owned additive-schema rollout.
  db.exec(`CREATE TABLE IF NOT EXISTS character_ownership_losses (
    guild_id TEXT NOT NULL, former_owner_id TEXT NOT NULL, character_id INTEGER NOT NULL,
    lost_at INTEGER NOT NULL, PRIMARY KEY(guild_id,former_owner_id,character_id));
    INSERT INTO characters(id,rank,favourites,name_full) VALUES(1,99999,0,'Former companion');`);
  const now = Date.now();
  db.prepare('INSERT INTO character_ownership_losses VALUES(?,?,?,?)').run('1', '101', 1, now - WINDOW);
  // The item roster is integrated by a different agent; use an existing lifetime.
  const source = addItemToInventory(db, '1', '101', 'chaos_exchange', 2, { now }).item;
  db.prepare('UPDATE user_inventory SET item_id=? WHERE id=?').run('chronicle_of_return', source.id);
  const start = (selections = { returnTarget: { characterId: 1 } }) => createItemAction(db, {
    guildId: '1', actorId: '101', channelId: '10', inventoryId: source.id, selections, now });
  const confirm = (action, at = now) => activateItemAction(db, { actionId: action.id, guildId: '1', actorId: '101', now: at });
  return { db, now, source, start, confirm };
}

for (const reason of ['old', 'future', 'other guild', 'other owner', 'owned', 'archived', 'held', 'busy', 'trade', 'gift', 'mystery', 'escape']) test(`Chronicle refuses ${reason} history without spending or holding the source`, (t) => {
  const f = fixture(t);
  if (reason === 'old') f.db.prepare('UPDATE character_ownership_losses SET lost_at=?').run(f.now - WINDOW - 1);
  if (reason === 'future') f.db.prepare('UPDATE character_ownership_losses SET lost_at=?').run(f.now + 1);
  if (reason === 'other guild') f.db.exec("UPDATE character_ownership_losses SET guild_id='2'");
  if (reason === 'other owner') f.db.exec("UPDATE character_ownership_losses SET former_owner_id='202'");
  if (reason === 'owned') f.db.exec("INSERT INTO marriages(guild_id,character_id,owner_id,married_at) VALUES('1',1,'202','old')");
  if (reason === 'archived') f.db.exec('DELETE FROM characters WHERE id=1');
  if (reason === 'held') f.db.exec("INSERT INTO character_rolls(guild_id,channel_id,command_message_id,character_id,character_name,state) VALUES('1','10','roll',1,'Former companion','pending')");
  if (reason === 'busy') f.db.exec("INSERT INTO item_character_reservations VALUES('1',1,'other','202',123)");
  if (reason === 'trade' || reason === 'gift') registerPendingTransfer(f.db, reason, '1', [1], f.now + 1000);
  if (reason === 'mystery') f.db.exec(`INSERT INTO mystery_sessions(guild_id,origin_roll_id,event_id,character_id,rank_snapshot,roller_id,event_channel_id,state,state_json,started_at,deadline_at)
    VALUES('1',123,'doors',1,99999,'101','10','reserved','{}',1,9999999999999)`);
  if (reason === 'escape') f.db.exec(`INSERT INTO character_rolls(guild_id,channel_id,command_message_id,character_id,character_name,state,escape_marriage_id)
    VALUES('1','10','escape',1,'Former companion','pending',123)`);
  const action = f.start();
  assert.equal(action.state, 'canceled');
  assert.equal(action.result.noCost, true);
  assert.equal(getInventory(f.db, '1', '101')[0].charges, 2);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM item_use_reservations').get().n, 0);
});

test('Chronicle preserves the captured window across selection updates and rechecks the latest loss', (t) => {
  const f = fixture(t);
  const action = f.start();
  assert.equal(updateItemSelection(f.db, action.id, '1', '101', { returnTarget: { characterId: 1 }, historyWindowMs: 1 }, f.now), true);
  assert.equal(getItemAction(f.db, action.id).selections.historyWindowMs, WINDOW);
  saveConfigSection(f.db, { guildId: '1', section: 'itemEffects',
    values: { 'itemEffects.chronicle_of_return.historyWindowMs': 1 }, expectedRevision: getConfigView(f.db, '1').revision });
  // A new actual loss replaces an otherwise expired old loss.
  f.db.prepare('UPDATE character_ownership_losses SET lost_at=?').run(f.now + 1);
  assert.equal(f.confirm(action, f.now + 3).status, 'resolved');
});

for (const reason of ['elapsed', 'future loss', 'acquired', 'missing source', 'cancel', 'timeout']) test(`Chronicle confirmation ${reason} costs nothing`, (t) => {
  const f = fixture(t);
  const action = f.start();
  if (reason === 'future loss') f.db.prepare('UPDATE character_ownership_losses SET lost_at=?').run(f.now + 2);
  if (reason === 'acquired') f.db.exec("INSERT INTO marriages(guild_id,character_id,owner_id,married_at) VALUES('1',1,'202','new')");
  if (reason === 'missing source') {
    f.db.prepare('DELETE FROM item_use_reservations WHERE action_id=?').run(action.id);
    f.db.prepare('DELETE FROM user_inventory WHERE id=?').run(f.source.id);
  }
  if (reason === 'cancel') cancelItemAction(f.db, action.id, '1', '101');
  if (reason === 'timeout') expireItemActions(f.db, action.expires_at);
  const result = f.confirm(action, f.now + 1);
  assert.notEqual(result.status, 'resolved');
  if (reason !== 'missing source') assert.equal(getInventory(f.db, '1', '101')[0].charges, 2);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM item_use_reservations').get().n, 0);
  if (reason !== 'acquired') assert.equal(getMarriage(f.db, '1', 1), null);
});

test('Chronicle rolls back fresh ownership, source debit and result together on SQL failure', (t) => {
  const f = fixture(t);
  const action = f.start();
  f.db.exec(`CREATE TRIGGER reject_chronicle_result BEFORE UPDATE OF result_json ON item_actions
    WHEN NEW.result_json IS NOT NULL BEGIN SELECT RAISE(ABORT,'result failed'); END;`);
  assert.throws(() => f.confirm(action), /result failed/);
  assert.equal(getMarriage(f.db, '1', 1), null);
  assert.equal(getInventory(f.db, '1', '101')[0].charges, 2);
  assert.equal(getItemAction(f.db, action.id).state, 'confirming');
  f.db.exec('DROP TRIGGER reject_chronicle_result');
  assert.equal(f.confirm(action).status, 'resolved');
});

test('Chronicle supports durable UUID identities and private action deletes use the injected loss clock', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  installEmptyFinalCatalog(db);
  const id = '11111111-1111-4111-8111-111111111111';
  const now = Date.now();
  db.prepare('INSERT INTO character_identities(id) VALUES(?)').run(id);
  db.prepare("INSERT INTO characters(id,rank,favourites,tie_order,likes_source,name_full) VALUES(?,1,1,1,'generated','Companion')").run(id);
  db.prepare("INSERT INTO marriages(guild_id,character_id,owner_id,married_at) VALUES('1',?,'101','old')").run(id);
  withOwnershipOperationClock(db, now - 100, () => db.exec('DELETE FROM marriages'));
  const source = addItemToInventory(db, '1', '101', 'chronicle_of_return', 2, { now }).item;
  const action = createItemAction(db, { guildId: '1', actorId: '101', channelId: '10', inventoryId: source.id,
    selections: { returnTarget: { characterId: id } }, now });
  const request = { actionId: action.id, guildId: '1', actorId: '101', now };
  assert.equal(activateItemAction(db, request).status, 'resolved');
  assert.equal(getMarriage(db, '1', id).marriedAt, new Date(now).toISOString());
  const fate = addItemToInventory(db, '1', '202', 'severed_fate', 1, { now }).item;
  const lossAction = createItemAction(db, { guildId: '1', actorId: '202', channelId: '10', inventoryId: fate.id, now,
    selections: { targets: [{ characterId: id, ownerId: '101', marriageId: getMarriage(db, '1', id).id }] } });
  assert.equal(activateItemAction(db, { actionId: lossAction.id, guildId: '1', actorId: '202', now: now + 1 }).status, 'resolved');
  assert.equal(getLatestOwnershipLoss(db, '1', '101', id).lostAt, now + 1);
  assert.equal(db.prepare('SELECT now_ms FROM ownership_operation_clock').get().now_ms, null);
  // Replaying the completed return must not recreate ownership after a new loss.
  assert.equal(activateItemAction(db, request).status, 'resolved');
  assert.equal(getMarriage(db, '1', id), null);
});

test('Chronicle returns an inclusive-boundary former companion with fresh ownership and one durable cost', (t) => {
  const f = fixture(t);
  const action = f.start();
  assert.equal(action.state, 'confirming');
  assert.equal(action.selections.historyWindowMs, WINDOW);
  f.db.prepare('INSERT INTO claim_allowances VALUES(?,?,?)').run('1', '101', 123);
  f.db.prepare('INSERT INTO claim_events VALUES(?,?,?)').run('1', '101', f.now - 100);
  for (const [buff, data, rolls] of [
    ['pinata_claim_token', { claimTokens: 2 }, 2],
    ['crown_of_the_sovereign', { claimTokens: 1 }, 1],
    ['engagement_ring', { claims: 3, cooldownMultiplier: 0.5 }, 3],
    ['double_date', { durationMs: 86400000 }, null],
  ]) f.db.prepare(`INSERT INTO active_user_buffs(guild_id,user_id,buff_id,data_json,expires_at,remaining_rolls,starts_at)
    VALUES('1','101',?,?,?,?,?)`).run(buff, JSON.stringify(data), f.now + WINDOW, rolls, f.now - 1000);
  const snapshot = () => Object.fromEntries(['claim_allowances', 'claim_events', 'active_user_buffs']
    .map(table => [table, f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  const before = snapshot();
  assert.equal(before.active_user_buffs.length, 4);
  const result = f.confirm(action);
  assert.equal(result.status, 'resolved');
  assert.equal(result.character.id, 1);
  assert.equal(getMarriage(f.db, '1', 1).ownerId, '101');
  assert.equal(getMarriage(f.db, '1', 1).marriedAt, new Date(f.now).toISOString());
  assert.equal(getInventory(f.db, '1', '101')[0].charges, 1);
  assert.deepEqual(f.confirm(action), result);
  assert.deepEqual(snapshot(), before);
  assert.equal(getItemAction(f.db, action.id).delivery_pending, 1);
});


test('unsupported legacy Chronicle start refuses gracefully without SQL errors or a hold', (t) => {
  const db = openCatalog(':memory:'); t.after(() => db.close());
  const source = addItemToInventory(db, '1', '101', 'chronicle_of_return', 1).item;
  const action = createItemAction(db, { guildId: '1', actorId: '101', channelId: '10', inventoryId: source.id });
  assert.equal(action.status, 'invalid');
  assert.match(action.message, /supported ownership history/);
  assert.equal(getInventory(db, '1', '101')[0].charges, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM item_use_reservations').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM item_actions').get().n, 0);
});

test('file-backed Chronicle reopens its held confirmation and recovers committed delivery without replay', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'chronicle-review-'));
  const path = join(dir, 'catalog.sqlite');
  let db = new DatabaseSync(path);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  installEmptyFinalCatalog(db);
  const id = '22222222-2222-4222-8222-222222222222';
  const now = Date.now();
  db.prepare('INSERT INTO character_identities(id) VALUES(?)').run(id);
  db.prepare("INSERT INTO characters(id,rank,favourites,tie_order,likes_source,name_full) VALUES(?,1,1,1,'generated','Returned')").run(id);
  db.prepare("INSERT INTO marriages(guild_id,character_id,owner_id,married_at) VALUES('1',?,'101','old marriage')").run(id);
  const oldId = getMarriage(db, '1', id).id;
  withOwnershipOperationClock(db, now - 1, () => db.exec('DELETE FROM marriages'));
  const source = addItemToInventory(db, '1', '101', 'chronicle_of_return', 2, { now }).item;
  const action = createItemAction(db, { guildId: '1', actorId: '101', channelId: '10', inventoryId: source.id, now,
    selections: { returnTarget: { characterId: id } } });
  db.prepare("UPDATE item_actions SET message_id='canonical' WHERE id=?").run(action.id);
  db.close(); db = openCatalog(path);
  assert.equal(getItemAction(db, action.id).state, 'confirming');
  assert.equal(db.prepare('SELECT count(*) AS n FROM item_use_reservations').get().n, 1);
  const request = { actionId: action.id, guildId: '1', actorId: '101', now };
  const result = activateItemAction(db, request);
  assert.equal(result.status, 'resolved');
  const marriage = getMarriage(db, '1', id);
  assert.notEqual(marriage.id, oldId);
  assert.equal(marriage.marriedAt, new Date(now).toISOString());
  db.close(); db = openCatalog(path);
  const edited = [];
  let offline = true;
  const client = { channels: { fetch: async channelId => {
    assert.equal(channelId, '10');
    return { guildId: '1', send: async () => assert.fail('must edit canonical message'), messages: {
      fetch: async messageId => {
        assert.equal(messageId, 'canonical');
        if (offline) throw Error('temporary outage');
        return { edit: async payload => edited.push(payload) };
      } } };
  } } };
  const runtime = await recoverItemActionRuntime(db, client); t.after(runtime.stop);
  assert.equal(getItemAction(db, action.id).delivery_pending, 1);
  offline = false; await runtime.reconcile();
  assert.equal(edited.length, 1);
  assert.equal(getItemAction(db, action.id).delivery_pending, 0);
  assert.deepEqual(activateItemAction(db, request), result);
  assert.deepEqual(getMarriage(db, '1', id), marriage);
  assert.equal(getInventory(db, '1', '101')[0].charges, 1);
});

test('Chronicle offline snapshot codec rejects foreign producers and unknown target fields', () => {
  const row = { id: 'review', kind: 'chronicle_of_return' };
  const adapt = value => adaptCharacterSnapshot('item_actions', 'selections_json', { ...row, selections_json: JSON.stringify(value) });
  for (const value of [
    { returnTarget: { characterId: 1, marriageId: 7 }, historyWindowMs: WINDOW },
    { returnTarget: { characterId: 'uuid' }, historyWindowMs: WINDOW },
    { returnTarget: { characterId: 1 }, historyWindowMs: 0 },
    { _ui: { itemRevealStep: 1 } },
  ]) assert.throws(() => adapt(value), /item_actions\[review\]/);
  assert.throws(() => adaptCharacterSnapshot('item_actions', 'selections_json', {
    id: 'review', kind: 'chaos_exchange', selections_json: JSON.stringify({ historyWindowMs: WINDOW }) }), /invalid Chronicle window/);
});


test('competing Chronicle confirmations cannot return the same character twice', (t) => {
  const f = fixture(t);
  const first = f.start();
  const secondSource = addItemToInventory(f.db, '1', '101', 'chronicle_of_return', 1, { now: f.now }).item;
  const second = createItemAction(f.db, { guildId: '1', actorId: '101', channelId: '10', inventoryId: secondSource.id,
    now: f.now, selections: { returnTarget: { characterId: 1 } } });
  assert.equal(second.state, 'confirming');
  assert.equal(f.confirm(first).status, 'resolved');
  const marriage = getMarriage(f.db, '1', 1);
  assert.equal(f.confirm(second).status, 'invalid');
  assert.deepEqual(getMarriage(f.db, '1', 1), marriage);
  assert.equal(getInventory(f.db, '1', '101').find(row => row.id === secondSource.id).charges, 1);
  assert.equal(getItemAction(f.db, second.id).state, 'canceled');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM item_use_reservations').get().n, 0);
});
