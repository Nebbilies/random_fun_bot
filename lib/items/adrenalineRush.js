import { addActiveBuff } from '../itemStorage.js';

import { getItemRules } from '../itemRuntimeConfig.js';

export const adrenalineRush = {
  id: 'adrenaline_rush',
  name: 'Adrenaline Rush',
  tier: 'rare',
  description: 'Doubles your hourly roll allowance for 1 hour after activation.',
  type: 'active',
  maxCharges: 1,

  execute({ db, guildId, userId, now = Date.now() }) {
    const rules = getItemRules(db, guildId, 'adrenaline_rush');
    addActiveBuff(db, guildId, userId, 'adrenaline_rush', JSON.stringify(rules), now + rules.durationMs, null);
    return { success: true, message: `Adrenaline Rush activated! Your roll limit is ${rules.allowanceMultiplier}x for ${rules.durationMs / 60000} minutes.` };
  },
};
