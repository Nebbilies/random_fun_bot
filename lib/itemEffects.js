import {
  expandInventoryCapacity,
  getInventory,
  removeItemFromInventory,
  addCharacterLock,
  isCharacterLocked,
  addActiveBuff,
} from './itemStorage.js';
import { marryCharacter, getMarriage } from './characterMarriage.js';

const HOUR = 3_600_000;
const TWENTY_FOUR_HOURS = 24 * 3_600_000;

export function useHourglassOfHaste(db, guildId, userId, now = Date.now()) {
  const period = Math.floor(now / HOUR);
  db.prepare(`
    UPDATE roll_allowances SET used = 0
    WHERE guild_id = ? AND user_id = ? AND period = ?
  `).run(guildId, userId, period);
  return { success: true, message: 'Your hourly rolls have been reset! You can now roll again.' };
}

export function useLoveLetter(db, guildId, userId) {
  db.prepare('DELETE FROM claim_allowances WHERE guild_id = ? AND user_id = ?')
    .run(guildId, userId);
  return { success: true, message: 'Your marriage claim cooldown has been reset! You can marry another character right now.' };
}

export function useBagOfHolding(db, guildId, userId) {
  const newCapacity = expandInventoryCapacity(db, guildId, userId);
  return { success: true, newCapacity, message: `Your inventory capacity has expanded to ${newCapacity} slots!` };
}

export function useFourLeafClover(db, guildId, userId) {
  addActiveBuff(db, guildId, userId, 'four_leaf_clover', null, null, 5);
  return { success: true, message: 'Four-Leaf Clover activated! Your next 5 rolls have boosted high-favorite rates.' };
}

export function useRollingFever(db, guildId, userId) {
  addActiveBuff(db, guildId, userId, 'rolling_fever', null, null, 10);
  return { success: true, message: 'Rolling Fever activated! For your next 10 rolls, characters with over 1,000 favorites refund +2 rolls.' };
}

export function useAdrenalineRush(db, guildId, userId, now = Date.now()) {
  addActiveBuff(db, guildId, userId, 'adrenaline_rush', null, now + HOUR, null);
  return { success: true, message: 'Adrenaline Rush activated! Your roll limit is boosted for the next hour.' };
}

export function useDoubleDate(db, guildId, userId, now = Date.now()) {
  addActiveBuff(db, guildId, userId, 'double_date', null, now + 10 * 60 * 1000, null);
  return { success: true, message: 'Double Date activated! For the next 10 minutes, marrying a character will not put your claim on cooldown.' };
}

export function useEngagementRing(db, guildId, userId) {
  addActiveBuff(db, guildId, userId, 'engagement_ring', null, null, 1);
  return { success: true, message: 'Engagement Ring activated! Your next claim cooldown will be reduced by 50%.' };
}

export function usePinata(db, guildId, userId) {
  useLoveLetter(db, guildId, userId);
  return {
    success: true,
    message: '🎉 Piñata burst! The chat is showered with luck, and you received an immediate claim reset!',
  };
}

export function useGoldenHour(db, guildId, userId, now = Date.now()) {
  return {
    success: true,
    message: '⭐ Golden Hour has begun! Rolls are supercharged for the next 5 minutes!',
  };
}

export function useCrownOfTheSovereign(db, guildId, userId) {
  addActiveBuff(db, guildId, userId, 'crown_of_the_sovereign', null, null, 3);
  return { success: true, message: 'Crown of the Sovereign equipped! You have 3 instant claim tokens that bypass cooldowns.' };
}

export function usePickpocketsHook(db, guildId, attackerId, targetUserId, random = Math.random, now = Date.now()) {
  if (attackerId === targetUserId) {
    return { success: false, message: 'You cannot pickpocket from yourself!' };
  }

  // Check if target has a Mirror Shield in inventory
  const targetInv = getInventory(db, guildId, targetUserId);
  const mirrorShield = targetInv.find((item) => item.item_id === 'mirror_shield');
  if (mirrorShield) {
    removeItemFromInventory(db, mirrorShield.id);
    return {
      blocked: true,
      blockedBy: 'mirror_shield',
      message: `🛡️ <@${targetUserId}>'s **Mirror Shield** shattered to block <@${attackerId}>'s steal attempt!`,
    };
  }

  // Fetch target's married characters
  const marriages = db.prepare(`
    SELECT m.character_id, c.name_full
    FROM marriages AS m
    JOIN characters AS c ON c.id = m.character_id
    WHERE m.guild_id = ? AND m.owner_id = ?
  `).all(guildId, targetUserId);

  if (!marriages.length) {
    return { success: false, message: `<@${targetUserId}> does not own any characters to steal!` };
  }

  // Filter out protected characters (soulbind or 24h theft lock)
  const eligible = marriages.filter((m) => !isCharacterLocked(db, guildId, m.character_id, now).locked);
  if (!eligible.length) {
    return { success: false, message: `All of <@${targetUserId}>'s characters are currently protected from theft!` };
  }

  const chosen = eligible[Math.floor(random() * eligible.length)];

  // Transfer ownership atomically
  db.prepare(`
    UPDATE marriages SET owner_id = ?, married_at = ?
    WHERE guild_id = ? AND character_id = ?
  `).run(attackerId, new Date(now).toISOString(), guildId, chosen.character_id);

  // Apply 24h theft lock
  addCharacterLock(db, guildId, chosen.character_id, 'theft_cooldown', now + TWENTY_FOUR_HOURS);

  return {
    success: true,
    character: chosen,
    message: `🪝 <@${attackerId}> pickpocketed **${chosen.name_full}** from <@${targetUserId}>!`,
  };
}

export function useMasterKey(db, guildId, attackerId, targetUserId, characterNameQuery, now = Date.now()) {
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
}

export function useAegisOfFidelity(db, guildId, userId, characterNameQuery) {
  const character = db.prepare(`
    SELECT m.character_id, c.name_full
    FROM marriages AS m
    JOIN characters AS c ON c.id = m.character_id
    WHERE m.guild_id = ? AND m.owner_id = ? AND LOWER(c.name_full) LIKE ?
  `).get(guildId, userId, `%${characterNameQuery.trim().toLowerCase()}%`);

  if (!character) {
    return { success: false, message: `You do not own a character matching "${characterNameQuery}".` };
  }

  // Add permanent soulbind lock (null protected_until)
  addCharacterLock(db, guildId, character.character_id, 'soulbind', null);

  return {
    success: true,
    character,
    message: `🛡️ **${character.name_full}** has been permanently soulbound with the **Aegis of Fidelity**! They can never be stolen or escape forever.`,
  };
}

export function useWishUponAStar(db, guildId, userId, franchiseQuery, random = Math.random) {
  const franchise = db.prepare(`
    SELECT id, display_name FROM franchises
    WHERE LOWER(display_name) LIKE ?
  `).get(`%${franchiseQuery.trim().toLowerCase()}%`);

  if (!franchise) {
    return { success: false, message: `Could not find an anime franchise matching "${franchiseQuery}".` };
  }

  // Find franchise characters ordered by favorites DESC
  const characters = db.prepare(`
    SELECT DISTINCT c.id, c.name_full, c.favourites, c.rank
    FROM characters AS c
    JOIN character_anime AS ca ON ca.character_id = c.id
    JOIN franchise_anime AS fa ON fa.anime_id = ca.anime_id
    WHERE fa.franchise_id = ?
    ORDER BY c.favourites DESC
  `).all(franchise.id);

  if (!characters.length) {
    return { success: false, message: `No catalog characters found for franchise "${franchise.display_name}".` };
  }

  // Check top 3 unowned
  const top3 = characters.slice(0, 3);
  const unownedInTop3 = top3.filter((c) => !getMarriage(db, guildId, c.id));

  let chosen;
  if (unownedInTop3.length > 0) {
    chosen = unownedInTop3[Math.floor(random() * unownedInTop3.length)];
  } else {
    // If all top 3 are claimed, find the highest unowned character in the franchise
    chosen = characters.find((c) => !getMarriage(db, guildId, c.id));
  }

  if (!chosen) {
    return { success: false, message: `Every character from "${franchise.display_name}" is already married in this server!` };
  }

  marryCharacter(db, guildId, chosen.id, userId);

  return {
    success: true,
    character: chosen,
    franchise,
    message: `⭐ A shooting star falls from the heavens! You have wished for **${franchise.display_name}** and married **${chosen.name_full}**!`,
  };
}

export function useFranchisePassport(db, guildId, userId, franchiseQuery) {
  const franchise = db.prepare('SELECT id, display_name FROM franchises WHERE LOWER(display_name) LIKE ?')
    .get(`%${franchiseQuery.trim().toLowerCase()}%`);
  if (!franchise) {
    return { success: false, message: `Could not find franchise "${franchiseQuery}".` };
  }
  addActiveBuff(db, guildId, userId, 'franchise_passport', JSON.stringify({ franchiseId: franchise.id, name: franchise.display_name }), null, 5);
  return { success: true, message: `Franchise Passport stamped for **${franchise.display_name}**! Your next 5 rolls are guaranteed from this series.` };
}
