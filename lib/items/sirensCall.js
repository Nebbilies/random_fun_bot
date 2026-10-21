import { isCharacterLocked } from '../itemStorage.js';

export const sirensCall = {
  id: 'sirens_call',
  name: "Siren's Call",
  tier: 'rare',
  description: "Forces a random character owned by a targeted user to immediately attempt an escape in chat.",
  type: 'targeted_user',
  maxCharges: 1,

  execute({ db, guildId, userId, args, random = Math.random, now = Date.now() }) {
    const targetMention = args[0];
    const targetId = targetMention ? targetMention.replace(/[^0-9]/g, '') : null;
    if (!targetId) {
      return { success: false, message: 'Please specify a target user! Example: `!use siren @user`' };
    }
    if (targetId === userId) {
      return { success: false, message: 'You cannot lure your own characters away!' };
    }
    const targetMarriages = db.prepare(`
      SELECT m.id AS marriageId, m.character_id AS characterId, c.name_full
      FROM marriages AS m
      JOIN characters AS c ON c.id = m.character_id
      WHERE m.guild_id = ? AND m.owner_id = ?
      ORDER BY m.character_id
    `).all(guildId, targetId);

    if (!targetMarriages.length) {
      return { success: false, message: `<@${targetId}> does not own any characters to target!` };
    }

    const eligible = targetMarriages.filter((row) => !isCharacterLocked(db, guildId, row.characterId, now).locked);
    if (!eligible.length) {
      return { success: false, message: `All of <@${targetId}>'s characters are protected right now!` };
    }

    const draw = random();
    if (!Number.isFinite(draw) || draw < 0 || draw >= 1) throw new Error('Invalid random value');
    const chosen = eligible[Math.floor(draw * eligible.length)];
    return {
      success: true,
      character: chosen,
      // The command layer opens the real escape attempt with this directive.
      escapeAttempt: { ownerId: targetId, characterId: chosen.characterId, marriageId: chosen.marriageId },
      message: `🌊 The Siren's song lures **${chosen.name_full}**! They are attempting to escape from <@${targetId}>'s harem!`,
    };
  },
};
