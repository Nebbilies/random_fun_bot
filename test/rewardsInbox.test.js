import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { initItemStorage, addItemToInventory, getInventory, removeItemFromInventory } from '../lib/itemStorage.js';
import { initVaultRewards, revealVaultReward, getVaultReward, decideVaultReward, listRecipientPendingItemRewards } from '../lib/vaultRewards.js';
import { settleInboxReward, onVaultInteraction } from '../lib/vaultRuntime.js';
import { getItemsInTier, ITEM_TIERS } from '../lib/itemRoster.js';
import { run, inboxPayload } from '../commands/rewards.js';

const canonical = { guildId: '1', userId: '101', channelId: 'original-channel', messageId: 'original-card' };
const inboxScope = { ...canonical, channelId: 'inbox-channel', messageId: 'inbox-card' };
function fixture(t) {
  const db = new DatabaseSync(':memory:');
  initItemStorage(db); initVaultRewards(db);
  db.exec('CREATE TABLE IF NOT EXISTS item_action_costs(action_id TEXT, inventory_id INTEGER UNIQUE, snapshot_json TEXT)');
  t.after(() => db.close());
  return db;
}
function fill(db) { for (let n = getInventory(db, '1', '101').length; n < 5; n++) addItemToInventory(db, '1', '101', 'four_leaf_clover'); }
function reward(db, id = 'reward', tier = 'epic', extra = {}) {
  return revealVaultReward(db, { vaultId: id, ...canonical,
    outcome: { tier, tierData: ITEM_TIERS[tier], item: getItemsInTier(tier)[0] }, ...extra });
}
function interaction(scope = inboxScope) {
  return { guildId: scope.guildId, user: { id: scope.userId }, channelId: scope.channelId, message: { id: scope.messageId } };
}
const text = payload => JSON.stringify(payload);
function transport(db) {
  let output;
  const collector = Object.assign(new EventEmitter(), { stop: () => collector.emit('end') });
  const reply = { id: inboxScope.messageId, edit: async p => { output = p; }, createMessageComponentCollector: () => collector };
  const ctx = { args: ['rewards'], prefix: '!', yoshiko: { catalogDb: db }, message: {
    guildId: '1', channelId: inboxScope.channelId, author: { id: '101' }, reply: async p => { output = p; return reply; } } };
  return { ctx, collector, reply, payload: () => output };
}
async function click(mock, id, extras = {}) {
  const responses = [];
  const i = { ...interaction(), customId: id, deferUpdate: async () => {},
    reply: async p => responses.push(p), followUp: async p => responses.push(p), ...extras };
  for (const handler of mock.collector.listeners('collect')) await handler(i);
  return responses;
}

test('inbox renders one saved reward per page with palette rarity emoji/text; empty excludes settled transport', t => {
  const db = fixture(t); fill(db);
  const a = reward(db, 'a', 'common'), b = reward(db, 'b', 'legendary');
  reward(db, 'foreign', 'rare', { userId: '202' });
  const pending = listRecipientPendingItemRewards(db, '1', '101');
  assert.deepEqual(pending.map(r => r.vaultId), ['a', 'b']);
  const first = inboxPayload(db, pending, 0).components[0].toJSON();
  assert.equal(first.accent_color, ITEM_TIERS.common.color);
  assert.match(text(first), new RegExp(ITEM_TIERS.common.name));
  assert.ok(text(first).includes(ITEM_TIERS.common.emoji));
  assert.match(text(first), /1 \/ 2/);
  assert.match(text(first), /Source: Mystery vault/);
  assert.match(text(first), /Pending since/);
  assert.ok(text(first).includes(a.reward.item.name));
  assert.ok(!text(first).includes(b.reward.item.name));
  assert.equal(inboxPayload(db, pending, 1).components[0].toJSON().accent_color, ITEM_TIERS.legendary.color);
  for (const r of pending) decideVaultReward(db, { ...canonical, vaultId: r.vaultId, action: 'decline' });
  assert.match(text(inboxPayload(db, listRecipientPendingItemRewards(db, '1', '101'))), /inbox is empty/);
});

test('strict inbox owner/guild/channel/message and canonical linkage reject without mutation', async t => {
  const db = fixture(t); fill(db); const displayed = reward(db);
  for (const key of ['userId', 'guildId', 'channelId', 'messageId']) {
    assert.equal((await settleInboxReward(db, interaction({ ...inboxScope, [key]: 'forged' }),
      { inboxScope, reward: displayed, action: 'decline' })).status, 'forbidden');
  }
  for (const key of ['guildId', 'userId', 'channelId', 'messageId']) {
    assert.equal((await settleInboxReward(db, interaction(),
      { inboxScope, reward: { ...displayed, [key]: 'forged' }, action: 'decline' })).status, 'forbidden');
  }
  assert.equal(getVaultReward(db, 'reward').state, 'overflow');
  assert.equal(getVaultReward(db, 'reward').messageId, canonical.messageId);
  db.prepare("UPDATE vault_rewards SET message_id='replacement-card' WHERE vault_id='reward'").run();
  assert.equal((await settleInboxReward(db, interaction(), { inboxScope, reward: displayed, action: 'decline' })).status, 'forbidden');
  assert.equal(getVaultReward(db, 'reward').state, 'overflow');
});

test('empty command sends one empty inbox without a collector', async t => {
  const db = fixture(t), mock = transport(db);
  let collectors = 0;
  mock.reply.createMessageComponentCollector = () => { collectors++; return mock.collector; };
  await run(mock.ctx);
  assert.match(text(mock.payload()), /inbox is empty/);
  assert.equal(collectors, 0);
});

test('full accept stays pending, space accept settles exactly once and old public controls are harmless', async t => {
  const db = fixture(t); fill(db); const displayed = reward(db);
  assert.equal((await settleInboxReward(db, interaction(), { inboxScope, reward: displayed, action: 'accept' })).reward.state, 'overflow');
  removeItemFromInventory(db, getInventory(db, '1', '101')[0].id);
  assert.equal((await settleInboxReward(db, interaction(), { inboxScope, reward: displayed, action: 'accept' })).reward.state, 'delivered');
  assert.equal((await settleInboxReward(db, interaction(), { inboxScope, reward: displayed, action: 'accept' })).status, 'stale');
  const replies = [];
  await onVaultInteraction(db, { ...interaction(canonical), customId: 'vault:reward:replace', values: ['-1'],
    isButton: () => false, isStringSelectMenu: () => true, reply: async p => replies.push(p) });
  assert.equal(getVaultReward(db, 'reward').state, 'delivered');
  assert.equal(getInventory(db, '1', '101').length, 5);
  assert.match(text(replies), /stale/);
  assert.equal(getVaultReward(db, 'reward').messageId, canonical.messageId);
});

test('private replacement route rejects foreign/escrow entries, replaces once; old canonical settlement wins race', async t => {
  const db = fixture(t); fill(db); const displayed = reward(db);
  const entry = getInventory(db, '1', '101')[0];
  const foreign = addItemToInventory(db, '1', 'other', 'four_leaf_clover').item;
  const replace = inventoryId => settleInboxReward(db, interaction(), { inboxScope, reward: displayed, action: 'replace', inventoryId });
  assert.equal((await replace(foreign.id)).status, 'invalid_inventory');
  db.prepare('INSERT INTO item_action_costs VALUES(?,?,?)').run('held', entry.id, '{}');
  assert.equal((await replace(entry.id)).status, 'invalid_inventory');
  db.prepare('DELETE FROM item_action_costs').run();
  assert.equal((await replace(entry.id)).reward.state, 'delivered');
  assert.equal((await replace(entry.id)).status, 'stale');
  assert.equal(getInventory(db, '1', '101').length, 5);
  const other = reward(db, 'other');
  decideVaultReward(db, { ...canonical, vaultId: 'other', action: 'decline' });
  const before = text(getInventory(db, '1', '101'));
  assert.equal((await settleInboxReward(db, interaction(), { inboxScope, reward: other, action: 'replace',
    inventoryId: getInventory(db, '1', '101')[0].id })).status, 'stale');
  assert.equal(text(getInventory(db, '1', '101')), before);
});

test('decision/recast/unbound restrictions never implicitly choose even overdue or accept forged gamble', async t => {
  const db = fixture(t);
  addItemToInventory(db, '1', '101', 'double_or_nothing'); fill(db);
  const displayed = reward(db, 'decision', 'common');
  assert.equal(displayed.state, 'decision');
  for (const state of ['decision', 'recast']) {
    db.prepare('UPDATE vault_rewards SET state=? WHERE vault_id=?').run(state, displayed.vaultId);
    for (const action of ['accept', 'decline', 'replace', 'gamble', 'keep']) {
      const result = await settleInboxReward(db, interaction(), { inboxScope, reward: displayed, action,
        now: () => displayed.deadline + 100 });
      assert.ok(['stale', 'forbidden'].includes(result.status));
      assert.equal(getVaultReward(db, displayed.vaultId).state, state);
    }
    assert.match(text(inboxPayload(db, [getVaultReward(db, displayed.vaultId)])), /Resume/);
    assert.doesNotMatch(text(inboxPayload(db, [getVaultReward(db, displayed.vaultId)])), /rewards:decline/);
  }
  db.prepare("UPDATE vault_rewards SET state='overflow',message_id=NULL WHERE vault_id=?").run(displayed.vaultId);
  const unbound = getVaultReward(db, displayed.vaultId);
  assert.equal((await settleInboxReward(db, interaction(), { inboxScope, reward: unbound, action: 'decline' })).status, 'forbidden');
  assert.match(text(inboxPayload(db, [unbound])), /publication pending/);
});

test('command pagination, owner checks, explicit decline, space accept, and expiration', async t => {
  const db = fixture(t); fill(db); reward(db, 'a'); reward(db, 'b', 'legendary');
  const mock = transport(db); await run(mock.ctx);
  assert.match(text(mock.payload()), /1 \/ 2/);
  for (const extras of [{ user: { id: '202' } }, { guildId: '2' }, { channelId: 'elsewhere' }, { message: { id: 'elsewhere' } }]) {
    assert.match(text(await click(mock, 'rewards:next', extras)), /Only the command author/);
    assert.match(text(mock.payload()), /1 \/ 2/);
  }
  await click(mock, 'rewards:next'); assert.match(text(mock.payload()), /2 \/ 2/);
  await click(mock, 'rewards:decline:a'); assert.equal(getVaultReward(db, 'a').state, 'overflow');
  await click(mock, 'rewards:decline:b'); assert.equal(getVaultReward(db, 'b').state, 'declined');
  removeItemFromInventory(db, getInventory(db, '1', '101')[0].id);
  await click(mock, 'rewards:prev'); assert.match(text(mock.payload()), /rewards:accept:a/);
  mock.collector.emit('end'); await Promise.resolve();
  await click(mock, 'rewards:accept:a'); assert.equal(getVaultReward(db, 'a').state, 'overflow');
  const resumed = transport(db); await run(resumed.ctx); await click(resumed, 'rewards:accept:a');
  assert.match(text(resumed.payload()), /inbox is empty/);
});

for (const presentationFails of [false, true]) test(`Manage uses the interaction editor and refreshes the inbox even if private presentation fails: ${presentationFails}`, async t => {
  const db = fixture(t); fill(db); reward(db);
  const mock = transport(db); await run(mock.ctx);
  let privatePayload;
  const chooser = Object.assign(new EventEmitter(), { stop: () => chooser.emit('end') });
  t.mock.method(console, 'error', () => {});
  const privateReply = { id: 'private', edit: async () => assert.fail('Ephemeral messages require interaction.editReply'), createMessageComponentCollector: () => chooser };
  const responses = await click(mock, 'rewards:manage:reward', { fetchReply: async () => privateReply,
    editReply: async p => { privatePayload = p; if (presentationFails) throw new Error('Expired webhook'); } });
  assert.ok(responses[0].flags & 64);
  assert.match(text(responses), /rewardreplace:choose/);
  const entry = getInventory(db, '1', '101')[0];
  const select = async (extras = {}) => {
    const errors = [];
    const choice = { ...interaction({ ...inboxScope, messageId: 'private' }), customId: 'rewardreplace:choose',
      values: [String(entry.id)], deferUpdate: async () => {}, reply: async p => errors.push(p), followUp: async p => errors.push(p), ...extras };
    for (const handler of chooser.listeners('collect')) await handler(choice);
    return errors;
  };
  for (const extras of [{ user: { id: '202' } }, { guildId: '2' }, { channelId: 'elsewhere' }, { message: { id: 'inbox-card' } }]) {
    assert.match(text(await select(extras)), /Only the command author/);
  }
  assert.deepEqual(await select(), []);
  assert.equal(getVaultReward(db, 'reward').state, 'delivered');
  assert.match(text(privatePayload), /no longer pending/);
  assert.match(text(mock.payload()), /inbox is empty/);
  await select(); assert.equal(getInventory(db, '1', '101').length, 5);
});
