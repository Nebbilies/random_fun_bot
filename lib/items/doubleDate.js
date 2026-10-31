import { getItemRules } from '../itemRuntimeConfig.js';
import { addActiveBuff } from '../itemStorage.js';

export const doubleDate = {
  id: 'double_date',
  name: 'Double Date',
  tier: 'epic',
  description: 'Grants 2 free claims for 10 minutes after activation, even during your normal claim cooldown. Free claims are used first and do not spend or reset your normal claim or other claim tokens.',
  type: 'active',
  maxCharges: 1,

  execute({ db, guildId, userId, now = Date.now() }) {
    const rules = getItemRules(db, guildId, 'double_date');
    addActiveBuff(db, guildId, userId, 'double_date', JSON.stringify(rules), now + rules.durationMs, rules.freeClaims);
    return { success: true, message: `Double Date activated! You have ${rules.freeClaims} free claims for ${rules.durationMs / 60000} minutes, even during your normal cooldown. These are used first without spending or resetting your normal claim or other claim tokens.` };
  },
};
