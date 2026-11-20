export const HOSTAGE_MIN_RANK_MULTIPLIER = 0.5;
export const HOSTAGE_TOP_RANK = 100;
export const HOSTAGE_RANK_RULE = `The target's rank number must be at least ${HOSTAGE_MIN_RANK_MULTIPLIER}× yours (rounded up), with no upper limit. Any pair in the top ${HOSTAGE_TOP_RANK} qualifies.`;

export const hostageNote = { id: 'hostage_note', name: 'Hostage Note', tier: 'epic', type: 'item_action', maxCharges: 1, description: `Choose one character you own and one owned by another player. ${HOSTAGE_RANK_RULE} That player must swap them or decline and gamble: their nominated character has a 50% chance of divorce and a 50% chance of staying with them. Your character is never at risk in the gamble. No response means a gamble.` };
