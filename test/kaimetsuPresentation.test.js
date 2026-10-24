import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openCatalog } from '../lib/catalogDb.js';
import { getGameConfig, getConfigView, saveConfigSection } from '../lib/gameConfig.js';
import { GAME_CONFIG_DEFAULTS, validateConfigValue } from '../lib/gameConfigSchema.js';
import { ITEM_TIERS, getItemDefinition, rollVaultOutcome, rollResolvedVaultOutcome } from '../lib/itemRoster.js';
import { KAIMETSU_UNDISCOVERED, getDiscoveredItemIds } from '../lib/itemDiscovery.js';
import { guildItemList, itemListComponents, ITEM_LIST_FILTERS } from '../lib/itemList.js';
import { addItemToInventory, decrementItemCharge } from '../lib/itemStorage.js';
import { revealVaultReward, bindVaultRewardMessage, decideVaultReward } from '../lib/vaultRewards.js';
import { recoverVaultRewards, vaultRewardCard } from '../lib/vaultRuntime.js';

const item = getItemDefinition('kaimetsu');
const outcome = { tier: '???', tierData: ITEM_TIERS['???'], item };
const maskedLine = `• **${KAIMETSU_UNDISCOVERED.name}** - ${KAIMETSU_UNDISCOVERED.description}`;
const normalLine = '• **Kaimetsu** - Divorce half the harem of EVERY user.';
function fixture(t) {
  const db = openCatalog(':memory:');
  t.after(() => db.close());
  return db;
}
function save(db, section, values, guildId) {
  return saveConfigSection(db, { section, values, guildId, expectedRevision: getConfigView(db).revision });
}
async function recoveredCard(db, vaultId) {
  const cards = new Map();
  await recoverVaultRewards(db, { channels: { fetch: async () => ({
    messages: { fetch: async id => ({ edit: async payload => cards.set(id, payload.components[0].toJSON()) }) },
  }) } });
  return cards.get(vaultId);
}
function reveal(db, vaultId, guildId = '123') {
  const reward = revealVaultReward(db, { vaultId, guildId, userId: 'roller', channelId: 'channel', outcome });
  bindVaultRewardMessage(db, vaultId, 'channel', vaultId);
  return reward;
}
function decide(db, vaultId, action, inventoryId) {
  return decideVaultReward(db, { vaultId, guildId: '123', userId: 'roller', channelId: 'channel',
    messageId: vaultId, action, inventoryId });
}

test('Kaimetsu roster, literal tier, black rendering and exact spec corruption', () => {
  assert.deepEqual(item, { id: 'kaimetsu', name: 'Kaimetsu', tier: '???', type: 'item_action',
    maxCharges: 1, description: 'Divorce half the harem of EVERY user.' });
  // Compare code points against the approved document, not a duplicated approximation.
  const spec = readFileSync(new URL('../docs/kaimetsu-design.md', import.meta.url), 'utf8');
  const strings = [...spec.matchAll(/```text\r?\n([^]*?)\r?\n```/g)].map(match => match[1]);
  assert.deepEqual(Object.values(KAIMETSU_UNDISCOVERED), strings);
  assert.equal(ITEM_LIST_FILTERS.at(-1), '???');
  const list = itemListComponents([[maskedLine]], 0, '???')[0].toJSON();
  assert.equal(list.accent_color, 0);
  assert.equal(list.components[1].components[0].options.at(-1).label, '???');
  const card = vaultRewardCard(outcome).toJSON();
  assert.equal(card.accent_color, 0);
  assert.equal(card.components[0].content, '# ⚫ ???');
});

test('default distribution totals 100 and reserves exactly 0.1 percent without diluting other tiers', t => {
  const db = fixture(t);
  const weights = { common: 59.9, rare: 20, epic: 15, legendary: 5, '???': 0.1 };
  assert.deepEqual(GAME_CONFIG_DEFAULTS.vault.tierWeights, weights);
  assert.equal(Object.values(weights).reduce((a, b) => a + b, 0), 100);
  assert.equal(getGameConfig(db, '123').vault.dropRate, 0.01);
  // Exhaustively count midpoint draws in 1,000 equal intervals.
  const counts = Object.fromEntries(Object.keys(weights).map(tier => [tier, 0]));
  for (let i = 0; i < 1_000; i++) counts[rollVaultOutcome(() => (i + 0.5) / 1_000, () => 0).tier]++;
  assert.deepEqual(counts, { common: 599, rare: 200, epic: 150, legendary: 50, '???': 1 });
  // Also verify the configured DB-backed path on both sides of every boundary.
  for (const [draw, tier] of [[0, 'common'], [0.59899, 'common'], [0.59901, 'rare'],
    [0.79899, 'rare'], [0.79901, 'epic'], [0.94899, 'epic'],
    [0.94901, 'legendary'], [0.99899, 'legendary'], [0.99901, '???']]) {
    assert.equal(rollResolvedVaultOutcome(db, '123', () => draw, () => 0).tier, tier);
  }
});

test('new tier weights and item settings retain normal runtime configuration and eligibility validation', t => {
  const db = fixture(t);
  assert.equal(validateConfigValue('vault.tierWeights.???', 0.25), 0.25);
  assert.throws(() => validateConfigValue('vault.tierWeights.???', -1));
  assert.throws(() => save(db, 'items', { 'items.kaimetsu.rewardEligible': false }), { code: 'CONFIG_VALIDATION' });
  save(db, 'vault', { 'vault.tierWeights.???': 0 });
  save(db, 'items', { 'items.kaimetsu.rewardEligible': false });
  assert.notEqual(rollResolvedVaultOutcome(db, '123', () => 0.99999, () => 0).tier, '???');
  save(db, 'items', { 'items.kaimetsu.rewardEligible': true }, '123');
  save(db, 'vault', { 'vault.tierWeights.common': 0, 'vault.tierWeights.rare': 0,
    'vault.tierWeights.epic': 0, 'vault.tierWeights.legendary': 0, 'vault.tierWeights.???': 1 }, '123');
  assert.equal(rollResolvedVaultOutcome(db, '123', () => 0, () => 0).item.id, 'kaimetsu');
  assert.equal(getGameConfig(db, 'other').items.kaimetsu.rewardEligible, false);
});

test('pending, declined and recovered vault previews stay corrupted; acquisition reveals guild permanently', async t => {
  const db = fixture(t);
  for (let i = 0; i < 5; i++) addItemToInventory(db, '123', 'roller', 'love_letter');
  const pending = reveal(db, 'declined');
  assert.equal(pending.state, 'overflow');
  assert.equal(pending.reward.item.name, 'Kaimetsu', 'durable reward must retain the real definition');
  assert.deepEqual(guildItemList(db, '123', '???'), [maskedLine]);
  let card = await recoveredCard(db, 'declined');
  assert.equal(card.accent_color, 0);
  assert.equal(card.components[1].content, '# ⚫ ???');
  assert.equal(card.components[2].content, `**${KAIMETSU_UNDISCOVERED.name}** — ${KAIMETSU_UNDISCOVERED.description}`);
  assert.ok(!JSON.stringify(card).includes('Kaimetsu'));
  decide(db, 'declined', 'decline');
  card = await recoveredCard(db, 'declined');
  assert.ok(!JSON.stringify(card).includes('Kaimetsu'));
  assert.equal(getDiscoveredItemIds(db, '123').has('kaimetsu'), false);

  reveal(db, 'accepted');
  const held = db.prepare("SELECT id FROM user_inventory WHERE guild_id='123' AND user_id='roller' LIMIT 1").get();
  assert.equal(decide(db, 'accepted', 'replace', held.id).reward.state, 'delivered');
  card = await recoveredCard(db, 'accepted');
  assert.ok(card.components[0].content.includes('received **Kaimetsu**'));
  assert.equal(card.components[2].content, '**Kaimetsu** — Divorce half the harem of EVERY user.');
  assert.deepEqual(guildItemList(db, '123', '???'), [normalLine]);
  assert.deepEqual(guildItemList(db, '456', '???'), [maskedLine]);
  const copy = db.prepare("SELECT id FROM user_inventory WHERE item_id='kaimetsu'").get();
  decrementItemCharge(db, copy.id);
  assert.deepEqual(guildItemList(db, '123', '???'), [normalLine]);
  // A new pending reward reflects discovery even after the guild has spent every copy.
  addItemToInventory(db, '123', 'roller', 'love_letter');
  assert.equal(reveal(db, 'known').state, 'overflow');
  assert.ok(JSON.stringify(await recoveredCard(db, 'known')).includes('Kaimetsu'));
});

test('direct vault award discovers before announcement and never activates the item', async t => {
  const db = fixture(t);
  assert.equal(reveal(db, 'direct').state, 'delivered');
  assert.equal(db.prepare("SELECT charges FROM user_inventory WHERE item_id='kaimetsu'").get().charges, 1);
  const card = await recoveredCard(db, 'direct');
  assert.ok(card.components[0].content.includes('received **Kaimetsu**'));
  assert.deepEqual(guildItemList(db, '123', '???'), [normalLine]);
  assert.deepEqual(guildItemList(db, '456', '???'), [maskedLine]);
});
