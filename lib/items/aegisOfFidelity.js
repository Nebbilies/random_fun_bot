import { isCharacterBusy, invalidateCharacterCrown } from '../characterAvailability.js';
import { addCharacterLock } from '../itemStorage.js';

export const aegisOfFidelity = {
  id: 'aegis_of_fidelity',
  name: 'Aegis of Fidelity',
  tier: 'legendary',
  description: 'Permanently soulbinds 1 chosen character in your harem—they can never be stolen or attempt escape forever.',
  type: 'targeted_own_character',
  maxCharges: 1,

  execute({ db, guildId, userId, args, now = Date.now() }) {
    const characterNameQuery = args.join(' ').replace(/^["']|["']$/g, '');
    if (!characterNameQuery) {
      return { success: false, message: 'Please specify which character you want to soulbind! Example: `!use aegis "Megumin"`' };
    }

    const character = db.prepare(`
      SELECT m.character_id, c.name_full
      FROM marriages AS m
      JOIN characters AS c ON c.id = m.character_id
      WHERE m.guild_id = ? AND m.owner_id = ? AND LOWER(c.name_full) LIKE ?
    `).get(guildId, userId, `%${characterNameQuery.trim().toLowerCase()}%`);

    if (!character) {
      return { success: false, message: `You do not own a character matching "${characterNameQuery}".` };
    }

    if (isCharacterBusy(db, guildId, character.character_id, now)) {
      return { success: false, message: 'That character is committed to another action.' };
    }
    // Add permanent soulbind lock (null protected_until)
    addCharacterLock(db, guildId, character.character_id, 'soulbind', null);
    invalidateCharacterCrown(db, guildId, character.character_id);

    return {
      success: true,
      character,
      message: `🛡️ **${character.name_full}** has been permanently soulbound with the **Aegis of Fidelity**! They can never be stolen or escape forever.`,
    };
  },
};
