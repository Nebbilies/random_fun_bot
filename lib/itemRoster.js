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

export const ITEM_ROSTER = Object.freeze([
  // Common
  {
    id: 'hourglass_of_haste',
    name: 'Hourglass of Haste',
    tier: 'common',
    description: 'Resets your current hourly roll allowance immediately.',
    type: 'active',
    maxCharges: 1,
  },
  {
    id: 'four_leaf_clover',
    name: 'Four-Leaf Clover',
    tier: 'common',
    description: 'Boosts the chance of rolling top-tier and high-favorite characters for your next 5 rolls.',
    type: 'active',
    maxCharges: 1,
  },
  {
    id: 'binoculars',
    name: 'Binoculars',
    tier: 'common',
    description: 'Automatically reveals the correct choice in your next mystery roll minigame.',
    type: 'passive',
    maxCharges: 1,
  },

  // Rare
  {
    id: 'love_letter',
    name: 'Love Letter',
    tier: 'rare',
    description: 'Resets your current 3-hour marriage claim cooldown immediately.',
    type: 'active',
    maxCharges: 1,
  },
  {
    id: 'golden_whistle',
    name: 'Golden Whistle',
    tier: 'rare',
    description: 'Automatically reclaims your married character if they attempt an escape. Has 3 charges.',
    type: 'passive',
    maxCharges: 3,
  },
  {
    id: 'sirens_call',
    name: "Siren's Call",
    tier: 'rare',
    description: "Forces a random character owned by a targeted user to immediately attempt an escape in chat.",
    type: 'targeted_user',
    maxCharges: 1,
  },
  {
    id: 'rolling_fever',
    name: 'Rolling Fever',
    tier: 'rare',
    description: 'For your next 10 rolls, rolling a character with over 1,000 favorites refunds +2 rolls.',
    type: 'active',
    maxCharges: 1,
  },
  {
    id: 'adrenaline_rush',
    name: 'Adrenaline Rush',
    tier: 'rare',
    description: 'Doubles your hourly roll allowance for your active session.',
    type: 'active',
    maxCharges: 1,
  },
  {
    id: 'pinata',
    name: 'Piñata',
    tier: 'rare',
    description: 'Throws a party in chat: the next 10 rolls by anyone have 2x high-favorite rates, and you receive 1 free claim token.',
    type: 'active',
    maxCharges: 1,
  },
  {
    id: 'engagement_ring',
    name: 'Engagement Ring',
    tier: 'rare',
    description: 'Cuts your claim cooldown in half (1.5 hours instead of 3 hours) for your next claim.',
    type: 'active',
    maxCharges: 1,
  },

  // Epic
  {
    id: 'pickpockets_hook',
    name: "Pickpocket's Hook",
    tier: 'epic',
    description: 'Steals a randomly chosen married character from a targeted user in the server.',
    type: 'targeted_user',
    maxCharges: 1,
  },
  {
    id: 'mirror_shield',
    name: 'Mirror Shield',
    tier: 'epic',
    description: 'Passively protects your collection by blocking the next steal attempt targeting you.',
    type: 'passive',
    maxCharges: 1,
  },
  {
    id: 'bag_of_holding',
    name: 'Bag of Holding',
    tier: 'epic',
    description: 'Permanently expands your inventory capacity by +1 slot (max 8).',
    type: 'active',
    maxCharges: 1,
  },
  {
    id: 'double_date',
    name: 'Double Date',
    tier: 'epic',
    description: 'When you marry a character, your claim cooldown is suspended for 10 minutes, allowing a 2nd claim.',
    type: 'active',
    maxCharges: 1,
  },
  {
    id: 'franchise_passport',
    name: 'Franchise Passport',
    tier: 'epic',
    description: 'Your next 5 rolls are guaranteed to be characters from a franchise you specify.',
    type: 'targeted_franchise',
    maxCharges: 1,
  },
  {
    id: 'golden_hour',
    name: 'Golden Hour',
    tier: 'epic',
    description: 'Triggers a 5-minute Happy Hour for the channel: resets hourly rolls for everyone, and grants the host a mystery vault.',
    type: 'active',
    maxCharges: 1,
  },
  {
    id: 'blood_pact',
    name: 'Blood Pact',
    tier: 'epic',
    description: 'Sacrifices 3 characters you own from a franchise to summon 1 unowned character from that franchise with higher rank.',
    type: 'targeted_sacrifice',
    maxCharges: 1,
  },

  // Legendary
  {
    id: 'master_key',
    name: 'Master Key',
    tier: 'legendary',
    description: 'Steals a specifically named married character from any user in the server.',
    type: 'targeted_character',
    maxCharges: 1,
  },
  {
    id: 'wish_upon_a_star',
    name: 'Wish Upon A Star',
    tier: 'legendary',
    description: 'Names a franchise and marries 1 randomly chosen character from the top 3 most favorited characters in that franchise.',
    type: 'targeted_franchise',
    maxCharges: 1,
  },
  {
    id: 'aegis_of_fidelity',
    name: 'Aegis of Fidelity',
    tier: 'legendary',
    description: 'Permanently soulbinds 1 chosen character in your harem—they can never be stolen or attempt escape forever.',
    type: 'targeted_own_character',
    maxCharges: 1,
  },
  {
    id: 'crown_of_the_sovereign',
    name: 'Crown of the Sovereign',
    tier: 'legendary',
    description: 'Grants 3 instant claim tokens that bypass the 3-hour claim cooldown completely.',
    type: 'active',
    maxCharges: 1,
  },
]);

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
