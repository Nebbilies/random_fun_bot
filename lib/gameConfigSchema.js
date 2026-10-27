// Gameplay policy only. No credentials, live player state, or protocol/safety limits.
const itemIds = [
  'fortunes_lens', 'fortunes_recast',
  'hourglass_of_haste', 'love_letter', 'bag_of_holding', 'four_leaf_clover', 'rolling_fever',
  'adrenaline_rush', 'double_date', 'engagement_ring', 'pinata', 'golden_hour',
  'crown_of_the_sovereign', 'pickpockets_hook', 'master_key', 'aegis_of_fidelity',
  'wish_upon_a_star', 'franchise_passport', 'blood_pact', 'golden_whistle', 'mirror_shield',
  'binoculars', 'sirens_call', 'alchemist', 'chaos_exchange', 'counterfeit_crown',
  'double_or_nothing', 'heart_for_a_heart', 'hostage_note', 'severed_fate', 'grand_masquerade', 'kaimetsu',
];

const defaults = {
  rolls: { maxRolls: 7, prankRate: 0.01 },
  schedules: { rollIntervalMs: 3_600_000, claimIntervalMs: 10_800_000,
    dailyIntervalMs: 86_400_000, timezoneOffsetMinutes: 420 },
  windows: { claimMs: 60_000, escapeProtectionMs: 60_000, escapeClaimMs: 60_000, reportMs: 3_600_000 },
  mystery: { enabled: true, oddsAnchors: [
    { rank: 20, chance: 1 }, { rank: 50, chance: 0.8 }, { rank: 100, chance: 0.6 },
    { rank: 200, chance: 0.4 }, { rank: 500, chance: 0.2 }, { rank: 1000, chance: 0.05 },
    { rank: 4000, chance: 0.005 }, { rank: 15000, chance: 0.001 },
  ], introDelayMs: 5000, winnerDelayMs: 3000, wrongChoiceDelayMs: 2000, answerCooldownMs: 3000 },
  mysteryEvents: {
    doors: { enabled: true, weight: 1, durationMs: 30_000 },
    clue_reveal: { enabled: true, weight: 1, durationMs: 90_000, clueIntervalMs: 18_000,
      tagMinRank: 50, genreCount: 2, tagCount: 2, typoShortLength: 5, typoLongLength: 10,
      shortTypos: 0, mediumTypos: 1, longTypos: 2 },
    treasure_hunt: { enabled: false, weight: 1, durationMs: 120_000, clueTimesMs: [0, 40_000, 80_000] },
    greed_chamber: { enabled: true, weight: 1, rounds: 5,
      totals: [1, 3, 6, 10, 15], collapseChances: [0.1, 0.2, 0.3, 0.45, 0.67] },
    deadlock: { enabled: true, weight: 1, rounds: 3 },
    roundTiming: { firstRoundMs: 30_000, laterRoundMs: 20_000, resultMs: 8000 },
  },
  vault: { enabled: true, dropRate: 0.01, openTimeoutMs: 60_000, tierWeights: { common: 59.9, rare: 20, epic: 15, legendary: 5, '???': 0.1 } },
  capacity: { inventoryBase: 5, inventoryMax: 8, wishlist: 7 },
  trades: { stepTimeoutMs: 180_000 },
  controls: { lifetimeMs: 3_600_000 },
  itemActions: { confirmationMs: 60_000, masqueradeConfirmationMs: 180_000, hostageDecisionMs: 60_000, doubleDecisionMs: 30_000,
    doubleWinChance: 0.5, hostageDivorceChance: 0.5,
    alchemistCost: 3, alchemistRewardWeights: { rare: 70, epic: 25, legendary: 5 },
    doubleRewardWeights: { epic: 80, legendary: 20 },
    chaosMinRankMultiplier: 0.5, chaosMaxRankMultiplier: 2,
    masqueradeMinRankMultiplier: 0.4, masqueradeTopRank: 100 },
  items: Object.fromEntries(itemIds.map((id) => [id, { rewardEligible: true, startingCharges: id === 'golden_whistle' ? 3 : 1 }])),
  itemEffects: {
    bag_of_holding: { capacityIncrease: 1 },
    four_leaf_clover: { rolls: 5, minFavourites: 1000, maxRank: 1000 },
    rolling_fever: { rolls: 10, favouritesThreshold: 1000, refundRolls: 2 },
    adrenaline_rush: { durationMs: 3_600_000, allowanceMultiplier: 2 },
    double_date: { durationMs: 600_000 },
    engagement_ring: { claims: 1, cooldownMultiplier: 0.5 },
    pinata: { rolls: 10, claimTokens: 1, minFavourites: 1000, maxRank: 1000 },
    crown_of_the_sovereign: { claimTokens: 3 },
    pickpockets_hook: { protectionMs: 86_400_000 },
    master_key: { protectionMs: 86_400_000 },
    wish_upon_a_star: { topCount: 3 },
    franchise_passport: { rolls: 5 },
    blood_pact: { sacrificeCount: 3 },
  },
};

function deepFreeze(value) {
  for (const child of Object.values(value)) if (child && typeof child === 'object') deepFreeze(child);
  return Object.freeze(value);
}
export const GAME_CONFIG_DEFAULTS = deepFreeze(defaults);
export const GAME_CONFIG_SECTIONS = Object.freeze(Object.keys(defaults));

function entries(value, prefix = '') {
  return Object.entries(value).flatMap(([name, child]) => {
    const key = prefix ? `${prefix}.${name}` : name;
    return child && typeof child === 'object' && !Array.isArray(child) ? entries(child, key) : [[key, child]];
  });
}

// Explicit finite limits also bound portal payloads and resource usage. Arrays are validated separately.
function descriptor(key, value) {
  const common = { key, section: key.split('.')[0], default: value, guild: true,
    activationRequired: key.startsWith('schedules.') };
  if (typeof value === 'boolean') return { ...common, type: 'boolean' };
  if (Array.isArray(value)) return { ...common, type: 'array', maxLength: key.endsWith('oddsAnchors') ? 64 : 20 };
  if (key.endsWith('timezoneOffsetMinutes')) return { ...common, type: 'integer', min: -840, max: 840 };
  if (/Rate$|Chance$|Multiplier$/.test(key) || key.includes('collapseChances')) {
    return { ...common, type: 'number', min: /Multiplier$/.test(key) ? 0.001 : 0,
      max: /Multiplier$/.test(key) && !key.endsWith('cooldownMultiplier') ? 100 : 1 };
  }
  if (/\.chance$/.test(key)) return { ...common, type: 'number', min: 0, max: 1 };
  if (/Weights\.|\.weight$/.test(key)) return { ...common, type: 'number', min: 0, max: 1_000_000 };
  // Stay within Node's signed 32-bit timer range (larger delays fire immediately).
  if (/Ms$/.test(key)) return { ...common, type: 'integer', min: 1, max: 2_147_483_647 };
  return { ...common, type: 'integer', min: /Typos$/.test(key) ? 0 : 1, max: 1_000_000 };
}
export const GAME_CONFIG_REGISTRY = deepFreeze(Object.fromEntries(entries(defaults).map(([key, value]) => [key, descriptor(key, value)])));

export function flattenConfig(value) { return Object.fromEntries(entries(value)); }
export function setConfigPath(target, path, value) {
  const parts = path.split('.');
  let cursor = target;
  for (const part of parts.slice(0, -1)) cursor = cursor[part] ??= {};
  cursor[parts.at(-1)] = structuredClone(value);
}

export function validateConfigValue(key, value) {
  const rule = Object.hasOwn(GAME_CONFIG_REGISTRY, key) ? GAME_CONFIG_REGISTRY[key] : null;
  if (!rule) throw new Error(`Unknown game rule: ${key}`);
  if (rule.type === 'array') {
    if (!Array.isArray(value) || !value.length || value.length > rule.maxLength) throw new Error(`Invalid ${key}`);
    if (key === 'mystery.oddsAnchors') {
      if (value.length < 2) throw new Error('At least two mystery odds anchors required');
      let previous;
      for (const anchor of value) {
        if (!anchor || Object.keys(anchor).sort().join(',') !== 'chance,rank'
          || !Number.isSafeInteger(anchor.rank) || anchor.rank < 1 || anchor.rank > 1_000_000
          || !Number.isFinite(anchor.chance) || anchor.chance <= 0 || anchor.chance > 1
          || (previous && (anchor.rank <= previous.rank || anchor.chance > previous.chance))) {
          throw new Error('Invalid mystery odds anchors');
        }
        previous = anchor;
      }
    } else {
      for (const number of value) {
        if (!Number.isFinite(number) || number < 0 || number > (key.endsWith('collapseChances') ? 1 : 2_592_000_000)
          || (!key.endsWith('collapseChances') && !Number.isSafeInteger(number))) throw new Error(`Invalid ${key}`);
      }
    }
  } else if (rule.type === 'boolean') {
    if (typeof value !== 'boolean') throw new Error(`Invalid ${key}: boolean required`);
  } else if (typeof value !== 'number' || !Number.isFinite(value) || value < rule.min || value > rule.max
    || (rule.type === 'integer' && !Number.isSafeInteger(value))) throw new Error(`Invalid ${key}: out of range`);
  return value;
}

export function validateGameConfig(config) {
  for (const [key, value] of Object.entries(flattenConfig(config))) validateConfigValue(key, value);
  const { mysteryEvents: events, itemActions: actions } = config;
  if (config.capacity.inventoryBase > config.capacity.inventoryMax) throw new Error('Inventory base exceeds maximum');
  if (config.mystery.enabled && !Object.values(events).some((event) => event.enabled && event.weight > 0)) {
    throw new Error('Enabled mysteries require an enabled event with positive weight');
  }
  for (const weights of [config.vault.tierWeights, actions.alchemistRewardWeights, actions.doubleRewardWeights]) {
    if (!Object.values(weights).some((weight) => weight > 0)) throw new Error('Reward weights must have a positive total');
  }
  const itemTiers = {
    common: ['hourglass_of_haste', 'four_leaf_clover', 'binoculars'],
    rare: ['fortunes_lens', 'fortunes_recast', 'love_letter', 'rolling_fever', 'adrenaline_rush', 'engagement_ring', 'pinata', 'golden_whistle', 'sirens_call', 'alchemist', 'chaos_exchange', 'counterfeit_crown', 'double_or_nothing', 'heart_for_a_heart'],
    epic: ['bag_of_holding', 'double_date', 'golden_hour', 'pickpockets_hook', 'mirror_shield', 'blood_pact', 'franchise_passport', 'hostage_note', 'severed_fate'],
    legendary: ['crown_of_the_sovereign', 'master_key', 'aegis_of_fidelity', 'wish_upon_a_star', 'grand_masquerade'],
    '???': ['kaimetsu'],
  };
  for (const [tier, ids] of Object.entries(itemTiers)) {
    if ((config.vault.enabled && config.vault.tierWeights[tier] > 0
      || actions.alchemistRewardWeights[tier] > 0 || actions.doubleRewardWeights[tier] > 0)
      && !ids.some((id) => config.items[id].rewardEligible)) throw new Error(`No eligible rewards in ${tier}`);
  }
  if (actions.chaosMinRankMultiplier > actions.chaosMaxRankMultiplier) throw new Error('Invalid rank selection range');
  const greed = events.greed_chamber;
  if (greed.totals.length !== greed.rounds || greed.collapseChances.length !== greed.rounds) throw new Error('Greed arrays must match round count');
  if (greed.totals.some((total, i) => total < 1 || (i && total < greed.totals[i - 1]))) throw new Error('Greed totals must increase');
  const times = events.treasure_hunt.clueTimesMs;
  if (times.length !== 3 || times[0] !== 0 || times.some((time, i) => time >= events.treasure_hunt.durationMs || (i && time <= times[i - 1]))) throw new Error('Invalid treasure clue times');
  if (events.clue_reveal.clueIntervalMs * 4 >= events.clue_reveal.durationMs) throw new Error('Clues must fit event duration');
  if (events.clue_reveal.typoShortLength > events.clue_reveal.typoLongLength) throw new Error('Invalid typo length range');
  // The existing coordinator has a fixed 180s safety ceiling (not editable policy).
  for (const name of ['doors', 'clue_reveal', 'treasure_hunt']) {
    if (events[name].durationMs > 180_000) throw new Error('Event duration exceeds safety ceiling');
  }
  for (const name of ['greed_chamber', 'deadlock']) {
    if (events.roundTiming.firstRoundMs + (events[name].rounds - 1) * events.roundTiming.laterRoundMs
      + events[name].rounds * events.roundTiming.resultMs > 180_000) throw new Error('Rounds exceed event safety ceiling');
  }
  return config;
}
