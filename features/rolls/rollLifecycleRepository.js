import { currentSeasonRows } from "../../lib/seasonSchema.js";
// Inspect each time: explicit schema upgrades may occur on the same connection.
export function hasRollCharacterSnapshot(db) {
  return db
    .prepare("PRAGMA table_info(character_rolls)")
    .all()
    .some((column) => column.name === "character_snapshot_json");
}

export function readRollSnapshot(db, rollId) {
  return db
    .prepare(
      `SELECT character_id AS characterId, character_name AS characterName,
    mystery_session_id AS mysterySessionId,
    ${hasRollCharacterSnapshot(db) ? "character_snapshot_json" : "NULL"} AS snapshotJson
    FROM ${currentSeasonRows(db, "character_rolls")} WHERE id = ?`,
    )
    .get(rollId);
}

export function readPendingPublication(db, rollId) {
  return db
    .prepare(
      `SELECT guild_id AS guildId, channel_id AS channelId, character_id AS characterId,
    escape_marriage_id AS escapeMarriageId, escape_owner_id AS escapeOwnerId, rules_json AS rulesJson
    FROM ${currentSeasonRows(db, "character_rolls")} WHERE id = ? AND state = 'pending' AND mystery_session_id IS NULL`,
    )
    .get(rollId);
}

export function cancelRollPublication(db, rollId, messageId, now) {
  db.prepare(
    `UPDATE character_rolls SET message_id = ?, state = 'closed', published_at = ?,
    escape_outcome = 'canceled', escape_resolved_at = ? WHERE id = ?`,
  ).run(messageId, now, now, rollId);
}

export function publishPendingRoll(
  db,
  rollId,
  messageId,
  state,
  now,
  protectedUntil,
  expiresAt,
) {
  return (
    db
      .prepare(
        `UPDATE character_rolls SET message_id = ?, state = ?,
    published_at = ?, protected_until = ?, expires_at = ? WHERE id = ? AND state = 'pending'`,
      )
      .run(messageId, state, now, protectedUntil, expiresAt, rollId).changes ===
    1
  );
}

export function readRollSession(db, rollId) {
  return db
    .prepare(
      `SELECT mystery_session_id AS sessionId FROM ${currentSeasonRows(db, "character_rolls")} WHERE id = ?`,
    )
    .get(rollId);
}

export function failActiveRoll(db, rollId, now) {
  return (
    db
      .prepare(
        `UPDATE character_rolls SET state = 'failed',
    escape_outcome = CASE WHEN escape_marriage_id IS NOT NULL THEN 'failed' END,
    escape_resolved_at = CASE WHEN escape_marriage_id IS NOT NULL THEN ? END
    WHERE id = ? AND state IN ('pending', 'open')`,
      )
      .run(now, rollId).changes === 1
  );
}

export function readRoll(db, guildId, channelId, messageId) {
  return (
    db
      .prepare(
        `SELECT id, guild_id AS guildId, channel_id AS channelId,
    message_id AS messageId, command_message_id AS commandMessageId, character_id AS characterId,
    character_name AS characterName, state, published_at AS publishedAt,
    expires_at AS expiresAt, mystery_session_id AS mysterySessionId,
    exclusive_user_id AS exclusiveUserId, escape_marriage_id AS escapeMarriageId,
    escape_owner_id AS escapeOwnerId, protected_until AS protectedUntil,
    escape_outcome AS escapeOutcome, escape_winner_id AS escapeWinnerId,
    escape_resolved_at AS escapeResolvedAt, rules_json AS rulesJson,
    ${hasRollCharacterSnapshot(db) ? "character_snapshot_json" : "NULL"} AS characterSnapshotJson FROM ${currentSeasonRows(db, "character_rolls")}
    WHERE guild_id = ? AND channel_id = ? AND message_id = ?`,
      )
      .get(guildId, channelId, messageId) ?? null
  );
}

export function closeEscapeRoll(db, rollId, outcome, now, winnerId) {
  db.prepare(
    `UPDATE character_rolls SET state = 'closed', escape_outcome = ?,
    escape_winner_id = ?, escape_resolved_at = ? WHERE id = ? AND state = 'open'`,
  ).run(outcome, winnerId, now, rollId);
}

export function rollCharacterExists(db, characterId) {
  return db.prepare("SELECT 1 FROM characters WHERE id = ?").get(characterId);
}

export function readRollSchemaVersion(db) {
  return Number(db.prepare("PRAGMA user_version").get().user_version);
}

export function readMysteryClaimState(db, sessionId, guildId) {
  return db
    .prepare(
      `SELECT state FROM ${currentSeasonRows(db, "mystery_sessions")} WHERE id = ? AND guild_id = ?`,
    )
    .get(sessionId, guildId);
}

export function closeCharacterRolls(db, guildId, characterId) {
  db.prepare(
    "UPDATE character_rolls SET state = 'closed' WHERE guild_id = ? AND character_id = ? AND state = 'open'",
  ).run(guildId, characterId);
}

export function initializeDoubleDateClaims(db, buffId, freeClaims) {
  db.prepare("UPDATE active_user_buffs SET remaining_rolls=? WHERE id=?").run(
    freeClaims,
    buffId,
  );
}

export function insertClaimNotice(db, rollId, userId) {
  return (
    db
      .prepare(
        "INSERT OR IGNORE INTO roll_notices (roll_id, user_id) VALUES (?, ?)",
      )
      .run(rollId, userId).changes === 1
  );
}
