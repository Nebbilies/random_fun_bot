import { getItemRules } from '../itemRuntimeConfig.js';
import { addActiveBuff } from '../itemStorage.js';

export const pinata = {
  id: 'pinata',
  name: 'Piñata',
  tier: 'rare',
  description: 'Boosts selection of characters ranked #1500 or better for the next 10 qualifying rolls by anyone in this server. You also get 1 personal extra claim token that bypasses your claim cooldown. Franchise Passport and Four-Leaf Clover rolls do not use up the server boost.',
  type: 'active',
  maxCharges: 1,

  execute({ db, guildId, userId }) {
    const rules = getItemRules(db, guildId, 'pinata');
    // Guild-wide buffs live against an empty user id so every roll in the server sees them.
    addActiveBuff(db, guildId, '', 'pinata', JSON.stringify(rules), null, rules.rolls);
    addActiveBuff(db, guildId, userId, 'pinata_claim_token', JSON.stringify(rules), null, rules.claimTokens);
    return {
      success: true,
      message: `🎉 Piñata burst! The next ${rules.rolls} rolls in this server have boosted rates for characters ranked #${rules.maxRank} or better, and you earned ${rules.claimTokens} free claims!`,
    };
  },
};
