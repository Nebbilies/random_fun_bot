import { transaction } from './catalogDb.js';
import { getMarriage, marryCharacter } from './characterMarriage.js';

const HOUR = 3_600_000;
const CLAIM_PERIOD = 3 * HOUR;
const VIETNAM_OFFSET = 7 * HOUR;
const WINDOW = 60_000;
const REPORT_LIFETIME = HOUR;

export function nextRollReset(now) {
  return (Math.floor(now / HOUR) + 1) * HOUR;
}

export function nextClaimReset(now) {
  return (Math.floor((now + VIETNAM_OFFSET) / CLAIM_PERIOD) + 1) * CLAIM_PERIOD - VIETNAM_OFFSET;
}

export function getRollStatus(db, guildId, userId, now = Date.now()) {
  if (![guildId, userId].every(validId) || !validNow(now)) throw new Error('Invalid roll status');
  const period = Math.floor(now / HOUR);
  const allowance = db.prepare('SELECT period, used FROM roll_allowances WHERE guild_id = ? AND user_id = ?')
    .get(guildId, userId);
  const used = allowance?.period === period ? allowance.used : 0;
  return { remaining: Math.max(0, 7 - used), resetAt: nextRollReset(now) };
}

export function getClaimStatus(db, guildId, userId, now = Date.now()) {
  if (![guildId, userId].every(validId) || !validNow(now)) throw new Error('Invalid claim status');
  const period = Math.floor((now + VIETNAM_OFFSET) / CLAIM_PERIOD);
  const allowance = db.prepare('SELECT period FROM claim_allowances WHERE guild_id = ? AND user_id = ?')
    .get(guildId, userId);
  return { canClaim: allowance?.period !== period, resetAt: nextClaimReset(now) };
}

function validId(id) {
  return typeof id === 'string' && /^\d+$/.test(id);
}

function validNow(now) {
  return Number.isSafeInteger(now) && now >= 0;
}

const eligible = `FROM characters AS c WHERE NOT EXISTS
  (SELECT 1 FROM marriages AS m WHERE m.guild_id = ? AND m.character_id = c.id)
  AND (LOWER(TRIM(COALESCE(c.gender, ''))) NOT IN ('female', 'male')
    OR LOWER(TRIM(c.gender)) = ?)`;

export function reserveRoll(db, { guildId, channelId, commandMessageId, userId, pool, now = Date.now(), random = Math.random }) {
  if (![guildId, channelId, commandMessageId, userId].every(validId)
    || !['w', 'h'].includes(pool) || !validNow(now)) throw new Error('Invalid roll request');
  return transaction(db, () => {
    const previous = db.prepare('SELECT id FROM character_rolls WHERE command_message_id = ?').get(commandMessageId);
    if (previous) return { status: 'duplicate', rollId: previous.id };
    const period = Math.floor(now / HOUR);
    const allowance = db.prepare('SELECT period, used FROM roll_allowances WHERE guild_id = ? AND user_id = ?')
      .get(guildId, userId);
    if (allowance?.period === period && allowance.used >= 7) return { status: 'exhausted', resetAt: nextRollReset(now) };
    const gender = pool === 'w' ? 'female' : 'male';
    const count = db.prepare(`SELECT COUNT(*) AS n ${eligible}`).get(guildId, gender).n;
    if (!count) return { status: 'empty' };
    const fraction = random();
    if (!Number.isFinite(fraction) || fraction < 0 || fraction >= 1) throw new Error('Invalid random value');
    const offset = Math.floor(fraction * count);
    const character = db.prepare(`SELECT c.id, c.name_full, c.rank, c.favourites, c.image_url,
      (SELECT tag_name FROM tag_decisions WHERE character_id = c.id AND status = 'approve') AS tag_name
      ${eligible} ORDER BY c.id LIMIT 1 OFFSET ?`).get(guildId, gender, offset);
    db.prepare(`INSERT INTO roll_allowances (guild_id, user_id, period, used)
      VALUES (?, ?, ?, 1) ON CONFLICT(guild_id, user_id) DO UPDATE SET
      period = excluded.period,
      used = CASE WHEN roll_allowances.period = excluded.period THEN roll_allowances.used + 1 ELSE 1 END`)
      .run(guildId, userId, period);
    const result = db.prepare(`INSERT INTO character_rolls
      (guild_id, channel_id, command_message_id, character_id, character_name, state)
      VALUES (?, ?, ?, ?, ?, 'pending')`)
      .run(guildId, channelId, commandMessageId, character.id, character.name_full);
    return { status: 'reserved', rollId: Number(result.lastInsertRowid), character };
  });
}

export function publishRoll(db, rollId, messageId, now = Date.now()) {
  if (!Number.isSafeInteger(rollId) || !validId(messageId) || !validNow(now)) throw new Error('Invalid roll publication');
  return db.prepare(`UPDATE character_rolls SET message_id = ?, state = 'open',
    published_at = ?, expires_at = ? WHERE id = ? AND state = 'pending'`)
    .run(messageId, now, now + WINDOW, rollId).changes === 1;
}

export function failRoll(db, rollId) {
  if (!Number.isSafeInteger(rollId)) throw new Error('Invalid roll');
  return db.prepare("UPDATE character_rolls SET state = 'failed' WHERE id = ? AND state IN ('pending', 'open')")
    .run(rollId).changes === 1;
}

export function getRoll(db, guildId, channelId, messageId) {
  if (![guildId, channelId, messageId].every(validId)) return null;
  return db.prepare(`SELECT id, guild_id AS guildId, channel_id AS channelId,
    message_id AS messageId, character_id AS characterId,
    character_name AS characterName, state, published_at AS publishedAt,
    expires_at AS expiresAt FROM character_rolls
    WHERE guild_id = ? AND channel_id = ? AND message_id = ?`)
    .get(guildId, channelId, messageId) ?? null;
}

export function claimRoll(db, { guildId, channelId, messageId, userId, now = Date.now() }) {
  if (![guildId, channelId, messageId, userId].every(validId) || !validNow(now)) throw new Error('Invalid claim');
  return transaction(db, () => {
    const roll = getRoll(db, guildId, channelId, messageId);
    if (!roll) return { status: 'unknown' };
    if (roll.state !== 'open') return { status: 'closed' };
    if (now >= roll.expiresAt) return { status: 'expired' };
    if (getMarriage(db, guildId, roll.characterId)) {
      db.prepare("UPDATE character_rolls SET state = 'closed' WHERE guild_id = ? AND character_id = ? AND state = 'open'")
        .run(guildId, roll.characterId);
      return { status: 'closed' };
    }
    const period = Math.floor((now + VIETNAM_OFFSET) / CLAIM_PERIOD);
    const allowance = db.prepare('SELECT period FROM claim_allowances WHERE guild_id = ? AND user_id = ?')
      .get(guildId, userId);
    if (allowance?.period === period) return { status: 'exhausted', resetAt: nextClaimReset(now), rollId: roll.id };
    const result = marryCharacter(db, guildId, roll.characterId, userId);
    if (result.status !== 'married') {
      if (result.status === 'already_owned' || result.status === 'already_yours') {
        db.prepare("UPDATE character_rolls SET state = 'closed' WHERE guild_id = ? AND character_id = ? AND state = 'open'")
          .run(guildId, roll.characterId);
      }
      return { status: 'closed' };
    }
    db.prepare(`INSERT INTO claim_allowances (guild_id, user_id, period) VALUES (?, ?, ?)
      ON CONFLICT(guild_id, user_id) DO UPDATE SET period = excluded.period`)
      .run(guildId, userId, period);
    db.prepare("UPDATE character_rolls SET state = 'closed' WHERE guild_id = ? AND character_id = ? AND state = 'open'")
      .run(guildId, roll.characterId);
    return { status: 'married', characterName: roll.characterName, characterId: roll.characterId };
  });
}

export function markClaimNotice(db, rollId, userId) {
  if (!Number.isSafeInteger(rollId) || !validId(userId)) throw new Error('Invalid claim notice');
  return db.prepare('INSERT OR IGNORE INTO roll_notices (roll_id, user_id) VALUES (?, ?)')
    .run(rollId, userId).changes === 1;
}

export function getReportableRoll(db, guildId, channelId, messageId, now = Date.now()) {
  const roll = getRoll(db, guildId, channelId, messageId);
  return roll?.publishedAt != null && now < roll.publishedAt + REPORT_LIFETIME ? roll : null;
}

export function recoverRolls(db, now = Date.now()) {
  db.prepare("UPDATE character_rolls SET state = 'failed' WHERE state = 'pending'").run();
  return db.prepare(`SELECT id, guild_id AS guildId, channel_id AS channelId,
    message_id AS messageId, character_id AS characterId, expires_at AS expiresAt
    FROM character_rolls WHERE state = 'open' AND expires_at > ?`).all(now);
}

export function cleanupRolls(db, now = Date.now()) {
  return transaction(db, () => {
    db.prepare(`DELETE FROM roll_notices WHERE roll_id IN
      (SELECT id FROM character_rolls WHERE published_at < ? OR state = 'failed')`)
      .run(now - REPORT_LIFETIME);
    return db.prepare("DELETE FROM character_rolls WHERE published_at < ? OR state = 'failed'")
      .run(now - REPORT_LIFETIME).changes;
  });
}
