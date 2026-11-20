import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCatalog } from '../lib/catalogDb.js';
import { marryCharacter, getMarriage, divorceCharacter } from '../lib/characterMarriage.js';
import { addItemToInventory, getInventory as getInventoryAt, isCharacterLocked } from '../lib/itemStorage.js';
import { getItemAction, getCounterfeitCrown } from '../lib/itemActionStorage.js';
import { createItemAction, activateItemAction, confirmHostageDelivery, recoverItemActions,
  resolveHostage } from '../lib/itemActions.js';
import { executeItemUse } from '../commands/use.js';

const now = Date.parse('2026-10-18T01:00:00Z');
const noDraw = () => { throw new Error('must not draw again'); };
// Inventory observations share the action clock, never the machine's date.
const getInventory = (db, guildId, userId, at = now) => getInventoryAt(db, guildId, userId, at);

function fixture(t, disk = false) {
  const dir = disk ? mkdtempSync(join(tmpdir(), 'item-edges-')) : null;
  const path = dir ? join(dir, 'catalog.sqlite') : ':memory:';
  let db = openCatalog(path);
  t.after(() => { db.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });
  db.exec(`INSERT INTO characters(id,rank,favourites,name_full) VALUES
    (1,100,1,'Stake'),(2,150,1,'Original'),(3,75,1,'Decoy'),(4,200,1,'Other')`);
  return { get db() { return db; }, restart() { db.close(); db = openCatalog(path); return db; } };
}

function own(db, id, ownerId) {
  const result = marryCharacter(db, '1', id, ownerId);
  assert.equal(result.status, 'married');
  return { characterId: id, ownerId, marriageId: result.marriage.id };
}
function grant(db, kind, user = '101') {
  const result = addItemToInventory(db, '1', user, kind, undefined, { now });
  assert.equal(result.status, 'added');
  return result.item;
}
function prepare(db, kind, selections, actorId = '101') {
  const item = grant(db, kind, actorId);
  const action = createItemAction(db, { guildId: '1', actorId, channelId: '10',
    inventoryId: item.id, selections, now });
  assert.ok(action.id);
  return { item, action };
}
function activate(db, action, random = noDraw) {
  return activateItemAction(db, { actionId: action.id, guildId: '1', actorId: action.actor_id, now, random });
}
function crown(db, decoy) {
  const { action } = prepare(db, 'counterfeit_crown', { own: decoy }, decoy.ownerId);
  assert.equal(activate(db, action).status, 'resolved');
  return getCounterfeitCrown(db, '1', decoy.ownerId);
}
function hostage(db, stake, target) {
  const prepared = prepare(db, 'hostage_note', { own: stake, targets: [target] }, stake.ownerId);
  assert.equal(activate(db, prepared.action).status, 'awaiting_delivery');
  return prepared;
}
function reservations(db) {
  return db.prepare('SELECT * FROM item_character_reservations ORDER BY character_id').all();
}
function marriages(db) {
  return [1, 2, 3, 4].map((id) => getMarriage(db, '1', id));
}
function legacy(db, kind, user = '101', target = '202', name = 'Original') {
  return executeItemUse(db, '1', user, kind, kind === 'master_key' ? [target, name] : [target],
    { now, random: () => 0 });
}

for (const [ownRank, targetRank, status] of [
  [201, 100, 'invalid'],
  [201, 101, 'awaiting_delivery'],
  [201, 10_000, 'awaiting_delivery'],
  [100, 1, 'awaiting_delivery'],
]) test(`Hostage ranks #${ownRank} and #${targetRank}: ${status}`, (t) => {
  const { db } = fixture(t);
  db.prepare('UPDATE characters SET rank=? WHERE id=1').run(ownRank);
  const stake = own(db, 1, '101');
  const target = own(db, 2, '202');
  const { item, action } = prepare(db, 'hostage_note', { own: stake, targets: [{ ...target, rank: 150 }] });
  db.prepare('UPDATE characters SET rank=? WHERE id=2').run(targetRank);

  const result = activate(db, action);
  assert.equal(result.status, status);
  if (status === 'invalid') {
    assert.match(result.message, /#101/);
    assert.deepEqual(getInventory(db, '1', '101'), [item]);
    assert.deepEqual(reservations(db), []);
  }
});

test('restart cancels an unconfirmed Hostage, refunds its exact Note and Crown only once', (t) => {
  const f = fixture(t, true);
  let db = f.db;
  db.exec('UPDATE characters SET rank=201 WHERE id=1');
  const stake = own(db, 1, '101');
  const target = own(db, 2, '202');
  const defense = crown(db, own(db, 3, '202'));
  const before = marriages(db);
  const { item, action } = hostage(db, stake, target);
  assert.deepEqual(getInventory(db, '1', '101'), [item], 'undelivered Note stays in escrow');
  assert.equal(executeItemUse(db, '1', '101', 'hostage_note').pendingAction, undefined);
  assert.equal(getCounterfeitCrown(db, '1', '202'), null);
  assert.deepEqual(reservations(db).map((r) => r.character_id), [1, 3]);
  db = f.restart();
  const recoveryAt = getItemAction(db, action.id).expires_at + 1;
  recoverItemActions(db, recoveryAt, noDraw);
  assert.equal(getItemAction(db, action.id).state, 'canceled');
  assert.deepEqual(getInventory(db, '1', '101', recoveryAt), [item]);
  assert.deepEqual(getCounterfeitCrown(db, '1', '202'), defense);
  assert.deepEqual(marriages(db), before);
  assert.deepEqual(reservations(db), []);
  db = f.restart();
  recoverItemActions(db, recoveryAt, noDraw);
  assert.deepEqual(getInventory(db, '1', '101', recoveryAt), [item]);
  assert.deepEqual(getCounterfeitCrown(db, '1', '202'), defense);
  assert.deepEqual(marriages(db), before);
});

test('restart resumes delivered Hostage then settles overdue Gamble exactly once', (t) => {
  const f = fixture(t, true);
  let db = f.db;
  const stake = own(db, 1, '101');
  const target = own(db, 2, '202');
  const { action } = hostage(db, stake, target);
  assert.equal(confirmHostageDelivery(db, action.id, '999', now), true);
  const saved = getItemAction(db, action.id);
  const held = reservations(db);
  db = f.restart();
  recoverItemActions(db, saved.deadline_at - 1, noDraw);
  assert.equal(getItemAction(db, action.id).state, 'active');
  assert.equal(getItemAction(db, action.id).message_id, '999');
  assert.deepEqual(reservations(db), held);
  let draws = 0;
  recoverItemActions(db, saved.deadline_at + 1, () => { draws++; return 0; });
  assert.equal(draws, 1);
  const result = getItemAction(db, action.id).result;
  assert.equal(result.choice, 'gamble');
  assert.equal(getMarriage(db, '1', 1).id, stake.marriageId);
  assert.equal(getMarriage(db, '1', 2), null);
  assert.deepEqual(getInventory(db, '1', '101'), []);
  assert.deepEqual(reservations(db), []);
  const settled = marriages(db);
  db = f.restart();
  recoverItemActions(db, saved.deadline_at + 2, noDraw);
  assert.deepEqual(resolveHostage(db, { actionId: action.id, guildId: '1', userId: '202',
    choice: 'exchange', now: saved.deadline_at + 2, random: noDraw }), result);
  assert.deepEqual(marriages(db), settled);
  assert.deepEqual(getInventory(db, '1', '101'), []);
});

for (const heldState of ['pending', 'open', 'reserved', 'running', 'countdown', 'claim_open']) {
  for (const [draw, expected] of [[0, 3], [1 - Number.EPSILON, 4]]) {
    test(`Chaos excludes live ${heldState} prize and permits ${expected === 3 ? 'upgrade' : 'downgrade'}`, (t) => {
      const { db } = fixture(t);
      const stake = own(db, 1, '101');
      // The held prize is first by ID; endpoints must reach both eligible rank directions.
      const roll = db.prepare(`INSERT INTO character_rolls(guild_id,channel_id,command_message_id,
        character_id,character_name,state,expires_at) VALUES('1','10','900',2,'Original',?,?)`)
        .run(['pending', 'open'].includes(heldState) ? heldState : 'closed', now + 1);
      if (!['pending', 'open'].includes(heldState)) {
        db.prepare(`INSERT INTO mystery_sessions(guild_id,origin_roll_id,event_id,character_id,
          rank_snapshot,roller_id,event_channel_id,state,started_at,deadline_at)
          VALUES('1',?,'test',2,150,'101','10',?,?,?)`)
          .run(Number(roll.lastInsertRowid), heldState, now, now + 1);
      }
      const { action } = prepare(db, 'chaos_exchange', { own: stake });
      assert.equal(activate(db, action, () => draw).status, 'resolved');
      assert.equal(getMarriage(db, '1', 1), null);
      assert.equal(getMarriage(db, '1', 2), null);
      assert.equal(getMarriage(db, '1', expected).ownerId, '101');
      assert.equal(getMarriage(db, '1', expected === 3 ? 4 : 3), null);
      assert.deepEqual(getInventory(db, '1', '101'), []);
      assert.equal(isCharacterLocked(db, '1', expected, now).locked, false);
      const settled = marriages(db);
      activate(db, action, noDraw);
      assert.deepEqual(marriages(db), settled);
    });
  }
}

for (const change of ['owner', 'marriage identity', 'rank']) {
  test(`stale ${change} selection consumes no item, character or Crown`, (t) => {
    const { db } = fixture(t);
    const stake = own(db, 1, '101');
    const target = own(db, 2, '202');
    const defense = crown(db, own(db, 3, '202'));
    const { item, action } = prepare(db, 'heart_for_a_heart', { own: stake, targets: [target] });
    if (change === 'rank') db.prepare('UPDATE characters SET rank=50 WHERE id=2').run();
    else {
      assert.equal(divorceCharacter(db, '1', 2, '202', target.marriageId), true);
      own(db, 2, change === 'owner' ? '303' : '202');
    }
    const before = marriages(db);
    assert.equal(activate(db, action).status, 'invalid');
    assert.deepEqual(marriages(db), before);
    assert.deepEqual(getInventory(db, '1', '101'), [item]);
    assert.deepEqual(getCounterfeitCrown(db, '1', '202'), defense);
    assert.deepEqual(reservations(db), []);
  });
}

for (const kind of ['master_key', 'pickpockets_hook', 'sirens_call']) {
  for (const busy of [false, true]) {
    test(`Crown ${busy ? 'preserves busy decoy during' : 'redirects'} legacy ${kind}`, (t) => {
      const { db } = fixture(t);
      own(db, 2, '202');
      const decoy = own(db, 3, '202');
      const defense = crown(db, decoy);
      if (busy) {
        const { action } = hostage(db, decoy, own(db, 4, '303'));
        assert.equal(confirmHostageDelivery(db, action.id, '999', now), true);
      }
      const held = reservations(db);
      grant(db, kind);
      const result = legacy(db, kind);
      assert.equal(result.success, true);
      const expected = busy ? 2 : 3;
      assert.equal(result.character.characterId ?? result.character.character_id, expected);
      assert.deepEqual(getInventory(db, '1', '101'), []);
      assert.deepEqual(reservations(db), held);
      if (kind === 'sirens_call') {
        assert.equal(result.escapeAttempt.characterId, expected);
        assert.equal(db.prepare('SELECT character_id FROM character_rolls WHERE id=?')
          .get(result.escapeAttempt.pendingRollId).character_id, expected);
        assert.equal(getMarriage(db, '1', expected).ownerId, '202');
      } else assert.equal(getMarriage(db, '1', expected).ownerId, '101');
      assert.equal(getMarriage(db, '1', busy ? 3 : 2).ownerId, '202');
      assert.deepEqual(getCounterfeitCrown(db, '1', '202'), busy ? defense : null);
    });
  }
}

test('active Hostage stakes reject legacy ownership/protection changes without spending costs', (t) => {
  const { db } = fixture(t);
  const stake = own(db, 1, '101');
  const target = own(db, 2, '202');
  const { action } = hostage(db, stake, target);
  assert.equal(confirmHostageDelivery(db, action.id, '999', now), true);
  const before = marriages(db);
  const held = reservations(db);
  for (const kind of ['master_key', 'pickpockets_hook', 'sirens_call']) grant(db, kind, '303');
  for (const choice of [stake, target]) {
    assert.equal(divorceCharacter(db, '1', choice.characterId, choice.ownerId, choice.marriageId), false);
    for (const kind of ['master_key', 'pickpockets_hook', 'sirens_call']) {
      const inventory = getInventory(db, '1', '303');
      const result = legacy(db, kind, '303', choice.ownerId, choice === stake ? 'Stake' : 'Original');
      assert.equal(result.success, false);
      assert.ok(!result.blocked, 'reservation refusal must not charge as a blocked attack');
      assert.deepEqual(getInventory(db, '1', '303'), inventory);
    }
    const item = grant(db, 'aegis_of_fidelity', choice.ownerId);
    assert.equal(executeItemUse(db, '1', choice.ownerId, 'aegis_of_fidelity',
      [choice === stake ? 'Stake' : 'Original'], { now }).success, false);
    assert.deepEqual(getInventory(db, '1', choice.ownerId), [item]);
    assert.equal(isCharacterLocked(db, '1', choice.characterId, now).locked, false);
  }
  assert.deepEqual(marriages(db), before);
  assert.deepEqual(reservations(db), held);
  assert.equal(getItemAction(db, action.id).state, 'active');
  own(db, 4, '202');
  assert.equal(executeItemUse(db, '1', '202', 'aegis_of_fidelity', ['Other'], { now }).success, true,
    'reservation must not freeze unrelated characters');
  assert.equal(resolveHostage(db, { actionId: action.id, guildId: '1', userId: '202',
    choice: 'exchange', now, random: noDraw }).status, 'resolved');
  assert.equal(getMarriage(db, '1', 1).ownerId, '202');
  assert.equal(getMarriage(db, '1', 2).ownerId, '101');
  assert.deepEqual(reservations(db), []);
});
