export const loveLetter = {
  id: 'love_letter',
  name: 'Love Letter',
  tier: 'rare',
  description: 'Resets your current 3-hour marriage claim cooldown immediately.',
  type: 'active',
  maxCharges: 1,

  execute({ db, guildId, userId }) {
    db.prepare('DELETE FROM claim_allowances WHERE guild_id = ? AND user_id = ?')
      .run(guildId, userId);
    return { success: true, message: 'Your marriage claim cooldown has been reset! You can marry another character right now.' };
  },
};
