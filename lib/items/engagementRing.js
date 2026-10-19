import { addActiveBuff } from '../itemStorage.js';

export const engagementRing = {
  id: 'engagement_ring',
  name: 'Engagement Ring',
  tier: 'rare',
  description: 'Cuts your claim cooldown in half (1.5 hours instead of 3 hours) for your next claim.',
  type: 'active',
  maxCharges: 1,

  execute({ db, guildId, userId }) {
    addActiveBuff(db, guildId, userId, 'engagement_ring', null, null, 1);
    return { success: true, message: 'Engagement Ring activated! Your next claim cooldown will be reduced by 50%.' };
  },
};
