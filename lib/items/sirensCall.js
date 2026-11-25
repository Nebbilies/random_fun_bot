import { randomUUID } from "node:crypto";
import { getGameConfig } from "../gameConfig.js";
import { isCharacterLocked } from "../itemStorage.js";
import { resolveSoulmateNegation, legacyCrownTarget } from "../itemDefense.js";
import { isCharacterBusy } from "../characterAvailability.js";
import { characterLikesProjection } from "../characterLikesProjection.js";
import { hydrateCharacterFranchises } from "../characterSeries.js";
import { captureCharacterSnapshot } from "../characterSnapshot.js";

export const sirensCall = {
  id: "sirens_call",
  name: "Siren's Call",
  tier: "rare",
  description:
    "Forces a **random character** owned by a targeted user to **immediately attempt an escape** in chat.",
  type: "targeted_user",
  maxCharges: 1,

  execute({
    db,
    guildId,
    userId,
    args,
    sourceKey = `siren:${randomUUID()}`,
    channelId = "item",
    random = Math.random,
    now = Date.now(),
  }) {
    const targetMention = args[0];
    const targetId = targetMention
      ? targetMention.replace(/[^0-9]/g, "")
      : null;
    if (!targetId) {
      return {
        success: false,
        message: "Please specify a target user! Example: `!use siren @user`",
      };
    }
    if (targetId === userId) {
      return {
        success: false,
        message: "You cannot lure your own characters away!",
      };
    }
    const targetMarriages = db
      .prepare(
        `
      SELECT m.id AS marriageId, m.character_id AS characterId, c.name_full
      FROM marriages AS m
      JOIN characters AS c ON c.id = m.character_id
      WHERE m.guild_id = ? AND m.owner_id = ?
      ORDER BY m.character_id
    `,
      )
      .all(guildId, targetId);

    if (!targetMarriages.length) {
      return {
        success: false,
        message: `<@${targetId}> does not own any characters to target!`,
      };
    }

    const eligible = targetMarriages.filter(
      (row) =>
        !isCharacterLocked(db, guildId, row.characterId, now).locked &&
        !isCharacterBusy(db, guildId, row.characterId, now),
    );
    if (!eligible.length) {
      return {
        success: false,
        message: `All of <@${targetId}>'s characters are protected right now!`,
      };
    }

    const draw = random();
    if (!Number.isFinite(draw) || draw < 0 || draw >= 1)
      throw new Error("Invalid random value");
    const original = eligible[Math.floor(draw * eligible.length)];
    if (
      resolveSoulmateNegation(db, {
        sourceKey,
        guildId,
        ownerId: targetId,
        now,
        random,
      }).triggered
    )
      return {
        blocked: true,
        blockedBy: "negation",
        message:
          "Soulmate Negation silenced the Siren. No escape was created; defenses remain unchanged.",
      };
    const chosen = legacyCrownTarget(db, guildId, original, targetId, now);
    // Re-read the effective target: a crown can redirect to a different real row.
    const character = db
      .prepare(
        `SELECT c.*, ${characterLikesProjection(db, "c")},
      (SELECT tag_name FROM tag_decisions WHERE character_id = c.id AND status = 'approve') AS tag_name
      FROM characters c WHERE c.id=?`,
      )
      .get(chosen.characterId);
    hydrateCharacterFranchises(db, [character]);
    const snapshot = captureCharacterSnapshot(character);
    const hasSnapshot = db
      .prepare("PRAGMA table_info(character_rolls)")
      .all()
      .some((column) => column.name === "character_snapshot_json");
    const pendingRollId = Number(
      db
        .prepare(
          `INSERT INTO character_rolls
      (guild_id,channel_id,command_message_id,character_id,character_name,state,escape_marriage_id,escape_owner_id)
      VALUES(?,?,?,?,?,'pending',?,?)`,
        )
        .run(
          guildId,
          channelId,
          `siren:${randomUUID()}`,
          chosen.characterId,
          snapshot.name_full,
          chosen.marriageId,
          targetId,
        ).lastInsertRowid,
    );
    // execute runs inside useItem's consumption transaction: the effective target,
    // character terms, and windows commit together with the spent charge.
    db.prepare("UPDATE character_rolls SET rules_json=? WHERE id=?").run(
      JSON.stringify(getGameConfig(db, guildId).windows),
      pendingRollId,
    );
    if (hasSnapshot)
      db.prepare(
        "UPDATE character_rolls SET character_snapshot_json=? WHERE id=?",
      ).run(JSON.stringify(snapshot), pendingRollId);
    return {
      success: true,
      character: chosen,
      // The command layer opens the real escape attempt with this directive.
      escapeAttempt: {
        ownerId: targetId,
        characterId: chosen.characterId,
        marriageId: chosen.marriageId,
        pendingRollId,
      },
      message: `🌊 The Siren's song lures **${chosen.name_full}**! They are attempting to escape from <@${targetId}>'s harem!`,
    };
  },
};
