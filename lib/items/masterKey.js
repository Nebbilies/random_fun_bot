import { randomUUID } from "node:crypto";
import {
  scoreWeeklyGain,
  scoreWeeklyLoss,
} from "../../features/weeklyEvents/weeklyEvents.js";
import { withOwnershipOperationClock } from "../characterOwnershipHistory.js";
import {
  getUsableInventory,
  addCharacterLock,
  isCharacterLocked,
} from "../itemStorage.js";

import { legacyCrownTarget, resolveSoulmateNegation } from "../itemDefense.js";
import { spendAffectionItemChargeInTransaction } from "../affectionItemUse.js";
import {
  isCharacterBusy,
  invalidateCharacterCrown,
} from "../characterAvailability.js";

import { getItemRules } from "../itemRuntimeConfig.js";

export const masterKey = {
  id: "master_key",
  name: "Master Key",
  tier: "legendary",
  description:
    "**Steals** a **specific character** from any user in the server.",
  type: "targeted_character",
  maxCharges: 1,

  execute({
    db,
    guildId,
    userId: attackerId,
    args,
    sourceKey = `master-key:${randomUUID()}`,
    random = Math.random,
    now = Date.now(),
  }) {
    const targetMention = args[0];
    const targetUserId = targetMention
      ? targetMention.replace(/[^0-9]/g, "")
      : null;
    const characterNameQuery = args
      .slice(1)
      .join(" ")
      .replace(/^["']|["']$/g, "");

    if (!targetUserId || !characterNameQuery) {
      return {
        success: false,
        message:
          'Please specify a target user and character name! Example: `!use masterkey @user "Rem"`',
      };
    }
    if (attackerId === targetUserId) {
      return { success: false, message: "You cannot steal from yourself!" };
    }

    const reservedTarget = db
      .prepare(
        `SELECT m.character_id FROM marriages m JOIN characters c ON c.id=m.character_id
      WHERE m.guild_id=? AND m.owner_id=? AND LOWER(c.name_full) LIKE ?`,
      )
      .get(
        guildId,
        targetUserId,
        `%${characterNameQuery.trim().toLowerCase()}%`,
      );
    if (
      reservedTarget &&
      isCharacterBusy(db, guildId, reservedTarget.character_id, now)
    )
      return {
        success: false,
        message: "Character is committed to another action.",
      };

    let character = db
      .prepare(
        `
      SELECT m.id AS marriageId, m.character_id, c.name_full
      FROM marriages AS m
      JOIN characters AS c ON c.id = m.character_id
      WHERE m.guild_id = ? AND m.owner_id = ? AND LOWER(c.name_full) LIKE ?
    `,
      )
      .get(
        guildId,
        targetUserId,
        `%${characterNameQuery.trim().toLowerCase()}%`,
      );

    if (!character) {
      return {
        success: false,
        message: `Could not find a character matching "${characterNameQuery}" owned by <@${targetUserId}>.`,
      };
    }

    // Check locks
    const lock = isCharacterLocked(db, guildId, character.character_id, now);
    if (lock.locked) {
      return {
        blocked: true,
        blockedBy: lock.lockType,
        message: `🔒 **${character.name_full}** is protected by ${lock.lockType === "soulbind" ? "an **Aegis of Fidelity** soulbind" : "a theft cooldown lock"} and cannot be stolen!`,
      };
    }

    if (isCharacterBusy(db, guildId, character.character_id, now))
      return {
        success: false,
        message: "Character is committed to another action.",
      };
    if (
      resolveSoulmateNegation(db, {
        sourceKey,
        guildId,
        ownerId: targetUserId,
        now,
        random,
      }).triggered
    )
      return {
        blocked: true,
        blockedBy: "negation",
        message: `Soulmate Negation blocked the Master Key. Ownership and defenses remain unchanged.`,
      };
    const mirrorShield = getUsableInventory(
      db,
      guildId,
      targetUserId,
      now,
    ).find((item) => item.item_id === "mirror_shield");
    if (mirrorShield) {
      const payment = withOwnershipOperationClock(db, now, () =>
        spendAffectionItemChargeInTransaction(db, {
          sourceKey,
          guildId,
          userId: targetUserId,
          inventoryId: mirrorShield.id,
          now,
          random,
        }),
      );
      return {
        blocked: true,
        blockedBy: "mirror_shield",
        message: `🛡️ <@${targetUserId}>'s **Mirror Shield** blocked the Master Key${payment.conserved ? "; its charge was conserved" : " and shattered"}!`,
      };
    }
    character = legacyCrownTarget(db, guildId, character, targetUserId, now);
    invalidateCharacterCrown(db, guildId, character.character_id);

    // Transfer ownership atomically
    withOwnershipOperationClock(db, now, () => {
      const changed = db
        .prepare(
          `UPDATE marriages SET owner_id = ?, married_at = ?
        WHERE guild_id = ? AND character_id = ?`,
        )
        .run(
          attackerId,
          new Date(now).toISOString(),
          guildId,
          character.character_id,
        );
      if (changed.changes) {
        scoreWeeklyLoss(db, guildId, attackerId, sourceKey, now);
        scoreWeeklyGain(
          db,
          guildId,
          attackerId,
          character.character_id,
          sourceKey,
          now,
        );
      }
    });

    // Apply 24h theft lock
    addCharacterLock(
      db,
      guildId,
      character.character_id,
      "theft_cooldown",
      now + getItemRules(db, guildId, "master_key").protectionMs,
    );

    return {
      success: true,
      character,
      message: `🗝️ <@${attackerId}> unlocked the harem of <@${targetUserId}> and stole **${character.name_full}**!`,
    };
  },
};
