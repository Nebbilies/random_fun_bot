import { ALL_ITEMS } from './items/index.js';
import { getGameConfig } from './gameConfig.js';
import { getItemRules } from './itemRuntimeConfig.js';
import { formatDuration } from './itemDuration.js';

export const ITEM_TIERS = Object.freeze({
  common: Object.freeze({
    id: 'common',
    name: 'Common',
    chance: 0.599,
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
  '???': Object.freeze({
    id: '???',
    name: '???',
    chance: 0.001,
    color: 0x000000,
    emoji: '⚫',
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
    aegis_of_fidelity: `Soulbinds one character you own for ${formatDuration(rules.protectionMs)}, protecting them from theft, escape attempts, and forced divorce.`,
    chronicle_of_return: `Choose and confirm an available unowned character you lost in this server within the last ${rules.historyWindowMs / 86_400_000} days. Creates fresh ownership without spending or resetting your normal claim. Only losses recorded since this feature was introduced count.`,
    threadbreaker: `Choose a franchise. Starting with the **highest rank *number***, divorce each owned character. Consecutive characters with the same owner have a ${Number((rules.divorceChance * 100).toFixed(6))}% chance of divorce. The first spared character ends the chain. Actively soulbound characters are skipped.`,
    bag_of_holding: `Permanently adds up to ${rules.capacityIncrease} inventory slots, up to the server limit of ${config.capacity.inventoryMax}. Existing slots are kept.`,
    four_leaf_clover: `Boosts character selection for your next ${rules.rolls} qualifying rolls (rank #${rules.maxRank} or better). Franchise Passport rolls do not use up this boost. Uses the normal pool if no boosted characters are available.`,
    rolling_fever: `For your next ${rules.rolls} character rolls, rolling a character ranked #${rules.maxRank} or better refunds up to ${rules.refundRolls} rolls already used this hour.`,
    adrenaline_rush: `Multiplies your hourly roll allowance by ${rules.allowanceMultiplier}x for ${rules.durationMs / 60000} minutes after activation.`,
    pinata: `Boosts character selection for the next ${rules.rolls} qualifying rolls by anyone in this server (rank #${rules.maxRank} or better). You also get ${rules.claimTokens} personal extra claim token${rules.claimTokens === 1 ? ' that bypasses' : 's that bypass'} your claim cooldown. Franchise Passport and Four-Leaf Clover rolls do not use up the server boost. Uses the normal pool if no boosted characters are available.`,
    engagement_ring: `Reduces the wait for your next ${rules.claims} cooldown-limited claim${rules.claims === 1 ? '' : 's'} to ${rules.cooldownMultiplier * 100}% of the normal claim cooldown.`,
    double_date: `Grants ${rules.freeClaims} free claims for ${rules.durationMs / 60000} minutes after activation, even during your normal claim cooldown. Free claims are used first and do not spend or reset your normal claim or other claim tokens.`,
    franchise_passport: `Selects characters from your chosen franchise for your next ${rules.rolls} qualifying rolls. Uses the normal pool if no eligible characters from that franchise are available.`,
    crown_of_the_sovereign: `Grants you ${rules.claimTokens} extra claim tokens that bypass your claim cooldown.`,
    wish_upon_a_star: `Choose a franchise. Marry a random available unowned character from its top ${rules.topCount} by rank; otherwise marry its best-ranked available unowned character.`,
    blood_pact: `Sacrifice ${rules.sacrificeCount} characters you own from the same franchise to marry its best-ranked available unowned character. A rank upgrade is not guaranteed.`,
    golden_whistle: 'Automatically reclaims your married character if they attempt escape.',
    love_letter: 'Resets your current claim cooldown immediately.',
    hourglass_of_haste: 'Resets your current roll allowance immediately.',
    golden_hour: 'Resets server roll allowances and grants a vault.',
    alchemist: `Consume ${config.itemActions.alchemistCost} Common inventory items to create one Rare-or-better item.`,
    chaos_exchange: `Sacrifice a character you own to marry a random available unowned character with a rank number between ${config.itemActions.chaosMinRankMultiplier}x and ${config.itemActions.chaosMaxRankMultiplier}x theirs.`,
  };
  return { ...item, maxCharges: rules.startingCharges ?? item.maxCharges ?? 1,
    startingCharges: rules.startingCharges ?? item.maxCharges ?? 1,
    rewardEligible: rules.rewardEligible ?? true, rules,
    description: summaries[id] ?? item.description };
}

export function getResolvedItemDefinitions(db, guildId, config = getGameConfig(db, guildId)) {
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

  const itemDraw = itemRandom();
  if (!Number.isFinite(itemDraw) || itemDraw < 0 || itemDraw >= 1) throw new Error('Invalid random value');
  const itemIndex = Math.floor(itemDraw * tierItems.length);

  return {
    tier: selectedTier,
    tierData: ITEM_TIERS[selectedTier],
    item: tierItems[itemIndex],
  };
}
