import { addActiveBuff } from '../itemStorage.js';

export const pinata = {
  id: 'pinata',
  name: 'Piñata',
  tier: 'rare',
  description: 'Throws a party in chat: the next 10 rolls by anyone have 2x high-favorite rates, and you receive 1 free claim token.',
  type: 'active',
  maxCharges: 1,

  execute({ db, guildId, userId }) {
    // Guild-wide buffs live against an empty user id so every roll in the server sees them.
    addActiveBuff(db, guildId, '', 'pinata', null, null, 10);
    addActiveBuff(db, guildId, userId, 'pinata_claim_token', null, null, 1);
    return {
      success: true,
      message: '🎉 Piñata burst! The next 10 rolls in this server favour high-favorite characters, and you earned 1 free claim!',
    };
  },
};
