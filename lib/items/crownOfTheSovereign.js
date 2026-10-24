import { getItemRules } from '../itemRuntimeConfig.js';
import { addActiveBuff } from '../itemStorage.js';

export const crownOfTheSovereign = {
  id: 'crown_of_the_sovereign',
  name: 'Crown of the Sovereign',
  tier: 'legendary',
  description: 'Grants 3 instant claim tokens that bypass the 3-hour claim cooldown completely.',
  type: 'active',
  maxCharges: 1,

  execute({ db, guildId, userId }) {
    const rules = getItemRules(db, guildId, 'crown_of_the_sovereign');
    addActiveBuff(db, guildId, userId, 'crown_of_the_sovereign', JSON.stringify(rules), null, rules.claimTokens);
    return { success: true, message: `Crown of the Sovereign equipped! You have ${rules.claimTokens} instant claim tokens that bypass cooldowns.` };
  },
};
