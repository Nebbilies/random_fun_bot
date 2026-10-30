import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createItemAction, updateItemSelection, activateItemAction } from '../lib/itemActions.js';
import { initGameConfig, getConfigView, saveConfigSection } from '../lib/gameConfig.js';
import { initItemStorage, addItemToInventory, getInventory, getInventoryCapacity, expandInventoryCapacity, getActiveBuffs, addActiveBuff, consumeBuffRoll, getGuildBuffs } from '../lib/itemStorage.js';
import { getResolvedItemDefinition, rollResolvedVaultOutcome } from '../lib/itemRoster.js';
import { useRollingFever, useAdrenalineRush } from '../lib/itemEffects.js';
import { initVaultRewards, revealVaultReward, decideVaultReward } from '../lib/vaultRewards.js';

function fixture() {
  const db = new DatabaseSync(':memory:');
  initGameConfig(db); initItemStorage(db); initVaultRewards(db);
  return db;
}
function save(db, section, values, guildId = '123') {
  return saveConfigSection(db, { guildId, section, values, expectedRevision: getConfigView(db, guildId).revision });
}

test('scoped grants resolve charges but never mutate existing entries; disabled rewards remain manually grantable', () => {
  const db = fixture();
  addItemToInventory(db, '123', 'u', 'golden_whistle');
  save(db, 'items', { 'items.golden_whistle.startingCharges': 7, 'items.golden_whistle.rewardEligible': false });
  addItemToInventory(db, '123', 'u', 'golden_whistle');
  addItemToInventory(db, '456', 'u', 'golden_whistle');
  assert.deepEqual(getInventory(db, '123', 'u').map(item => item.charges), [3, 7]);
  assert.equal(getInventory(db, '456', 'u')[0].charges, 3);
  assert.equal(getResolvedItemDefinition(db, '123', 'golden_whistle').rewardEligible, false);
  for (let i = 0; i < 100; i++) assert.notEqual(rollResolvedVaultOutcome(db, '123', () => 0.7, () => i / 100).item.id, 'golden_whistle');
  db.close();
});

test('capacity reductions preserve possessions and earned expansions across base changes', () => {
  const db = fixture();
  assert.equal(expandInventoryCapacity(db, '123', 'u'), 6);
  for (let i = 0; i < 6; i++) addItemToInventory(db, '123', 'u', 'love_letter');
  save(db, 'capacity', { 'capacity.inventoryBase': 2, 'capacity.inventoryMax': 3 });
  assert.equal(getInventory(db, '123', 'u').length, 6);
  assert.equal(getInventoryCapacity(db, '123', 'u'), 3);
  assert.equal(addItemToInventory(db, '123', 'u', 'love_letter').status, 'full');
  save(db, 'capacity', { 'capacity.inventoryBase': 7, 'capacity.inventoryMax': 9 });
  assert.equal(getInventoryCapacity(db, '123', 'u'), 8);
  db.close();
});

test('temporary configured base is not converted into earned Bag slots', () => {
  const db = fixture();
  save(db, 'capacity', { 'capacity.inventoryBase': 7, 'capacity.inventoryMax': 9 });
  assert.equal(expandInventoryCapacity(db, '123', 'u'), 8);
  save(db, 'capacity', { 'capacity.inventoryBase': 3 });
  assert.equal(getInventoryCapacity(db, '123', 'u'), 4);
  initItemStorage(db);
  assert.equal(getInventoryCapacity(db, '123', 'u'), 4);
  db.close();
});

test('legacy absolute capacities migrate once into earned expansions over the historical base', () => {
  const db = new DatabaseSync(':memory:');
  initGameConfig(db);
  db.exec(`CREATE TABLE user_inventory_limits (guild_id TEXT, user_id TEXT, max_slots INTEGER,
    PRIMARY KEY (guild_id, user_id));
    INSERT INTO user_inventory_limits VALUES ('123', 'u', 8)`);
  save(db, 'capacity', { 'capacity.inventoryBase': 3 });
  initItemStorage(db);
  assert.equal(getInventoryCapacity(db, '123', 'u'), 6);
  initItemStorage(db);
  assert.equal(getInventoryCapacity(db, '123', 'u'), 6);
  db.close();
});

test('timed config snapshots activate FIFO with full duration, including a return to an earlier rule', () => {
  const db = fixture();
  const start = 1000000; // Item callers support simulated time, not just wall-clock time.
  useAdrenalineRush(db, '123', 'u', start);
  const old = getActiveBuffs(db, '123', 'u', start)[0];
  const duration = JSON.parse(old.data_json).durationMs;
  save(db, 'itemEffects', { 'itemEffects.adrenaline_rush.allowanceMultiplier': 3 });
  useAdrenalineRush(db, '123', 'u', start + 100);
  assert.deepEqual(getActiveBuffs(db, '123', 'u', start + 100).map(b => b.id), [old.id]);
  save(db, 'itemEffects', { 'itemEffects.adrenaline_rush.allowanceMultiplier': 2 });
  useAdrenalineRush(db, '123', 'u', start + 200);
  // Reinitialization must retain the persisted activation schedule.
  initItemStorage(db);
  const queued = db.prepare('SELECT * FROM active_user_buffs ORDER BY id').all();
  assert.equal(queued.length, 3);
  assert.equal(queued[0].expires_at, start + duration);
  assert.equal(queued[1].starts_at, old.expires_at);
  assert.equal(queued[1].expires_at, old.expires_at + duration);
  assert.equal(queued[2].starts_at, queued[1].expires_at);
  assert.equal(getActiveBuffs(db, '123', 'u', old.expires_at - 1)[0].id, old.id);
  const second = getActiveBuffs(db, '123', 'u', old.expires_at);
  assert.equal(second.length, 1);
  assert.equal(JSON.parse(second[0].data_json).allowanceMultiplier, 3);
  assert.equal(getActiveBuffs(db, '123', 'u', queued[1].expires_at - 1)[0].id, queued[1].id);
  assert.equal(getActiveBuffs(db, '123', 'u', queued[1].expires_at)[0].id, queued[2].id);
  assert.deepEqual(getActiveBuffs(db, '123', 'u', queued[2].expires_at), []);
  db.close();
});

test('legacy active timed buffs stay effective while new snapshots wait for their deadline', () => {
  const db = fixture();
  const start = 1000000;
  // A pre-schedule row has no activation start and must remain immediately active.
  db.prepare(`INSERT INTO active_user_buffs
    (guild_id, user_id, buff_id, data_json, expires_at)
    VALUES ('123', 'u', 'adrenaline_rush', '{"allowanceMultiplier":2,"durationMs":1000}', ?)`)
    .run(start + 500);
  const next = addActiveBuff(db, '123', 'u', 'adrenaline_rush',
    '{"allowanceMultiplier":3,"durationMs":2000}', start + 2000);
  assert.equal(next.starts_at, start + 500);
  assert.equal(next.expires_at, start + 2500);
  assert.equal(JSON.parse(getActiveBuffs(db, '123', 'u', start)[0].data_json).allowanceMultiplier, 2);
  assert.equal(getActiveBuffs(db, '123', 'u', start + 500)[0].id, next.id);
  assert.equal(getActiveBuffs(db, '123', 'u', start + 2499)[0].id, next.id);
  assert.deepEqual(getActiveBuffs(db, '123', 'u', start + 2500), []);
  db.close();
});

test('timed identical tail snapshots stack without crossing distinct queued rules, also guild-wide', () => {
  const db = fixture();
  const start = Date.now();
  const first = addActiveBuff(db, '123', '', 'timed', '{"multiplier":2,"durationMs":1000}', start + 1000);
  const second = addActiveBuff(db, '123', '', 'timed', '{"multiplier":3,"durationMs":1000}', start + 1000);
  const stacked = addActiveBuff(db, '123', '', 'timed', second.data_json, start + 1000);
  assert.equal(stacked.id, second.id);
  assert.equal(stacked.expires_at, first.expires_at + 2000);
  assert.deepEqual(getGuildBuffs(db, '123', start).map(b => b.id), [first.id]);
  assert.deepEqual(getGuildBuffs(db, '123', first.expires_at).map(b => b.id), [second.id]);
  db.close();
});

test('buff activations retain independent strengths and remaining rolls after rule edits', () => {
  const db = fixture();
  useRollingFever(db, '123', 'u');
  save(db, 'itemEffects', { 'itemEffects.rolling_fever.rolls': 4, 'itemEffects.rolling_fever.refundRolls': 7 });
  useRollingFever(db, '123', 'u');
  const buffs = getActiveBuffs(db, '123', 'u');
  assert.deepEqual(buffs.map(buff => buff.remaining_rolls), [10, 4]);
  assert.deepEqual(buffs.map(buff => JSON.parse(buff.data_json).refundRolls), [2, 7]);
  save(db, 'itemEffects', { 'itemEffects.rolling_fever.rolls': 10, 'itemEffects.rolling_fever.refundRolls': 2 });
  useRollingFever(db, '123', 'u');
  assert.deepEqual(getActiveBuffs(db, '123', 'u').map(b => b.remaining_rolls), [10, 4, 10]);
  for (let i = 0; i < 10; i++) consumeBuffRoll(db, buffs[0].id);
  assert.equal(getActiveBuffs(db, '123', 'u').find(b => b.buff_id === 'rolling_fever').id, buffs[1].id);
  assert.equal(getActiveBuffs(db, '123', 'u')[0].remaining_rolls, 4);
  db.close();
});

test('durable item confirmation retains Alchemist cost and reward definitions after config changes', () => {
  const db = fixture();
  const now = 100;
  const source = addItemToInventory(db, '123', 'u', 'alchemist', 2, { now }).item;
  const costs = Array.from({ length: 3 }, () => addItemToInventory(db, '123', 'u', 'hourglass_of_haste', undefined, { now }).item);
  const action = createItemAction(db, { guildId: '123', actorId: 'u', channelId: 'c', inventoryId: source.id, now: 100 });
  save(db, 'itemActions', { 'itemActions.alchemistCost': 4 });
  save(db, 'items', { 'items.alchemist.startingCharges': 7 });
  assert.equal(updateItemSelection(db, action.id, '123', 'u', { inventoryIds: costs.map(item => item.id), _rules: {} }, 101), true);
  const result = activateItemAction(db, { actionId: action.id, guildId: '123', actorId: 'u', now: 102, random: () => 0 });
  assert.equal(result.status, 'resolved');
  const inventory = getInventory(db, '123', 'u', 102);
  assert.equal(inventory.length, 2);
  assert.equal(inventory.find(item => item.id === source.id).charges, 1);
  assert.equal(inventory.find(item => item.id !== source.id).charges, 1);
  db.close();
});

test('durable vault gamble retains reveal odds, deadline, eligibility pools and grant charges', () => {
  const db = fixture();
  addItemToInventory(db, '123', 'u', 'double_or_nothing', undefined, { now: 100 });
  save(db, 'itemActions', { 'itemActions.doubleWinChance': 1 });
  const scope = { vaultId: 'v', guildId: '123', userId: 'u', channelId: 'c', messageId: 'm' };
  const original = rollResolvedVaultOutcome(db, '123', () => 0, () => 0);
  const reward = revealVaultReward(db, { ...scope, outcome: original, now: 100 });
  save(db, 'itemActions', { 'itemActions.doubleWinChance': 0, 'itemActions.doubleDecisionMs': 1000 });
  const result = decideVaultReward(db, { ...scope, action: 'gamble', now: 101, random: () => 0.1 });
  assert.equal(result.reward.result, 'won');
  assert.equal(reward.deadline, 30100);
  assert.equal(getInventory(db, '123', 'u', 101).length, 1);
  db.close();
});
