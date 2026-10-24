import { getGameConfig } from './gameConfig.js';

export function getItemActionConfig(db, guildId) {
  return { ...ITEM_ACTION_CONFIG, ...getGameConfig(db, guildId).itemActions };
}

export const ITEM_ACTION_CONFIG = Object.freeze({
  confirmationMs: 60_000,
  hostageDecisionMs: 60_000,
  doubleDecisionMs: 30_000,
  doubleWinChance: 0.5,
  hostageDivorceChance: 0.5,
  alchemistCost: 3,
  chaosMinRankMultiplier: 0.5,
  chaosMaxRankMultiplier: 2,
  masqueradeMinRankMultiplier: 0.4,
  masqueradeMaxRankMultiplier: 2,
  masqueradeTopRank: 100,
  alchemistRewardWeights: { rare: 70, epic: 25, legendary: 5 },
  doubleRewardWeights: { epic: 80, legendary: 20 },
});

export function randomIndex(length, random = Math.random) {
  const draw = random();
  if (!Number.isFinite(draw) || draw < 0 || draw >= 1 || length < 1) throw new Error('Invalid random selection');
  return Math.floor(draw * length);
}

export function weightedTier(weights, random = Math.random) {
  const entries = Object.entries(weights).filter(([, weight]) => weight > 0);
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  const draw = random();
  if (!total || !Number.isFinite(draw) || draw < 0 || draw >= 1) throw new Error('Invalid reward weights or random value');
  let cursor = draw * total;
  for (const [tier, weight] of entries) { cursor -= weight; if (cursor < 0) return tier; }
  return entries.at(-1)?.[0] ?? 'rare';
}
