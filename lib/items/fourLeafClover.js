import { addActiveBuff } from '../itemStorage.js';

export const fourLeafClover = {
  id: 'four_leaf_clover',
  name: 'Four-Leaf Clover',
  tier: 'common',
  description: 'Boosts the chance of rolling top-tier and high-favorite characters for your next 5 rolls.',
  type: 'active',
  maxCharges: 1,

  execute({ db, guildId, userId }) {
    addActiveBuff(db, guildId, userId, 'four_leaf_clover', null, null, 5);
    return { success: true, message: 'Four-Leaf Clover activated! Your next 5 rolls have boosted high-favorite rates.' };
  },
};
