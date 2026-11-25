import {
  isCharacterBusy,
  invalidateCharacterCrown,
} from "../characterAvailability.js";
import { addCharacterLock } from "../itemStorage.js";
import { getItemRules } from "../itemRuntimeConfig.js";

export const aegisOfFidelity = {
  id: "aegis_of_fidelity",
  name: "Aegis of Fidelity",
  tier: "legendary",
  description:
    "**Soulbinds** one character you own, protecting them from theft, escape attempts, and forced divorce.",
  type: "targeted_own_character",
  maxCharges: 1,

  execute({ db, guildId, userId, args, now = Date.now() }) {
    const characterNameQuery = args.join(" ").replace(/^["']|["']$/g, "");
    if (!characterNameQuery) {
      return {
        success: false,
        message:
          'Please specify which character you want to soulbind! Example: `!use aegis "Megumin"`',
      };
    }

    const character = db
      .prepare(
        `
      SELECT m.character_id, c.name_full
      FROM marriages AS m
      JOIN characters AS c ON c.id = m.character_id
      WHERE m.guild_id = ? AND m.owner_id = ? AND LOWER(c.name_full) LIKE ?
    `,
      )
      .get(guildId, userId, `%${characterNameQuery.trim().toLowerCase()}%`);

    if (!character) {
      return {
        success: false,
        message: `You do not own a character matching "${characterNameQuery}".`,
      };
    }

    if (isCharacterBusy(db, guildId, character.character_id, now)) {
      return {
        success: false,
        message: "That character is committed to another action.",
      };
    }
    const protectedUntil =
      now + getItemRules(db, guildId, "aegis_of_fidelity").protectionMs;
    addCharacterLock(
      db,
      guildId,
      character.character_id,
      "soulbind",
      protectedUntil,
    );
    invalidateCharacterCrown(db, guildId, character.character_id);

    return {
      success: true,
      character,
      message: `🛡️ **${character.name_full}** has been soulbound with the **Aegis of Fidelity** until <t:${Math.floor(protectedUntil / 1000)}:R>.`,
    };
  },
};
