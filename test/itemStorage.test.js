import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  initItemStorage,
  getInventoryCapacity,
  expandInventoryCapacity,
  getInventory,
  addItemToInventory,
  removeItemFromInventory,
  decrementItemCharge,
  addCharacterLock,
  isCharacterLocked,
  addActiveBuff,
  getActiveBuffs,
  consumeBuffRoll,
} from '../lib/itemStorage.js';

test('inventory capacity defaults to 5 and expands up to 8 max', () => {
  const db = new DatabaseSync(':memory:');
  initItemStorage(db);

  const guildId = '123';
  const userId = '456';

  assert.equal(getInventoryCapacity(db, guildId, userId), 5);

  assert.equal(expandInventoryCapacity(db, guildId, userId), 6);
  assert.equal(expandInventoryCapacity(db, guildId, userId), 7);
  assert.equal(expandInventoryCapacity(db, guildId, userId), 8);
  // Cap at 8
  assert.equal(expandInventoryCapacity(db, guildId, userId), 8);
  assert.equal(getInventoryCapacity(db, guildId, userId), 8);
});

test('adding items respects capacity limit and handles charges', () => {
  const db = new DatabaseSync(':memory:');
  initItemStorage(db);

  const guildId = '123';
  const userId = '456';

  // Add 5 items
  for (let i = 0; i < 5; i++) {
    const res = addItemToInventory(db, guildId, userId, 'hourglass_of_haste', 1);
    assert.equal(res.status, 'added');
  }

  // 6th item should fail (inventory full)
  const fullRes = addItemToInventory(db, guildId, userId, 'love_letter', 1);
  assert.equal(fullRes.status, 'full');

  const inv = getInventory(db, guildId, userId);
  assert.equal(inv.length, 5);

  // Remove first item
  removeItemFromInventory(db, inv[0].id);
  assert.equal(getInventory(db, guildId, userId).length, 4);

  // Add multi-charge item
  const whistle = addItemToInventory(db, guildId, userId, 'golden_whistle', 3);
  assert.equal(whistle.status, 'added');

  // Decrement charge
  const dec1 = decrementItemCharge(db, whistle.item.id);
  assert.equal(dec1.remainingCharges, 2);

  const dec2 = decrementItemCharge(db, whistle.item.id);
  assert.equal(dec2.remainingCharges, 1);

  const dec3 = decrementItemCharge(db, whistle.item.id);
  assert.equal(dec3.remainingCharges, 0);
  assert.equal(dec3.removed, true);

  // Item should be gone now
  const updatedInv = getInventory(db, guildId, userId);
  assert.ok(!updatedInv.some((item) => item.id === whistle.item.id));
});

test('character protection locks handle soulbind and timed locks', () => {
  const db = new DatabaseSync(':memory:');
  initItemStorage(db);

  const guildId = '123';
  const charId = 999;
  const now = 1000000;

  // Add 24h lock
  addCharacterLock(db, guildId, charId, 'theft_cooldown', now + 24 * 3600 * 1000);
  assert.equal(isCharacterLocked(db, guildId, charId, now).locked, true);
  assert.equal(isCharacterLocked(db, guildId, charId, now + 25 * 3600 * 1000).locked, false);

  // Add permanent soulbind
  addCharacterLock(db, guildId, charId, 'soulbind', null);
  assert.equal(isCharacterLocked(db, guildId, charId, now + 100 * 3600 * 1000).locked, true);
  assert.equal(isCharacterLocked(db, guildId, charId, now + 100 * 3600 * 1000).lockType, 'soulbind');
});

test('active buffs track rolls and expiration with stacking', () => {
  const db = new DatabaseSync(':memory:');
  initItemStorage(db);

  const guildId = '123';
  const userId = '456';
  const now = 1000000;

  // Add roll buff: 5 rolls
  addActiveBuff(db, guildId, userId, 'four_leaf_clover', null, null, 5);
  let buffs = getActiveBuffs(db, guildId, userId, now);
  assert.equal(buffs.length, 1);
  assert.equal(buffs[0].remaining_rolls, 5);

  // Stack another 5 rolls of the same buff
  addActiveBuff(db, guildId, userId, 'four_leaf_clover', null, null, 5);
  buffs = getActiveBuffs(db, guildId, userId, now);
  assert.equal(buffs.length, 1);
  assert.equal(buffs[0].remaining_rolls, 10);

  // Consume 1 roll
  consumeBuffRoll(db, buffs[0].id);
  buffs = getActiveBuffs(db, guildId, userId, now);
  assert.equal(buffs[0].remaining_rolls, 9);
});
