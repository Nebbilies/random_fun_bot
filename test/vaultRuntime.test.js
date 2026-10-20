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
import { getInventory } from '../lib/itemStorage.js';

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
  assert.equal(cardJson.components[2].content, '**Master Key** — Steals a chosen character.');

  // Ensure reply happened BEFORE message:edit
  assert.deepEqual(callSequence, ['interaction:reply', 'message:edit']);

  // Verify item was stored in inventory
  const inv = getInventory(db, guildId, rollerId);
  assert.equal(inv.length, 1);
  assert.equal(inv[0].item_id, 'master_key');

  // Vault buttons on the original card should be disabled
  assert.ok(vaultMsg.message.edits.length > 0);
});
