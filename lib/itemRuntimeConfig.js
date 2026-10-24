import { getGameConfig } from './gameConfig.js';

// Item-local defaults also document snapshots consumed by character roll runtime.
export const ITEM_EFFECT_DEFAULTS = Object.freeze({
  four_leaf_clover: { rolls: 5, minFavourites: 1000, maxRank: 1000 },
  rolling_fever: { rolls: 10, favouritesThreshold: 1000, refundRolls: 2 },
  adrenaline_rush: { durationMs: 3_600_000, allowanceMultiplier: 2 },
  pinata: { rolls: 10, minFavourites: 1000, maxRank: 1000, claimTokens: 1 },
  engagement_ring: { claims: 1, cooldownMultiplier: 0.5 },
  double_date: { durationMs: 600_000 },
  franchise_passport: { rolls: 5 },
  crown_of_the_sovereign: { claimTokens: 3 },
  pickpockets_hook: { protectionMs: 86_400_000 },
  master_key: { protectionMs: 86_400_000 },
  wish_upon_a_star: { topCount: 3 },
  blood_pact: { sacrificeCount: 3 },
  bag_of_holding: { capacityIncrease: 1 },
});

export function getItemRules(db, guildId, itemId, config = getGameConfig(db, guildId)) {
  return { ...ITEM_EFFECT_DEFAULTS[itemId], ...config.itemEffects?.[itemId], ...config.items?.[itemId] };
}

export function describeItemRules(rules) {
  return Object.entries(rules).filter(([key]) => !['startingCharges', 'rewardEligible'].includes(key))
    .map(([key, value]) => `${key}: ${value}`).join(' · ');
}
