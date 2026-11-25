export const hourglassOfHaste = {
  id: "hourglass_of_haste",
  name: "Hourglass of Haste",
  tier: "common",
  description: "**Resets** your current hourly **roll allowance** immediately.",
  type: "active",
  maxCharges: 1,

  execute({ db, guildId, userId, now = Date.now() }) {
    db.prepare(
      `
      UPDATE roll_allowances SET used = 0
      WHERE guild_id = ? AND user_id = ?
    `,
    ).run(guildId, userId);
    return {
      success: true,
      message: "Your hourly rolls have been reset! You can now roll again.",
    };
  },
};
