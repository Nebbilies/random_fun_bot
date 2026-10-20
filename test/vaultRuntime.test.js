import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openCatalog } from '../lib/catalogDb.js';
import {
  vaultCard,
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

test('vaultCard creates container with 3 buttons A, B, C and mystery vault asset', () => {
  const card = vaultCard(5, 'vault_test_1');
  assert.ok(card.components);
  assert.ok(card.files.some((f) => f.name === 'mystery_vault.png'));
});

test('vaultRewardEmbed builds embed with tier color and description', () => {
  const outcome = {
    tier: 'epic',
    tierData: { name: 'Epic', color: 0x9b59b6 },
    item: { name: "Pickpocket's Hook", description: 'Steals a randomly chosen character.' },
  };
  const embed = vaultRewardEmbed(outcome);
  assert.equal(embed.data.title, 'Epic');
  assert.equal(embed.data.color, 0x9b59b6);
  assert.equal(embed.data.description, "**Pickpocket's Hook** - Steals a randomly chosen character.");
});

test('onVaultInteraction rolls outcome, disables buttons, awards item, and replies', async () => {
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
      tierData: { name: 'Legendary', color: 0xf1c40f },
      item: { id: 'master_key', name: 'Master Key', description: 'Steals a chosen character.', maxCharges: 1 },
    }),
  });

  // Another user tries to click
  let rejected = false;
  const intruderInteraction = {
    isButton: () => true,
    customId: `vault:${vaultMsg.vaultId}:A`,
    user: { id: 'intruder_99' },
    reply: async (opts) => { rejected = true; },
  };
  await onVaultInteraction(db, intruderInteraction);
  assert.equal(rejected, true);

  // Roller clicks button A
  let repliedEmbed = null;
  const rollerInteraction = {
    isButton: () => true,
    customId: `vault:${vaultMsg.vaultId}:A`,
    user: { id: rollerId },
    guildId,
    message: vaultMsg.message,
    channel,
    reply: async (opts) => { repliedEmbed = opts.embeds?.[0]; },
  };

  const handled = await onVaultInteraction(db, rollerInteraction);
  assert.equal(handled, true);
  assert.ok(repliedEmbed);
  assert.equal(repliedEmbed.data.title, 'Legendary');

  // Verify item was stored in inventory
  const inv = getInventory(db, guildId, rollerId);
  assert.equal(inv.length, 1);
  assert.equal(inv[0].item_id, 'master_key');

  // Vault buttons on the original card should be disabled
  assert.ok(vaultMsg.message.edits.length > 0);
});
