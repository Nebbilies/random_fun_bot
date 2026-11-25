import { getPerks, PERK_KEYS } from "./affectionRules.js";

/** Read the committed roll-cost decision; presentation must never draw again. */
export function wasWindfallRoll(db, guildId, userId, commandMessageId) {
  if (
    !db
      .prepare("SELECT 1 FROM sqlite_schema WHERE name='affection_schema'")
      .get()
  )
    return false;
  return Boolean(
    getAffectionDecision(db, {
      sourceKey: `roll:${guildId}:${commandMessageId}`,
      guildId,
      userId,
      effect: "windfall",
    })?.triggered,
  );
}

export function requireAffectionTransaction(db) {
  if (!db.isTransaction)
    throw new Error("Affection operation requires caller transaction");
}
export function validateAffectionScope({ guildId, userId, sourceKey, now }) {
  if (
    ![guildId, userId, sourceKey].every(
      (v) => typeof v === "string" && v.trim(),
    ) ||
    !Number.isSafeInteger(now) ||
    now < 0
  )
    throw new Error("Invalid affection source scope/time");
}
export function drawAffectionRandom(random) {
  const n = random();
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n >= 1)
    throw new Error("Invalid affection random draw");
  return n;
}
/** Pure eligibility read; no creating/pruning rows. */
export function captureCurrentPerks(db, guildId, userId) {
  if (
    !db
      .prepare(
        "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='affection_schema'",
      )
      .get()
  )
    return getPerks(0);
  const row = db
    .prepare(
      `SELECT COALESCE(a.total,0) total FROM player_soulmates s
    JOIN marriages m ON m.guild_id=s.guild_id AND m.owner_id=s.user_id AND m.character_id=s.character_id
    LEFT JOIN character_affection a ON a.guild_id=s.guild_id AND a.user_id=s.user_id AND a.character_id=s.character_id
    WHERE s.guild_id=? AND s.user_id=?`,
    )
    .get(guildId, userId);
  return getPerks(row?.total ?? 0);
}
export function getAffectionDecision(
  db,
  { sourceKey, guildId, userId, effect, ordinal = 0 },
) {
  const row = db
    .prepare(
      `SELECT chance,triggered FROM affection_decisions
    WHERE source_key=? AND guild_id=? AND user_id=? AND effect=? AND ordinal=?`,
    )
    .get(sourceKey, guildId, userId, effect, ordinal);
  return row ? { triggered: Boolean(row.triggered), chance: row.chance } : null;
}
/** Receipt lookup deliberately precedes chance/RNG validation and all mutable state. */
export function resolveAffectionDecisionInTransaction(
  db,
  {
    sourceKey,
    guildId,
    userId,
    effect,
    chance,
    now,
    random = Math.random,
    ordinal = 0,
  },
) {
  requireAffectionTransaction(db);
  validateAffectionScope({ sourceKey, guildId, userId, now });
  if (
    !PERK_KEYS.includes(effect) ||
    !Number.isSafeInteger(ordinal) ||
    ordinal < 0
  )
    throw new Error("Invalid affection effect identity");
  const previous = getAffectionDecision(db, {
    sourceKey,
    guildId,
    userId,
    effect,
    ordinal,
  });
  if (previous) return previous;
  if (
    typeof chance !== "number" ||
    !Number.isFinite(chance) ||
    chance < 0 ||
    chance > 1
  )
    throw new Error("Invalid affection chance");
  const triggered = chance > 0 && drawAffectionRandom(random) < chance;
  db.prepare("INSERT INTO affection_decisions VALUES(?,?,?,?,?,?,?,?)").run(
    sourceKey,
    guildId,
    userId,
    effect,
    ordinal,
    chance,
    Number(triggered),
    now,
  );
  return { triggered, chance };
}
