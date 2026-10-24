import { getItemRules } from '../itemRuntimeConfig.js';
import { addActiveBuff } from '../itemStorage.js';

export const rollingFever = {
  id: 'rolling_fever',
  name: 'Rolling Fever',
  tier: 'rare',
  description: 'For your next 10 rolls, rolling a character with over 1,000 favorites refunds +2 rolls.',
  type: 'active',
  maxCharges: 1,

  execute({ db, guildId, userId }) {
    const rules = getItemRules(db, guildId, 'rolling_fever');
    addActiveBuff(db, guildId, userId, 'rolling_fever', JSON.stringify(rules), null, rules.rolls);
    return { success: true, message: `Rolling Fever activated! For your next ${rules.rolls} rolls, characters with over ${rules.favouritesThreshold} favorites refund +${rules.refundRolls} rolls.` };
  },
};
