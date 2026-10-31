import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { installEmptyFinalCatalog, validateFinalCatalogSchema } from '../lib/catalogFinalSchema.js';
import { getMarriage, marryCharacter } from '../lib/characterMarriage.js';
import { swapCharacters } from '../lib/characterTrade.js';
import { getLatestOwnershipLoss } from '../lib/characterOwnershipHistory.js';
import { claimRoll, getClaimStatus, getRoll, publishRoll, reserveRoll } from '../lib/characterRolls.js';
import { addItemToInventory, getInventory } from '../lib/itemStorage.js';
import { getItemAction } from '../lib/itemActionStorage.js';
import { activateItemAction, confirmHostageDelivery, createItemAction, resolveHostage } from '../lib/itemActions.js';

const start = 1_800_000_000_000;
const ids = Array.from({ length: 6 }, (_, i) => `${String(i + 1).padStart(8, '0')}-1111-4111-8111-111111111111`);

// No legacy migration, external catalog, Discord client, or on-disk database.
function fixture(t) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  installEmptyFinalCatalog(db);
  ids.forEach((id, i) => {
    db.prepare('INSERT INTO character_identities(id) VALUES(?)').run(id);
    db.prepare(`INSERT INTO characters(id,rank,favourites,tie_order,likes_source,name_full,gender)
      VALUES(?,?,1,?,'generated',?,'Female')`).run(id, i + 1, i + 1, `Character ${i + 1}`);
  });
  assert.equal(validateFinalCatalogSchema(db), true);
  t.after(() => {
    try {
      assert.equal(db.isTransaction, false);
      assert.equal(db.prepare('SELECT now_ms FROM ownership_operation_clock').get().now_ms, null);
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    } finally { db.close(); }
  });
  const own = (index, ownerId = '101', guildId = '1') => {
    const marriage = marryCharacter(db, guildId, ids[index], ownerId, start - 1000).marriage;
    return { characterId: ids[index], ownerId, marriageId: marriage.id };
  };
  const create = (kind, selections = {}) => {
    const source = addItemToInventory(db, '1', '101', kind, 1, { now: start }).item;
    assert.ok(source);
    const action = createItemAction(db, { guildId: '1', actorId: '101', channelId: '10',
      inventoryId: source.id, selections, now: start });
    assert.equal(action.state, 'confirming');
    return action;
  };
  const activate = (action, now = start + 10) => activateItemAction(db, {
    actionId: action.id, guildId: '1', actorId: '101', now, random: () => 0,
  });
  return { db, own, create, activate };
}

function loss(db, row, now, guildId = '1') {
  assert.deepEqual({ ...getLatestOwnershipLoss(db, guildId, row.ownerId, row.characterId) }, {
    guildId, formerOwnerId: row.ownerId, characterId: row.characterId, lostAt: now,
  });
}
function noLoss(db) {
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM character_ownership_losses').get().n, 0);
}
function lossCount(db, expected) {
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM character_ownership_losses').get().n, expected);
}
function rejectFinish(db) {
  // Fail after every ownership mutation and source consumption, not before the effect.
  db.exec(`CREATE TRIGGER reject_finish BEFORE UPDATE OF result_json ON item_actions
    BEGIN SELECT RAISE(ABORT,'injected finish failure'); END`);
}

for (const fail of [false, true]) test(`UUID swap records both losses atomically; failure=${fail}`, t => {
  const { db, own } = fixture(t);
  const first = own(0); const second = own(1, '202');
  const before = [getMarriage(db, '1', ids[0]), getMarriage(db, '1', ids[1])];
  const request = { guildId: '1', first, second, now: start + 1234 };
  if (fail) {
    db.exec(`CREATE TRIGGER reject_second BEFORE UPDATE ON marriages WHEN OLD.character_id='${ids[1]}'
      BEGIN SELECT RAISE(ABORT,'injected swap failure'); END`);
    assert.throws(() => swapCharacters(db, request), /injected swap failure/);
    assert.deepEqual([getMarriage(db, '1', ids[0]), getMarriage(db, '1', ids[1])], before);
    noLoss(db);
    db.exec('DROP TRIGGER reject_second');
  }
  assert.equal(swapCharacters(db, request).status, 'traded');
  loss(db, first, request.now); loss(db, second, request.now); lossCount(db, 2);
  assert.equal(getMarriage(db, '1', ids[0]).ownerId, '202');
  assert.equal(getMarriage(db, '1', ids[1]).ownerId, '101');
});

function escape(db) {
  const roll = reserveRoll(db, { guildId: '1', channelId: '10', commandMessageId: '100',
    userId: '101', pool: 'w', now: start, random: () => 0 });
  assert.equal(roll.status, 'reserved');
  assert.equal(roll.character.id, ids[0]);
  assert.equal(roll.escapeOwnerId, '101');
  assert.equal(publishRoll(db, roll.rollId, '500', start), true);
}
function claim(db, userId, now) {
  return claimRoll(db, { guildId: '1', channelId: '10', messageId: '500', userId, now });
}

for (const offset of [0, 60_000]) test(`current owner reclaim at ${offset}ms never records a loss`, t => {
  const { db, own } = fixture(t);
  own(0);
  const before = getMarriage(db, '1', ids[0]);
  escape(db);
  assert.equal(claim(db, '101', start + offset).status, 'reclaimed');
  assert.deepEqual(getMarriage(db, '1', ids[0]), before);
  assert.equal(claim(db, '202', start + 60_001).status, 'closed');
  noLoss(db);
});

for (const fail of [false, true]) test(`escape takeover records only the former owner; failure=${fail}`, t => {
  const { db, own } = fixture(t);
  const former = own(0);
  const before = getMarriage(db, '1', ids[0]);
  escape(db);
  assert.equal(claim(db, '202', start + 59_999).status, 'protected');
  noLoss(db);
  if (fail) {
    db.exec(`CREATE TRIGGER reject_winner BEFORE INSERT ON marriages WHEN NEW.owner_id='202'
      BEGIN SELECT RAISE(ABORT,'injected takeover failure'); END`);
    assert.throws(() => claim(db, '202', start + 60_000), /injected takeover failure/);
    assert.deepEqual(getMarriage(db, '1', ids[0]), before);
    assert.equal(getRoll(db, '1', '10', '500').state, 'open');
    assert.equal(getClaimStatus(db, '1', '202', start + 60_000).canClaim, true);
    noLoss(db);
    db.exec('DROP TRIGGER reject_winner');
  }
  assert.equal(claim(db, '202', start + 60_000).status, 'married');
  loss(db, former, start + 60_000); lossCount(db, 1);
  assert.equal(getMarriage(db, '1', ids[0]).ownerId, '202');
  assert.equal(getLatestOwnershipLoss(db, '1', '202', ids[0]), null);
  assert.equal(claim(db, '303', start + 60_001).status, 'closed');
  loss(db, former, start + 60_000);
});

function actionSetup(f, kind) {
  const { db, own, create } = f;
  let rows;
  let selections;
  if (kind === 'blood_pact') {
    rows = [own(0), own(1), own(2)];
    db.exec("INSERT INTO franchises(id,display_name,created_at) VALUES(1,'Shared','fixture')");
    for (const id of ids.slice(0, 4)) db.prepare('INSERT INTO character_franchise_memberships VALUES(?,1)').run(id);
    selections = { sacrifices: rows };
  } else if (kind === 'grand_masquerade') {
    rows = [own(0), own(1, '202'), own(2, '303'), own(3, '404')];
    selections = { own: rows[0], targets: rows.slice(1) };
  } else {
    // Two eligible marriages per owner; deterministic draw removes the first.
    rows = [own(0), own(1), own(2, '202'), own(3, '202')];
    own(4, '303'); // Rounded-down singleton is unaffected.
    own(5, '404', '2'); // Another guild is unaffected.
    db.prepare('DELETE FROM characters WHERE id=?').run(ids[0]); // Archived ownership counts.
    selections = {};
  }
  return { rows, action: create(kind, selections) };
}

for (const kind of ['blood_pact', 'grand_masquerade', 'kaimetsu']) {
  for (const fail of [false, true]) test(`${kind} UUID action records exact losses and rolls back late failure=${fail}`, t => {
    const f = fixture(t);
    const { db, activate } = f;
    const { rows, action } = actionSetup(f, kind);
    const before = rows.map(row => getMarriage(db, '1', row.characterId));
    const inventory = getInventory(db, '1', '101', start);
    noLoss(db);
    if (fail) {
      rejectFinish(db);
      assert.throws(() => activate(action), /injected finish failure/);
      assert.deepEqual(rows.map(row => getMarriage(db, '1', row.characterId)), before);
      assert.deepEqual(getInventory(db, '1', '101', start + 10), inventory);
      assert.equal(getItemAction(db, action.id).state, 'confirming');
      noLoss(db);
      db.exec('DROP TRIGGER reject_finish');
    }
    const result = activate(action);
    assert.equal(result.status, 'resolved');
    const lost = kind === 'kaimetsu' ? [rows[0], rows[2]] : rows;
    lost.forEach(row => loss(db, row, start + 10));
    lossCount(db, lost.length);
    if (kind === 'grand_masquerade') {
      const owners = rows.map(row => getMarriage(db, '1', row.characterId).ownerId);
      assert.deepEqual([...owners].sort(), ['101', '202', '303', '404']);
      rows.forEach((row, i) => assert.notEqual(owners[i], row.ownerId));
    } else {
      lost.forEach(row => assert.equal(getMarriage(db, '1', row.characterId), null));
      if (kind === 'blood_pact') {
        assert.equal(result.character.id, ids[3]);
        assert.equal(getMarriage(db, '1', ids[3]).ownerId, '101');
      } else {
        assert.equal(result.totalDivorced, 2);
        assert.equal(getMarriage(db, '1', ids[1]).ownerId, '101');
        assert.equal(getMarriage(db, '1', ids[3]).ownerId, '202');
        assert.equal(getMarriage(db, '1', ids[4]).ownerId, '303');
        assert.equal(getMarriage(db, '2', ids[5]).ownerId, '404');
      }
    }
    assert.deepEqual(getInventory(db, '1', '101', start + 10), []);
    activate(action, start + 20);
    lost.forEach(row => loss(db, row, start + 10));
    lossCount(db, lost.length);
  });
}

for (const [choice, draw, loserIndex] of [['exchange', 0, null], ['gamble', 0, 0], ['gamble', 0.999999, 1]]) {
  for (const fail of [false, true]) test(`Hostage ${choice} draw=${draw} records settlement time; failure=${fail}`, t => {
    const { db, own, create, activate } = fixture(t);
    const rows = [own(0), own(1, '202')];
    const before = rows.map(row => getMarriage(db, '1', row.characterId));
    const action = create('hostage_note', { own: rows[0], targets: [rows[1]] });
    assert.equal(activate(action).status, 'awaiting_delivery');
    noLoss(db);
    assert.equal(confirmHostageDelivery(db, action.id, '999', start + 20), true);
    noLoss(db);
    const settle = now => resolveHostage(db, { actionId: action.id, guildId: '1', userId: '202', choice, now, random: () => draw });
    if (fail) {
      rejectFinish(db);
      assert.throws(() => settle(start + 30), /injected finish failure/);
      assert.deepEqual(rows.map(row => getMarriage(db, '1', row.characterId)), before);
      assert.equal(getItemAction(db, action.id).state, 'active');
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM item_character_reservations').get().n, 2);
      noLoss(db);
      db.exec('DROP TRIGGER reject_finish');
    }
    assert.equal(settle(start + 30).status, 'resolved');
    const lost = loserIndex === null ? rows : [rows[loserIndex]];
    lost.forEach(row => loss(db, row, start + 30));
    lossCount(db, lost.length);
    if (loserIndex === null) {
      assert.equal(getMarriage(db, '1', ids[0]).ownerId, '202');
      assert.equal(getMarriage(db, '1', ids[1]).ownerId, '101');
    } else {
      assert.equal(getMarriage(db, '1', rows[loserIndex].characterId), null);
      assert.deepEqual(getMarriage(db, '1', rows[1 - loserIndex].characterId), before[1 - loserIndex]);
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM item_character_reservations').get().n, 0);
    assert.deepEqual(getInventory(db, '1', '101', start + 30), []);
    assert.equal(settle(start + 40).status, 'resolved');
    lost.forEach(row => loss(db, row, start + 30));
    lossCount(db, lost.length);
  });
}
