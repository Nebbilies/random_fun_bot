import { addActiveBuff } from '../itemStorage.js';

export const doubleDate = {
  id: 'double_date',
  name: 'Double Date',
  tier: 'epic',
  description: 'When you marry a character, your claim cooldown is suspended for 10 minutes, allowing a 2nd claim.',
  type: 'active',
  maxCharges: 1,

  execute({ db, guildId, userId, now = Date.now() }) {
    addActiveBuff(db, guildId, userId, 'double_date', null, now + 10 * 60 * 1000, null);
    return { success: true, message: 'Double Date activated! For the next 10 minutes, marrying a character will not put your claim on cooldown.' };
  },
};
