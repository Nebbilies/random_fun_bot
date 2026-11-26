import { getItemRules } from "../itemRuntimeConfig.js";
import { characterMainFranchiseRelation } from "../characterFranchises.js";
import { divorceCharacter, marryCharacter } from "../characterMarriage.js";
import { isCharacterBusy, isCharacterHeld } from "../characterAvailability.js";

function parseNames(args) {
  const parts = args.length === 1 ? args[0].split(",") : args;
  return parts
    .map((name) =>
      String(name)
        .trim()
        .replace(/^["']|["']$/g, "")
        .trim(),
    )
    .filter(Boolean);
}

function ownedMarriages(db, guildId, userId) {
  return db
    .prepare(
      `
    SELECT m.id AS marriageId, m.character_id AS characterId, c.name_full, c.rank
    FROM marriages AS m
    JOIN characters AS c ON c.id = m.character_id
    WHERE m.guild_id = ? AND m.owner_id = ?
    ORDER BY m.character_id
  `,
    )
    .all(guildId, userId);
}

function franchisesOf(db, characterId) {
  const ids = db
    .prepare(
      `SELECT DISTINCT membership.franchise_id AS franchiseId
    FROM ${characterMainFranchiseRelation(db)} AS membership
    WHERE membership.character_id = ?`,
    )
    .all(characterId)
    .map((row) => row.franchiseId);
  return new Set(ids);
}

export const bloodPact = {
  id: "blood_pact",
  name: "Blood Pact",
  tier: "epic",
  description:
    "Sacrifice **3 characters** you own from the same franchise to marry its **best-ranked** available unowned character.",
  type: "item_action",
  maxCharges: 1,

  execute({
    db,
    guildId,
    userId,
    args = [],
    choices,
    sacrificeCount,
    now = Date.now(),
  }) {
    const names = choices ?? parseNames(args);
    const count =
      sacrificeCount ?? getItemRules(db, guildId, "blood_pact").sacrificeCount;
    if (names.length !== count) {
      return {
        success: false,
        message: `Please specify ${count} characters from the same franchise to sacrifice!`,
      };
    }

    const owned = ownedMarriages(db, guildId, userId);
    const sacrifices = [];
    for (const name of names) {
      const needle = choices ? null : name.toLowerCase();
      const match = choices
        ? owned.find(
            (row) =>
              row.characterId === name.characterId &&
              row.marriageId === name.marriageId &&
              name.ownerId === userId,
          )
        : owned.find((row) => row.name_full.toLowerCase().includes(needle));
      if (!match) {
        return {
          success: false,
          message: choices
            ? "Ownership changed. Nothing was consumed."
            : `You do not own a character matching "${name}".`,
        };
      }
      if (sacrifices.some((row) => row.characterId === match.characterId)) {
        return {
          success: false,
          message: `**${match.name_full}** was listed twice — each sacrifice must be a different character.`,
        };
      }
      if (isCharacterBusy(db, guildId, match.characterId, now)) {
        return {
          success: false,
          message: `**${match.name_full}** is committed to another action.`,
        };
      }
      sacrifices.push(match);
    }

    const shared = [...franchisesOf(db, sacrifices[0].characterId)].filter(
      (franchiseId) =>
        sacrifices.every((row) =>
          franchisesOf(db, row.characterId).has(franchiseId),
        ),
    );
    if (!shared.length) {
      return {
        success: false,
        message: `All ${count} sacrifices must come from the same franchise.`,
      };
    }

    const placeholders = sacrifices.map(() => "?").join(", ");
    let candidate = null;
    for (const franchiseId of shared) {
      candidate = db
        .prepare(
          `SELECT DISTINCT c.id, c.name_full, c.rank
        FROM characters AS c
        JOIN ${characterMainFranchiseRelation(db)} AS membership ON membership.character_id = c.id
        WHERE membership.franchise_id = ? AND c.id NOT IN (${placeholders})
          AND NOT EXISTS (SELECT 1 FROM marriages AS m WHERE m.guild_id = ? AND m.character_id = c.id)
        ORDER BY c.rank ASC, c.id ASC`,
        )
        .all(franchiseId, ...sacrifices.map((row) => row.characterId), guildId)
        .find(
          (row) =>
            !isCharacterBusy(db, guildId, row.id, now) &&
            !isCharacterHeld(db, guildId, row.id, now),
        );
      if (candidate) break;
    }
    if (!candidate) {
      return {
        success: false,
        message: "No unowned character from that franchise is left to summon.",
      };
    }

    for (const row of sacrifices) {
      if (
        !divorceCharacter(
          db,
          guildId,
          row.characterId,
          userId,
          row.marriageId,
          now,
        )
      ) {
        throw new Error("Blood Pact sacrifice changed during the ritual");
      }
    }
    const married = marryCharacter(db, guildId, candidate.id, userId, now);
    if (married.status !== "married")
      throw new Error("Blood Pact summon became unavailable");
    const summon = candidate;
    return {
      success: true,
      character: summon,
      message: `🩸 The Blood Pact consumes **${sacrifices.map((row) => row.name_full).join("**, **")}** and summons **${summon.name_full}** (rank #${summon.rank})!`,
    };
  },
};
