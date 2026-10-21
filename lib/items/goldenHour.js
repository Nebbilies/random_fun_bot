const HOUR = 3_600_000;

export const goldenHour = {
  id: 'golden_hour',
  name: 'Golden Hour',
  tier: 'epic',
  description: 'Resets the hourly rolls of everyone in the server and grants you a mystery vault.',
  type: 'active',
  maxCharges: 1,

  execute({ db, guildId, now = Date.now() }) {
    const period = Math.floor(now / HOUR);
    db.prepare('UPDATE roll_allowances SET used = 0 WHERE guild_id = ? AND period = ?')
      .run(guildId, period);
    return {
      success: true,
      startVault: true,
      message: '⭐ Golden Hour! Everyone in this server has their hourly rolls back, and a mystery vault is opening for you.',
    };
  },
};
