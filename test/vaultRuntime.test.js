import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openCatalog } from '../lib/catalogDb.js';
import {
  vaultCard,
  vaultRewardCard,
  vaultRewardEmbed,
  startVaultRoll,
  onVaultInteraction,
} from '../lib/vaultRuntime.js';
import { getInventory, addItemToInventory } from '../lib/itemStorage.js';
import { initVaultRewards, getVaultReward } from '../lib/vaultRewards.js';
import { getItemsInTier, ITEM_TIERS } from '../lib/itemRoster.js';
import { ITEM_ACTION_CONFIG } from '../lib/itemActionConfig.js';

function mockChannel(id = '2001') {
  const sent = [];
  return {
    id,
    sent,
    async send(payload) {
      const messageId = String(1000 + sent.length);
      const item = {
        id: messageId,
        channelId: id,
        payload,
        edits: [],
        components: payload.components || [],
        embeds: payload.embeds || [],
        async edit(change) {
          this.edits.push(change);
          if (change.components) this.components = change.components;
          if (change.embeds) this.embeds = change.embeds;
          return this;
        },
      };
      sent.push(item);
      return item;
    },
  };
}

test('vaultCard creates container with 3 buttons A, B, C and mystery vault asset on send, but omits files on disable', () => {
  const card = vaultCard(5, 'vault_test_1');
  assert.ok(card.components);
  assert.ok(card.files.some((f) => f.name === 'mystery_vault.png'));

  const disabledCard = vaultCard(5, 'vault_test_1', true);
  assert.ok(disabledCard.components);
  assert.equal(disabledCard.files, undefined);
});

test('vaultRewardCard builds container with tier color, large markdown title, and description like roll card', () => {
  const outcome = {
    tier: 'epic',
    tierData: { name: 'Epic', color: 0x9b59b6, emoji: '🟣' },
    item: { name: "Pickpocket's Hook", description: 'Steals a randomly chosen character.' },
  };
  const card = vaultRewardCard(outcome);
  const json = card.toJSON();
  assert.equal(json.type, 17); // ContainerBuilder (Components V2)
  assert.equal(json.accent_color, 0x9b59b6);
  assert.equal(json.components[0].content, '# 🟣 Epic');
  assert.equal(json.components[1].content, "**Pickpocket's Hook** — Steals a randomly chosen character.");
});

test('onVaultInteraction rolls outcome, replies with Components V2 container before editing original message', async () => {
  const db = openCatalog(':memory:');
  initVaultRewards(db);
  const channel = mockChannel();
  const guildId = '1001';
  const rollerId = '3001';

  const vaultMsg = await startVaultRoll({
    db,
    channel,
    guildId,
    rollerId,
    remaining: 4,
    // Provide deterministic outcome
    rollOutcome: () => ({
      tier: 'legendary',
      tierData: { name: 'Legendary', color: 0xf1c40f, emoji: '🟡' },
      item: { id: 'master_key', name: 'Master Key', description: 'Steals a chosen character.', maxCharges: 1 },
    }),
  });

  // Track sequence of execution
  const callSequence = [];
  vaultMsg.message.edit = async (change) => {
    callSequence.push('message:edit');
    vaultMsg.message.edits.push(change);
    return vaultMsg.message;
  };

  // Another user tries to click
  let rejected = false;
  const intruderInteraction = {
    isButton: () => true,
    isStringSelectMenu: () => false,
    customId: `vault:${vaultMsg.vaultId}:A`,
    user: { id: 'intruder_99' },
    reply: async (opts) => { rejected = true; },
  };
  await onVaultInteraction(db, intruderInteraction);
  assert.equal(rejected, true);

  // Roller clicks button A
  let repliedOpts = null;
  const rollerInteraction = {
    isButton: () => true,
    isStringSelectMenu: () => false,
    customId: `vault:${vaultMsg.vaultId}:A`,
    user: { id: rollerId },
    guildId,
    message: vaultMsg.message,
    channel,
    reply: async (opts) => {
      callSequence.push('interaction:reply');
      repliedOpts = opts;
    },
  };

  const handled = await onVaultInteraction(db, rollerInteraction);
  assert.equal(handled, true);
  assert.ok(repliedOpts?.components?.[0]);
  assert.equal(repliedOpts.content, undefined); // In Components V2, text must be inside containers
  const cardJson = repliedOpts.components[0].toJSON();
  assert.equal(cardJson.type, 17); // Container
  assert.equal(cardJson.accent_color, 0xf1c40f);
  assert.match(cardJson.components[0].content, /<@3001> received \*\*Master Key\*\*/);
  assert.equal(cardJson.components[1].content, '# 🟡 Legendary');
  assert.match(cardJson.components[2].content, /\*\*Master Key\*\*.*protectionMs: 86400000/);

  // Ensure reply happened BEFORE message:edit
  assert.deepEqual(callSequence, ['interaction:reply', 'message:edit']);

  // Verify item was stored in inventory
  const inv = getInventory(db, guildId, rollerId);
  assert.equal(inv.length, 1);
  assert.equal(inv[0].item_id, 'master_key');

  // Vault buttons on the original card should be disabled
  assert.ok(vaultMsg.message.edits.length > 0);
});


test('revealed Keep/Gamble prompt is owner/message scoped and timeout keeps through recovery', async () => {
  const db = openCatalog(':memory:');
  initVaultRewards(db);
  addItemToInventory(db, '10001', 'roller', 'double_or_nothing');
  const channel = mockChannel('channel');
  let clock = 100;
  const vault = await startVaultRoll({ db, channel, guildId: '10001', rollerId: 'roller', remaining: 1,
    now: () => clock, rollOutcome: () => ({ tier: 'common', tierData: ITEM_TIERS.common, item: getItemsInTier('common')[0] }) });
  const prompt = { id: 'reward-prompt', channelId: 'channel', edit: async () => prompt };
  const replies = [];
  const interaction = { isButton: () => true, isStringSelectMenu: () => false,
    customId: `vault:${vault.vaultId}:A`, guildId: '10001', channelId: 'channel', channel,
    user: { id: 'roller' }, message: vault.message,
    reply: async p => { replies.push(p); return prompt; }, fetchReply: async () => prompt };
  await onVaultInteraction(db, interaction, { now: () => clock });
  assert.equal(getVaultReward(db, vault.vaultId).state, 'decision');
  const json = replies[0].components[0].toJSON();
  assert.ok(JSON.stringify(json).includes(':gamble'));
  const intruder = { ...interaction, user: { id: 'intruder' }, message: prompt,
    customId: `vault:${vault.vaultId}:keep` };
  await onVaultInteraction(db, intruder, { now: () => clock });
  assert.equal(getVaultReward(db, vault.vaultId).state, 'decision');
  clock += ITEM_ACTION_CONFIG.doubleDecisionMs;
  const { recoverVaultRewards } = await import('../lib/vaultRuntime.js');
  await recoverVaultRewards(db, { channels: { fetch: async () => ({ messages: { fetch: async () => prompt } }) } }, { now: () => clock });
  assert.equal(getVaultReward(db, vault.vaultId).state, 'delivered');
  assert.equal(getInventory(db, '10001', 'roller').length, 2);
  db.close();
});


test('forged legacy replacement controls cannot grant rewards or delete inventory', async () => {
  const db = openCatalog(':memory:');
  initVaultRewards(db);
  const held = addItemToInventory(db, '10001', 'victim', getItemsInTier('common')[0].id).item;
  const replies = [];
  await onVaultInteraction(db, { isButton: () => false, isStringSelectMenu: () => true,
    customId: 'vault:invented:replace:master_key', values: [String(held.id)],
    user: { id: 'attacker' }, guildId: '10001', channelId: 'channel', message: { id: 'forged' },
    reply: async payload => replies.push(payload) });
  assert.equal(getInventory(db, '10001', 'victim')[0].id, held.id);
  assert.equal(getInventory(db, '10001', 'attacker').length, 0);
  assert.equal(replies.length, 1);
  db.close();
});
