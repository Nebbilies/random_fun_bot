import { addActiveBuff } from '../itemStorage.js';

export const rollingFever = {
  id: 'rolling_fever',
  name: 'Rolling Fever',
  tier: 'rare',
  description: 'For your next 10 rolls, rolling a character with over 1,000 favorites refunds +2 rolls.',
  type: 'active',
  maxCharges: 1,

  execute({ db, guildId, userId }) {
    addActiveBuff(db, guildId, userId, 'rolling_fever', null, null, 10);
    return { success: true, message: 'Rolling Fever activated! For your next 10 rolls, characters with over 1,000 favorites refund +2 rolls.' };
  },
};
