import { getItemRules } from '../itemRuntimeConfig.js';
import { addActiveBuff } from '../itemStorage.js';

export const engagementRing = {
  id: 'engagement_ring',
  name: 'Engagement Ring',
  tier: 'rare',
  description: 'Cuts your claim cooldown in half (1.5 hours instead of 3 hours) for your next claim.',
  type: 'active',
  maxCharges: 1,

  execute({ db, guildId, userId }) {
    const rules = getItemRules(db, guildId, 'engagement_ring');
    addActiveBuff(db, guildId, userId, 'engagement_ring', JSON.stringify(rules), null, rules.claims);
    return { success: true, message: `Engagement Ring activated! Your next ${rules.claims} claim cooldowns have a ${rules.cooldownMultiplier}x multiplier.` };
  },
};
