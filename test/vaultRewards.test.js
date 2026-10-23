import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ITEM_ACTION_CONFIG } from '../lib/itemActionConfig.js';
import { initItemStorage, addItemToInventory, getInventory, getInventoryCapacity, removeItemFromInventory } from '../lib/itemStorage.js';
import { getItemsInTier, ITEM_TIERS } from '../lib/itemRoster.js';
import { initVaultRewards, revealVaultReward, decideVaultReward, getVaultReward, reconcileVaultRewards } from '../lib/vaultRewards.js';

function fixture(path = ':memory:') {
  const db = new DatabaseSync(path);
  initItemStorage(db);
  db.exec('CREATE TABLE IF NOT EXISTS item_action_costs(action_id TEXT, inventory_id INTEGER UNIQUE, snapshot_json TEXT)');
  initVaultRewards(db);
  return db;
}
const scope = { guildId: 'guild', userId: 'roller', channelId: 'channel', messageId: 'prompt' };
function reveal(db, id = 'vault', options = {}) {
  const item = getItemsInTier('common')[0];
  return revealVaultReward(db, { vaultId: id, ...scope, outcome: { tier: 'common', tierData: ITEM_TIERS.common, item }, now: 100, ...options });
}
function decide(db, action, extra = {}) {
  return decideVaultReward(db, { vaultId: 'vault', ...scope, action, now: 101, ...extra });
}
function fill(db) {
  while (getInventory(db, scope.guildId, scope.userId).length < getInventoryCapacity(db, scope.guildId, scope.userId)) {
    addItemToInventory(db, scope.guildId, scope.userId, getItemsInTier('common')[0].id);
  }
}

test('Keep delivers the persisted original once and preserves the gambling entry', () => {
  const db = fixture();
  addItemToInventory(db, scope.guildId, scope.userId, 'double_or_nothing');
  const reward = reveal(db);
  assert.equal(reward.state, 'decision');
  assert.equal(getInventory(db, scope.guildId, scope.userId).length, 1);
  const kept = decide(db, 'keep');
  assert.equal(kept.reward.state, 'delivered');
  assert.equal(kept.reward.result, 'kept');
  assert.ok(getInventory(db, scope.guildId, scope.userId).some(i => i.item_id === 'double_or_nothing'));
  assert.equal(decide(db, 'gamble').status, 'stale');
  assert.equal(getVaultReward(db, reward.vaultId).original.item.id, reward.original.item.id);
  assert.equal(getInventory(db, scope.guildId, scope.userId).length, 2);
  db.close();
});

test('Gamble commits win or loss once, uses freed capacity and never redraws on replay', () => {
  for (const won of [true, false]) {
    const db = fixture();
    addItemToInventory(db, scope.guildId, scope.userId, 'double_or_nothing');
    fill(db);
    reveal(db);
    let draws = 0;
    const first = decide(db, 'gamble', { random: () => { draws++; return won ? 0 : (1 + ITEM_ACTION_CONFIG.doubleWinChance) / 2; } });
    assert.equal(first.reward.result, won ? 'won' : 'lost');
    assert.equal(first.reward.state, won ? 'delivered' : 'lost');
    if (won) assert.ok(['epic', 'legendary'].includes(first.reward.reward.tier));
    const before = draws;
    assert.equal(decide(db, 'gamble', { random: () => { throw new Error('must not reroll'); } }).status, 'stale');
    assert.equal(draws, before);
    assert.ok(!getInventory(db, scope.guildId, scope.userId).some(i => i.item_id === 'double_or_nothing'));
    db.close();
  }
});

test('missing or escrowed gambling entries reject Gamble without changing the decision deadline', () => {
  const db = fixture();
  const entry = addItemToInventory(db, scope.guildId, scope.userId, 'double_or_nothing').item;
  const reward = reveal(db);
  db.prepare('INSERT INTO item_action_costs VALUES (?, ?, ?)').run('note', entry.id, '{}');
  assert.equal(decide(db, 'gamble').status, 'missing_item');
  assert.equal(getVaultReward(db, 'vault').deadline, reward.deadline);
  db.prepare('DELETE FROM item_action_costs').run();
  removeItemFromInventory(db, entry.id);
  assert.equal(decide(db, 'gamble').status, 'missing_item');
  assert.equal(decide(db, 'keep').reward.result, 'kept');
  db.close();
});

test('overflow survives reopened database and overdue Keep occurs only once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vault-rewards-'));
  const path = join(dir, 'db.sqlite');
  try {
    let db = fixture(path);
    addItemToInventory(db, scope.guildId, scope.userId, 'double_or_nothing');
    fill(db);
    const reward = reveal(db);
    db.close();
    db = fixture(path);
    reconcileVaultRewards(db, { now: reward.deadline });
    assert.equal(getVaultReward(db, 'vault').state, 'overflow');
    reconcileVaultRewards(db, { now: reward.deadline + 1 });
    assert.equal(getInventory(db, scope.guildId, scope.userId).length, getInventoryCapacity(db, scope.guildId, scope.userId));
    const discarded = getInventory(db, scope.guildId, scope.userId)[0];
    assert.equal(decide(db, 'replace', { inventoryId: discarded.id }).reward.state, 'delivered');
    assert.equal(decide(db, 'replace', { inventoryId: discarded.id }).status, 'stale');
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('overflow rejects forged scope, foreign and escrowed discard IDs and repeated decline', () => {
  const db = fixture();
  fill(db);
  assert.equal(reveal(db).state, 'overflow');
  for (const field of ['guildId', 'userId', 'channelId', 'messageId']) {
    assert.equal(decide(db, 'decline', { [field]: 'forged' }).status, 'forbidden');
  }
  const foreign = addItemToInventory(db, 'other', 'other', 'double_or_nothing').item;
  assert.equal(decide(db, 'replace', { inventoryId: foreign.id }).status, 'invalid_inventory');
  const own = getInventory(db, scope.guildId, scope.userId)[0];
  db.prepare('INSERT INTO item_action_costs VALUES (?, ?, ?)').run('note', own.id, '{}');
  assert.equal(decide(db, 'replace', { inventoryId: own.id }).status, 'invalid_inventory');
  assert.equal(decide(db, 'decline').reward.state, 'declined');
  assert.equal(decide(db, 'decline').status, 'stale');
  db.close();
});

test('revealed Double or Nothing cannot enable its own gamble and duplicate reveals keep the first outcome', () => {
  const db = fixture();
  const item = { id: 'double_or_nothing', maxCharges: 1 };
  const reward = reveal(db, 'vault', { outcome: { tier: 'rare', item } });
  assert.equal(reward.state, 'delivered');
  assert.equal(reveal(db).original.item.id, item.id);
  assert.equal(getInventory(db, scope.guildId, scope.userId).length, 1);
  db.close();
});


test('failed reward insertion rolls back the gambling cost and leaves the original decision reusable', () => {
  const db = fixture();
  addItemToInventory(db, scope.guildId, scope.userId, 'double_or_nothing');
  reveal(db);
  db.exec("CREATE TRIGGER reject_reward BEFORE INSERT ON user_inventory BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
  assert.throws(() => decide(db, 'gamble', { random: () => 0 }), /injected failure/);
  assert.equal(getVaultReward(db, 'vault').state, 'decision');
  assert.equal(getInventory(db, scope.guildId, scope.userId)[0].item_id, 'double_or_nothing');
  db.exec('DROP TRIGGER reject_reward');
  assert.equal(decide(db, 'keep').reward.state, 'delivered');
  db.close();
});


test('configured replacement tier partitions choose current roster members with normal charges', () => {
  const entries = Object.entries(ITEM_ACTION_CONFIG.doubleRewardWeights).filter(([, weight]) => weight > 0);
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  let preceding = 0;
  for (const [tier, weight] of entries) {
    const db = fixture();
    addItemToInventory(db, scope.guildId, scope.userId, 'double_or_nothing');
    reveal(db);
    const draws = [0, (preceding + weight / 2) / total, 0];
    const result = decide(db, 'gamble', { random: () => draws.shift() });
    assert.equal(result.reward.reward.tier, tier);
    const definition = getItemsInTier(tier).find(item => item.id === result.reward.reward.item.id);
    assert.ok(definition);
    assert.equal(getInventory(db, scope.guildId, scope.userId)[0].charges, definition.maxCharges ?? 1);
    preceding += weight;
    db.close();
  }
});
