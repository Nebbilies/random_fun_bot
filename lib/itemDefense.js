import { randomUUID } from "node:crypto";
import { getAffectionBenefits } from "./characterAffection.js";
import { resolveAffectionDecisionInTransaction } from "./affectionPerks.js";
import { hasItemAffection } from "./affectionItemUse.js";
import { withOwnershipOperationClock } from "./characterOwnershipHistory.js";
import { getCounterfeitCrown } from "./itemActionStorage.js";
import { isCharacterBusy } from "./characterAvailability.js";
import { isCharacterLocked } from "./itemStorage.js";

/** Explicit validated hostile seams only; never call from generic ownership deletion. */
export function resolveSoulmateNegation(
  db,
  {
    sourceKey = `attack:${randomUUID()}`,
    guildId,
    ownerId,
    now = Date.now(),
    random = Math.random,
  },
) {
  if (!hasItemAffection(db)) return { triggered: false, chance: 0 };
  return withOwnershipOperationClock(db, now, () =>
    resolveAffectionDecisionInTransaction(db, {
      sourceKey,
      guildId,
      userId: ownerId,
      effect: "negation",
      chance: getAffectionBenefits(db, guildId, ownerId).perks.negation,
      now,
      random,
    }),
  );
}

/** Transaction-neutral Crown adapter for existing covered attacks. */
export function legacyCrownTarget(db, guildId, character, ownerId, now) {
  const original = {
    characterId: character.character_id ?? character.characterId,
    marriageId: character.marriageId ?? character.id,
    ownerId,
    name: character.name_full ?? character.name,
  };
  const { target, crown } = redirectWithCrown(db, guildId, original, now);
  return {
    ...character,
    character_id: target.characterId,
    characterId: target.characterId,
    marriageId: target.marriageId,
    name_full: target.name,
    crownRedirected: Boolean(crown),
  };
}

export function redirectWithCrown(db, guildId, original, now = Date.now()) {
  const crown = getCounterfeitCrown(db, guildId, original.ownerId);
  if (!crown) return { target: original, crown: null };
  const current = db
    .prepare(
      `SELECT m.id AS marriageId,m.character_id AS characterId,m.owner_id AS ownerId,c.rank,c.name_full AS name
    FROM marriages m JOIN characters c ON c.id=m.character_id WHERE m.guild_id=? AND m.character_id=?`,
    )
    .get(guildId, crown.character_id);
  if (
    !current ||
    current.ownerId !== crown.user_id ||
    current.marriageId !== crown.marriage_id ||
    isCharacterLocked(db, guildId, crown.character_id, now).locked
  ) {
    db.prepare(
      "DELETE FROM counterfeit_crowns WHERE guild_id=? AND user_id=?",
    ).run(guildId, original.ownerId);
    return { target: original, crown: null };
  }
  if (
    current.characterId === original.characterId ||
    isCharacterBusy(db, guildId, current.characterId, now)
  )
    return { target: original, crown: null };
  db.prepare(
    "DELETE FROM counterfeit_crowns WHERE guild_id=? AND user_id=?",
  ).run(guildId, original.ownerId);
  return { target: current, crown };
}
