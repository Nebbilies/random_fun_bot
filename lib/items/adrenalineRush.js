import { addActiveBuff } from '../itemStorage.js';

const HOUR = 3_600_000;

export const adrenalineRush = {
  id: 'adrenaline_rush',
  name: 'Adrenaline Rush',
  tier: 'rare',
  description: 'Doubles your hourly roll allowance for your active session.',
  type: 'active',
  maxCharges: 1,

  execute({ db, guildId, userId, now = Date.now() }) {
    addActiveBuff(db, guildId, userId, 'adrenaline_rush', null, now + HOUR, null);
    return { success: true, message: 'Adrenaline Rush activated! Your roll limit is boosted for the next hour.' };
  },
};
