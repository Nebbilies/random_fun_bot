import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openCatalog } from '../lib/catalogDb.js';
import { addItemToInventory, getInventory } from '../lib/itemStorage.js';
import { masterKey } from '../lib/items/masterKey.js';
import { marryCharacter, getMarriage } from '../lib/characterMarriage.js';
import { revealWithBinoculars } from '../lib/mysteryCoordinator.js';
import { cleanupExpiredItems } from '../lib/itemExpiryCleanup.js';
import { createItemAction, activateItemAction } from '../lib/itemActions.js';
import { reserveBinocularsUse, settleBinocularsUse, recoverBinocularsUses } from '../lib/binocularsUse.js';

const start = Date.parse('2030-01-01T00:00:00Z');

test('bounded expiry cleanup retains a started use until it completes', (t) => {
  const db = openCatalog(':memory:');
  t.after(() => db.close());
  const source = addItemToInventory(db, '1', '101', 'kaimetsu', 1, { now: start }).item;
  addItemToInventory(db, '1', '101', 'binoculars', 1, { now: start });
  const action = createItemAction(db, { guildId: '1', actorId: '101', channelId: '10',
    inventoryId: source.id, now: source.expires_at - 1 });
  assert.equal(cleanupExpiredItems(db, { now: source.expires_at, limit: 1 }), 1);
  assert.equal(cleanupExpiredItems(db, { now: source.expires_at }), 0);
  assert.equal(activateItemAction(db, { actionId: action.id, guildId: '1', actorId: '101',
    now: source.expires_at }).status, 'resolved');
});

test('Binoculars reserves before DM and can settle after expiry without a second charge', (t) => {
  const db = openCatalog(':memory:');
  t.after(() => db.close());
  const source = addItemToInventory(db, '1', '101', 'binoculars', 2, { now: start }).item;
  const request = { guildId: '1', userId: '101', channelId: '10', inventoryId: source.id, now: source.expires_at - 1 };
  const hold = reserveBinocularsUse(db, request);
  assert.ok(hold);
  assert.equal(reserveBinocularsUse(db, request), null);
  assert.equal(cleanupExpiredItems(db, { now: source.expires_at }), 0);
  assert.equal(settleBinocularsUse(db, hold, true), true);
  assert.equal(settleBinocularsUse(db, hold, true), false);
  assert.equal(getInventory(db, '1', '101', source.expires_at).length, 0);
  assert.equal(cleanupExpiredItems(db, { now: source.expires_at }), 1);
});

test('Binoculars uncertain interrupted delivery charges once on recovery and never resends', (t) => {
  const db = openCatalog(':memory:');
  t.after(() => db.close());
  const source = addItemToInventory(db, '1', '101', 'binoculars', 2, { now: start }).item;
  reserveBinocularsUse(db, { guildId: '1', userId: '101', channelId: '10', inventoryId: source.id, now: start });
  assert.equal(recoverBinocularsUses(db), 1);
  assert.equal(recoverBinocularsUses(db), 0);
  assert.equal(getInventory(db, '1', '101', start)[0].charges, 1);
});

test('Mirror Shield cannot start a passive defense at its expiry deadline', (t) => {
  const db = openCatalog(':memory:');
  t.after(() => db.close());
  db.exec("INSERT INTO characters (id, rank, favourites, name_full, gender) VALUES (10, 5, 2000, 'Aqua', 'female')");
  marryCharacter(db, '1', 10, '202');
  addItemToInventory(db, '1', '202', 'mirror_shield', 1, { now: start });
  const result = masterKey.execute({ db, guildId: '1', userId: '101', args: ['202', 'Aqua'],
    now: start + 7 * 86_400_000 });
  assert.equal(result.success, true);
  assert.equal(getMarriage(db, '1', 10).ownerId, '101');
});

test('Binoculars availability uses the trigger clock rather than the process clock', (t) => {
  const db = openCatalog(':memory:');
  t.after(() => db.close());
  addItemToInventory(db, '1', '101', 'binoculars', 1, { now: start });
  const session = { guildId: '1', rollerId: '101', eventId: 'doors', stateJson: '{"winningDoor":1}' };
  assert.equal(revealWithBinoculars(db, session, start + 2 * 86_400_000), null);
  assert.equal(getInventory(db, '1', '101', start + 2 * 86_400_000).length, 0);
});
