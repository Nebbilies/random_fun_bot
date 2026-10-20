import { ALL_ITEMS } from './items/index.js';

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

export function rollVaultOutcome(tierRandom = Math.random, itemRandom = Math.random) {
  const draw = tierRandom();
  let selectedTier = 'common';

  // 60% common, 20% rare (0.60 - 0.80), 15% epic (0.80 - 0.95), 5% legendary (0.95 - 1.0)
  if (draw >= 0.95) {
    selectedTier = 'legendary';
  } else if (draw >= 0.80) {
    selectedTier = 'epic';
  } else if (draw >= 0.60) {
    selectedTier = 'rare';
  } else {
    selectedTier = 'common';
  }

  const tierItems = getItemsInTier(selectedTier);
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
