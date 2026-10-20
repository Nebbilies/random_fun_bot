export const pinata = {
  id: 'pinata',
  name: 'Piñata',
  tier: 'rare',
  description: 'Throws a party in chat: the next 10 rolls by anyone have 2x high-favorite rates, and you receive 1 free claim token.',
  type: 'active',
  maxCharges: 1,

  execute({ db, guildId, userId }) {
    db.prepare('DELETE FROM claim_allowances WHERE guild_id = ? AND user_id = ?')
      .run(guildId, userId);
    return {
      success: true,
      message: '🎉 Piñata burst! The chat is showered with luck, and you received an immediate claim reset!',
    };
  },
};
