import { getItemRules } from '../itemRuntimeConfig.js';
import { addActiveBuff } from '../itemStorage.js';

export const pinata = {
  id: 'pinata',
  name: 'Piñata',
  tier: 'rare',
  description: 'Throws a party in chat: the next 10 rolls by anyone have 2x high-favorite rates, and you receive 1 free claim token.',
  type: 'active',
  maxCharges: 1,

  execute({ db, guildId, userId }) {
    const rules = getItemRules(db, guildId, 'pinata');
    // Guild-wide buffs live against an empty user id so every roll in the server sees them.
    addActiveBuff(db, guildId, '', 'pinata', JSON.stringify(rules), null, rules.rolls);
    addActiveBuff(db, guildId, userId, 'pinata_claim_token', JSON.stringify(rules), null, rules.claimTokens);
    return {
      success: true,
      message: `🎉 Piñata burst! The next ${rules.rolls} rolls in this server have boosted rates (minimum favorites ${rules.minFavourites} or rank at most ${rules.maxRank}), and you earned ${rules.claimTokens} free claims!`,
    };
  },
};
