import { ALL_ITEMS } from './items/index.js';
import { getGameConfig } from './gameConfig.js';
import { getItemRules } from './itemRuntimeConfig.js';

export const ITEM_TIERS = Object.freeze({
  common: Object.freeze({
    id: 'common',
    name: 'Common',
    chance: 0.60,
    color: 0x2ecc71,
    emoji: '🟢',
  }),
  rare: Object.freeze({
    id: 'rare',
    name: 'Rare',
    chance: 0.20,
    color: 0x3498db,
    emoji: '🔵',
  }),
  epic: Object.freeze({
    id: 'epic',
    name: 'Epic',
    chance: 0.15,
    color: 0x9b59b6,
    emoji: '🟣',
  }),
  legendary: Object.freeze({
    id: 'legendary',
    name: 'Legendary',
    chance: 0.05,
    color: 0xf1c40f,
    emoji: '🟡',
  }),
});

export const ITEM_ROSTER = ALL_ITEMS;

const itemsById = new Map(ITEM_ROSTER.map((item) => [item.id, item]));
const itemsByTier = new Map(
  Object.keys(ITEM_TIERS).map((tier) => [tier, ITEM_ROSTER.filter((item) => item.tier === tier)])
);

export function getItemDefinition(id) {
  return itemsById.get(id) ?? null;
}

export function getItemsInTier(tier) {
  return itemsByTier.get(tier) ?? [];
}

export function getResolvedItemDefinition(db, guildId, id, config = getGameConfig(db, guildId)) {
  const item = getItemDefinition(id);
  if (!item) return null;
  const rules = getItemRules(db, guildId, id, config);
  const summaries = {
    bag_of_holding: 'Permanently expands inventory; purchased slots are preserved.',
    four_leaf_clover: 'Boosts high-favorite character selection for a limited number of rolls.',
    rolling_fever: 'Refunds rolls when a rolled character exceeds the favorites threshold.',
    adrenaline_rush: 'Temporarily multiplies your roll allowance.',
    pinata: 'Boosts server-wide high-favorite selection and grants free claim tokens.',
    engagement_ring: 'Multiplies claim cooldown for upcoming claims.',
    double_date: 'Temporarily suspends claim cooldown.',
    franchise_passport: 'Guarantees upcoming rolls from a chosen franchise.',
    crown_of_the_sovereign: 'Grants instant claim tokens that bypass cooldown.',
    wish_upon_a_star: 'Marries a random available character from the most-favorited selection in a chosen franchise, with an unowned fallback.',
    blood_pact: 'Sacrifices owned characters sharing a franchise to summon an unowned character from it.',
    golden_whistle: 'Automatically reclaims your married character if they attempt escape.',
    love_letter: 'Resets your current claim cooldown immediately.',
    hourglass_of_haste: 'Resets your current roll allowance immediately.',
    golden_hour: 'Resets server roll allowances and grants a vault.',
    alchemist: 'Consumes Common entries to create a Rare-or-better eligible item; cost and tier weights follow effective action rules.',
  };
  return { ...item, maxCharges: rules.startingCharges ?? item.maxCharges ?? 1,
    startingCharges: rules.startingCharges ?? item.maxCharges ?? 1,
    rewardEligible: rules.rewardEligible ?? true, rules,
    description: summaries[id] ?? item.description };
}

export function getResolvedItemDefinitions(db, guildId) {
  const config = getGameConfig(db, guildId);
  return ITEM_ROSTER.map(item => getResolvedItemDefinition(db, guildId, item.id, config))
    .filter(item => item !== null);
}

export function getRewardItemsInTier(db, guildId, tier) {
  return getResolvedItemDefinitions(db, guildId).filter(item => item.tier === tier && item.rewardEligible);
}

export function rollResolvedVaultOutcome(db, guildId, tierRandom = Math.random, itemRandom = Math.random) {
  return rollVaultOutcome(tierRandom, itemRandom, getGameConfig(db, guildId).vault?.tierWeights,
    getResolvedItemDefinitions(db, guildId));
}

/**
 * @param {() => number} [tierRandom]
 * @param {() => number} [itemRandom]
 * @param {Record<string, number> | null} [weights]
 * @param {ReadonlyArray<(typeof ITEM_ROSTER)[number] & {rewardEligible?: boolean}>} [roster]
 */
export function rollVaultOutcome(tierRandom = Math.random, itemRandom = Math.random, weights = null, roster = ITEM_ROSTER) {
  const draw = tierRandom();
  if (!Number.isFinite(draw) || draw < 0 || draw >= 1) throw new Error('Invalid random value');
  const available = roster.filter(item => item.rewardEligible !== false);
  const entries = Object.entries(weights ?? Object.fromEntries(Object.entries(ITEM_TIERS).map(([id, tier]) => [id, tier.chance])))
    .filter(([tier, weight]) => weight > 0 && available.some(item => item.tier === tier));
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  const lastEntry = entries.at(-1);
  if (!total || !lastEntry) throw new Error('No eligible vault rewards');
  let cursor = draw * total;
  let selectedTier = lastEntry[0];
  for (const [tier, weight] of entries) { cursor -= weight; if (cursor < 0) { selectedTier = tier; break; } }
  const tierItems = available.filter(item => item.tier === selectedTier);
  if (!tierItems.length) {
    throw new Error(`No items defined for tier ${selectedTier}`);
  }

  const itemIndex = Math.min(
    tierItems.length - 1,
    Math.floor(itemRandom() * tierItems.length)
  );

  return {
    tier: selectedTier,
    tierData: ITEM_TIERS[selectedTier],
    item: tierItems[itemIndex],
  };
}
