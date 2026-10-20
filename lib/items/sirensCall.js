export const sirensCall = {
  id: 'sirens_call',
  name: "Siren's Call",
  tier: 'rare',
  description: "Forces a random character owned by a targeted user to immediately attempt an escape in chat.",
  type: 'targeted_user',
  maxCharges: 1,

  execute({ db, guildId, userId, args }) {
    const targetMention = args[0];
    const targetId = targetMention ? targetMention.replace(/[^0-9]/g, '') : null;
    if (!targetId) {
      return { success: false, message: 'Please specify a target user! Example: `!use siren @user`' };
    }
    const targetMarriages = db.prepare(`
      SELECT m.character_id, c.name_full
      FROM marriages AS m
      JOIN characters AS c ON c.id = m.character_id
      WHERE m.guild_id = ? AND m.owner_id = ?
    `).all(guildId, targetId);

    if (!targetMarriages.length) {
      return { success: false, message: `<@${targetId}> does not own any characters to target!` };
    }

    const chosen = targetMarriages[Math.floor(Math.random() * targetMarriages.length)];
    return {
      success: true,
      character: chosen,
      message: `🌊 The Siren's song lures **${chosen.name_full}**! They are attempting to escape from <@${targetId}>'s harem!`,
    };
  },
};
