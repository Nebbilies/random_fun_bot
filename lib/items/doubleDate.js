import { getItemRules } from '../itemRuntimeConfig.js';
import { addActiveBuff } from '../itemStorage.js';

export const doubleDate = {
  id: 'double_date',
  name: 'Double Date',
  tier: 'epic',
  description: 'When you marry a character, your claim cooldown is suspended for 10 minutes, allowing a 2nd claim.',
  type: 'active',
  maxCharges: 1,

  execute({ db, guildId, userId, now = Date.now() }) {
    const rules = getItemRules(db, guildId, 'double_date');
    addActiveBuff(db, guildId, userId, 'double_date', JSON.stringify(rules), now + rules.durationMs, null);
    return { success: true, message: `Double Date activated! For the next ${rules.durationMs / 60000} minutes, marrying a character will not put your claim on cooldown.` };
  },
};
