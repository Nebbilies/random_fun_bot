import {
  getUsableInventory,
  decrementItemCharge,
  addCharacterLock,
  isCharacterLocked,
} from '../itemStorage.js';

import { legacyCrownTarget } from '../itemDefense.js';
import { isCharacterBusy, invalidateCharacterCrown } from '../characterAvailability.js';

import { getItemRules } from '../itemRuntimeConfig.js';

export const pickpocketsHook = {
  id: 'pickpockets_hook',
  name: "Pickpocket's Hook",
  tier: 'epic',
  description: 'Steals a randomly chosen married character from a targeted user in the server.',
  type: 'targeted_user',
  maxCharges: 1,

  execute({ db, guildId, userId: attackerId, args, random = Math.random, now = Date.now() }) {
    const targetMention = args[0];
    const targetUserId = targetMention ? targetMention.replace(/[^0-9]/g, '') : null;
    if (!targetUserId) {
      return { success: false, message: 'Please specify a target user to pickpocket! Example: `!use pickpocket @user`' };
    }
    if (attackerId === targetUserId) {
      return { success: false, message: 'You cannot pickpocket from yourself!' };
    }

    // Check if target has a Mirror Shield in inventory
    const targetInv = getUsableInventory(db, guildId, targetUserId, now);
    const mirrorShield = targetInv.find((item) => item.item_id === 'mirror_shield');
    if (mirrorShield) {
      decrementItemCharge(db, mirrorShield.id);
      return {
        blocked: true,
        blockedBy: 'mirror_shield',
        message: `🛡️ <@${targetUserId}>'s **Mirror Shield** shattered to block <@${attackerId}>'s steal attempt!`,
      };
    }

    // Fetch target's married characters
    const marriages = db.prepare(`
      SELECT m.id AS marriageId, m.character_id, c.name_full
      FROM marriages AS m
      JOIN characters AS c ON c.id = m.character_id
      WHERE m.guild_id = ? AND m.owner_id = ?
    `).all(guildId, targetUserId);

    if (!marriages.length) {
      return { success: false, message: `<@${targetUserId}> does not own any characters to steal!` };
    }

    // Filter out protected characters
    const eligible = marriages.filter((m) => !isCharacterLocked(db, guildId, m.character_id, now).locked && !isCharacterBusy(db, guildId, m.character_id, now));
    if (!eligible.length) {
      return { success: false, message: `All of <@${targetUserId}>'s characters are currently protected from theft!` };
    }

    const draw = random();
    if (!Number.isFinite(draw) || draw < 0 || draw >= 1) throw new Error('Invalid random value');
    let chosen = eligible[Math.floor(draw * eligible.length)];
    chosen = legacyCrownTarget(db, guildId, chosen, targetUserId, now);
    invalidateCharacterCrown(db, guildId, chosen.character_id);

    // Transfer ownership atomically
    db.prepare(`
      UPDATE marriages SET owner_id = ?, married_at = ?
      WHERE guild_id = ? AND character_id = ?
    `).run(attackerId, new Date(now).toISOString(), guildId, chosen.character_id);

    // Apply 24h theft lock
    addCharacterLock(db, guildId, chosen.character_id, 'theft_cooldown', now + getItemRules(db, guildId, 'pickpockets_hook').protectionMs);

    return {
      success: true,
      character: chosen,
      message: `🪝 <@${attackerId}> pickpocketed **${chosen.name_full}** from <@${targetUserId}>!`,
    };
  },
};
