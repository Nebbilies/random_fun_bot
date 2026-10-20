import { addActiveBuff } from '../itemStorage.js';

export const crownOfTheSovereign = {
  id: 'crown_of_the_sovereign',
  name: 'Crown of the Sovereign',
  tier: 'legendary',
  description: 'Grants 3 instant claim tokens that bypass the 3-hour claim cooldown completely.',
  type: 'active',
  maxCharges: 1,

  execute({ db, guildId, userId }) {
    addActiveBuff(db, guildId, userId, 'crown_of_the_sovereign', null, null, 3);
    return { success: true, message: 'Crown of the Sovereign equipped! You have 3 instant claim tokens that bypass cooldowns.' };
  },
};
