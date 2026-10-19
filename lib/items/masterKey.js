import {
  getInventory,
  removeItemFromInventory,
  addCharacterLock,
  isCharacterLocked,
} from '../itemStorage.js';

const TWENTY_FOUR_HOURS = 24 * 3_600_000;

export const masterKey = {
  id: 'master_key',
  name: 'Master Key',
  tier: 'legendary',
  description: 'Steals a specifically named married character from any user in the server.',
  type: 'targeted_character',
  maxCharges: 1,

  execute({ db, guildId, userId: attackerId, args, now = Date.now() }) {
    const targetMention = args[0];
    const targetUserId = targetMention ? targetMention.replace(/[^0-9]/g, '') : null;
    const characterNameQuery = args.slice(1).join(' ').replace(/^["']|["']$/g, '');

    if (!targetUserId || !characterNameQuery) {
      return { success: false, message: 'Please specify a target user and character name! Example: `!use masterkey @user "Rem"`' };
    }
    if (attackerId === targetUserId) {
      return { success: false, message: 'You cannot steal from yourself!' };
    }

    // Check Mirror Shield first
    const targetInv = getInventory(db, guildId, targetUserId);
    const mirrorShield = targetInv.find((item) => item.item_id === 'mirror_shield');
    if (mirrorShield) {
      removeItemFromInventory(db, mirrorShield.id);
      return {
        blocked: true,
        blockedBy: 'mirror_shield',
        message: `🛡️ <@${targetUserId}>'s **Mirror Shield** shattered to block the Master Key steal attempt!`,
      };
    }

    const character = db.prepare(`
      SELECT m.character_id, c.name_full
      FROM marriages AS m
      JOIN characters AS c ON c.id = m.character_id
      WHERE m.guild_id = ? AND m.owner_id = ? AND LOWER(c.name_full) LIKE ?
    `).get(guildId, targetUserId, `%${characterNameQuery.trim().toLowerCase()}%`);

    if (!character) {
      return { success: false, message: `Could not find a character matching "${characterNameQuery}" owned by <@${targetUserId}>.` };
    }

    // Check locks
    const lock = isCharacterLocked(db, guildId, character.character_id, now);
    if (lock.locked) {
      return {
        blocked: true,
        blockedBy: lock.lockType,
        message: `🔒 **${character.name_full}** is protected by ${lock.lockType === 'soulbind' ? 'an **Aegis of Fidelity** soulbind' : 'a theft cooldown lock'} and cannot be stolen!`,
      };
    }

    // Transfer ownership atomically
    db.prepare(`
      UPDATE marriages SET owner_id = ?, married_at = ?
      WHERE guild_id = ? AND character_id = ?
    `).run(attackerId, new Date(now).toISOString(), guildId, character.character_id);

    // Apply 24h theft lock
    addCharacterLock(db, guildId, character.character_id, 'theft_cooldown', now + TWENTY_FOUR_HOURS);

    return {
      success: true,
      character,
      message: `🗝️ <@${attackerId}> unlocked the harem of <@${targetUserId}> and stole **${character.name_full}**!`,
    };
  },
};
