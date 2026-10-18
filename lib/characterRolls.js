import { transaction } from './catalogDb.js';
import { divorceCharacter, getMarriage, marryCharacter } from './characterMarriage.js';
import { passesMysteryGate } from './mysteryOdds.js';

const HOUR = 3_600_000;
const CLAIM_PERIOD = 3 * HOUR;
const VIETNAM_OFFSET = 7 * HOUR;
const DAY = 24 * HOUR;
const DEFAULT_MAX_ROLLS = 7;
const WINDOW = 60_000;
const REPORT_LIFETIME = HOUR;
const ACTIVE_MYSTERY = "('reserved', 'running', 'countdown', 'claim_open')";

export function nextRollReset(now) {
  return (Math.floor(now / HOUR) + 1) * HOUR;
}

export function nextClaimReset(now) {
  return (Math.floor((now + VIETNAM_OFFSET) / CLAIM_PERIOD) + 1) * CLAIM_PERIOD - VIETNAM_OFFSET;
}

export function getMaxRolls(db, guildId) {
  return db.prepare('SELECT max_rolls FROM guild_roll_limits WHERE guild_id = ?')
    .get(guildId)?.max_rolls ?? DEFAULT_MAX_ROLLS;
}

export function setMaxRolls(db, guildId, amount) {
  if (!validId(guildId) || !Number.isSafeInteger(amount) || amount < 1) {
    throw new Error('Invalid roll maximum');
  }
  db.prepare(`INSERT INTO guild_roll_limits (guild_id, max_rolls) VALUES (?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET max_rolls = excluded.max_rolls`).run(guildId, amount);
}

export function getRollStatus(db, guildId, userId, now = Date.now()) {
  if (![guildId, userId].every(validId) || !validNow(now)) throw new Error('Invalid roll status');
  const period = Math.floor(now / HOUR);
  const allowance = db.prepare('SELECT period, used FROM roll_allowances WHERE guild_id = ? AND user_id = ?')
    .get(guildId, userId);
  const used = allowance?.period === period ? allowance.used : 0;
  return { remaining: Math.max(0, getMaxRolls(db, guildId) - used), resetAt: nextRollReset(now) };
}

export function addGlobalRolls(db, amount, now = Date.now()) {
  if (!Number.isSafeInteger(amount) || amount < 1 || !validNow(now)) throw new Error('Invalid roll amount');
  return transaction(db, () => {
    const result = db.prepare(`UPDATE roll_allowances SET used = MAX(0,
      MIN(used, COALESCE((SELECT max_rolls FROM guild_roll_limits
        WHERE guild_id = roll_allowances.guild_id), ?)) - ?)
      WHERE period = ? AND used > 0`)
      .run(DEFAULT_MAX_ROLLS, amount, Math.floor(now / HOUR));
    return { updated: Number(result.changes) };
  });
}

export function resetGlobalClaims(db) {
  return transaction(db, () => ({ updated: Number(db.prepare('DELETE FROM claim_allowances').run().changes) }));
}

export function claimDailyRolls(db, guildId, userId, now = Date.now()) {
  if (![guildId, userId].every(validId) || !validNow(now)) throw new Error('Invalid daily roll claim');
  const period = Math.floor((now + VIETNAM_OFFSET) / DAY);
  const resetAt = (period + 1) * DAY - VIETNAM_OFFSET;
  return transaction(db, () => {
    const claimed = db.prepare(`INSERT INTO daily_roll_claims (guild_id, user_id, period)
      VALUES (?, ?, ?) ON CONFLICT(guild_id, user_id) DO UPDATE SET period = excluded.period
      WHERE daily_roll_claims.period < excluded.period`).run(guildId, userId, period).changes;
    if (!claimed) return { status: 'claimed', resetAt };
    db.prepare(`INSERT INTO roll_allowances (guild_id, user_id, period, used)
      VALUES (?, ?, ?, 0) ON CONFLICT(guild_id, user_id) DO UPDATE SET
      period = excluded.period, used = 0`).run(guildId, userId, Math.floor(now / HOUR));
    return { status: 'refilled', remaining: getMaxRolls(db, guildId), resetAt };
  });
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
  (SELECT 1 FROM character_rolls AS r WHERE r.guild_id = ? AND r.character_id = c.id
    AND (r.state = 'pending' OR (r.state = 'open' AND r.expires_at > ?)))
  AND (LOWER(TRIM(COALESCE(c.gender, ''))) NOT IN ('female', 'male')
    OR LOWER(TRIM(c.gender)) = ?)`;

/** @param {{guildId: string, channelId: string, commandMessageId: string, userId: string,
 *   pool: string, now?: number, random?: () => number, prankEnabled?: boolean,
 *   mystery?: {eventChannelId: string, selectEvent: (context: any) => any} | null}} request */
export function reserveRoll(db, request) {
  const { guildId, channelId, commandMessageId, userId, pool,
    now = Date.now(), random = Math.random, mystery = null } = request;
  if (![guildId, channelId, commandMessageId, userId].every(validId)
    || !['w', 'h'].includes(pool) || !validNow(now)
    || (mystery && (!validId(mystery.eventChannelId) || typeof mystery.selectEvent !== 'function'))) {
    throw new Error('Invalid roll request');
  }
  return transaction(db, () => {
    const previous = db.prepare('SELECT id FROM character_rolls WHERE command_message_id = ?').get(commandMessageId);
    if (previous) return { status: 'duplicate', rollId: previous.id };
    if (db.prepare(`SELECT 1 FROM mystery_sessions WHERE guild_id = ? AND state IN ${ACTIVE_MYSTERY} LIMIT 1`)
      .get(guildId)) return { status: 'paused' };
    const period = Math.floor(now / HOUR);
    const allowance = db.prepare('SELECT period, used FROM roll_allowances WHERE guild_id = ? AND user_id = ?')
      .get(guildId, userId);
    const used = allowance?.period === period ? allowance.used : 0;
    const maxRolls = getMaxRolls(db, guildId);
    if (used >= maxRolls) return { status: 'exhausted', resetAt: nextRollReset(now) };
    if (request.prankEnabled) {
      const draw = random();
      if (!Number.isFinite(draw) || draw < 0 || draw >= 1) throw new Error('Invalid random value');
      if (draw < 0.01) {
        // Split the shared 1% interval equally; no character is selected or made claimable.
        const prank = draw < 0.005 ? 'dog_clap' : 'john_pork';
        db.prepare(`INSERT INTO roll_allowances (guild_id, user_id, period, used)
          VALUES (?, ?, ?, 1) ON CONFLICT(guild_id, user_id) DO UPDATE SET
          period = excluded.period,
          used = CASE WHEN roll_allowances.period = excluded.period THEN roll_allowances.used + 1 ELSE 1 END`)
          .run(guildId, userId, period);
        db.prepare(`INSERT INTO character_rolls
          (guild_id, channel_id, command_message_id, character_id, character_name, state, published_at)
          VALUES (?, ?, ?, 0, ?, 'prank', ?)`)
          .run(guildId, channelId, commandMessageId, prank, now);
        return { status: 'prank', prank, remaining: maxRolls - 1 - used };
      }
    }
    const gender = pool === 'w' ? 'female' : 'male';
    const count = db.prepare(`SELECT COUNT(*) AS n ${eligible}`).get(guildId, now, gender).n;
    if (!count) return { status: 'empty' };
    const fraction = random();
    if (!Number.isFinite(fraction) || fraction < 0 || fraction >= 1) throw new Error('Invalid random value');
    const offset = Math.floor(fraction * count);
    const character = db.prepare(`SELECT c.id, c.name_full, c.rank, c.favourites, c.image_url, c.anime_titles, c.gender,
      (SELECT tag_name FROM tag_decisions WHERE character_id = c.id AND status = 'approve') AS tag_name
      ${eligible} ORDER BY c.id LIMIT 1 OFFSET ?`).get(guildId, now, gender, offset);
    const marriage = getMarriage(db, guildId, character.id);
    let selectedEvent = null;
    if (!marriage && mystery && passesMysteryGate(character.rank, random)) {
      selectedEvent = mystery.selectEvent({ db, character, guildId, userId, now, random });
      if (!selectedEvent) return { status: 'unavailable' };
      if (typeof selectedEvent.eventId !== 'string' || !selectedEvent.eventId.trim()
        || !Number.isSafeInteger(selectedEvent.durationMs) || selectedEvent.durationMs <= 0
        || !Number.isSafeInteger(now + selectedEvent.durationMs)) throw new Error('Invalid mystery event');
    }
    db.prepare(`INSERT INTO roll_allowances (guild_id, user_id, period, used)
      VALUES (?, ?, ?, 1) ON CONFLICT(guild_id, user_id) DO UPDATE SET
      period = excluded.period,
      used = CASE WHEN roll_allowances.period = excluded.period THEN roll_allowances.used + 1 ELSE 1 END`)
      .run(guildId, userId, period);
    const result = db.prepare(`INSERT INTO character_rolls
      (guild_id, channel_id, command_message_id, character_id, character_name, state,
        escape_marriage_id, escape_owner_id)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`)
      .run(guildId, selectedEvent ? mystery?.eventChannelId : channelId,
        commandMessageId, character.id, character.name_full, marriage?.id ?? null, marriage?.ownerId ?? null);
    const rollId = Number(result.lastInsertRowid);
    if (!selectedEvent) return { status: 'reserved', rollId, character,
      escapeOwnerId: marriage?.ownerId ?? null, remaining: maxRolls - 1 - used };
    const session = db.prepare(`INSERT INTO mystery_sessions
      (guild_id, origin_roll_id, event_id, character_id, rank_snapshot, roller_id,
        event_channel_id, state, state_json, started_at, deadline_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?)`).run(
      guildId, rollId, selectedEvent.eventId, character.id, character.rank, userId,
      mystery?.eventChannelId, JSON.stringify(selectedEvent.state ?? null), now, now + selectedEvent.durationMs);
    const sessionId = Number(session.lastInsertRowid);
    db.prepare('UPDATE character_rolls SET mystery_session_id = ? WHERE id = ?').run(sessionId, rollId);
    return { status: 'mystery', rollId, sessionId, eventId: selectedEvent.eventId,
      character, remaining: maxRolls - 1 - used };
  });
}

export function publishRoll(db, rollId, messageId, now = Date.now()) {
  if (!Number.isSafeInteger(rollId) || !validId(messageId) || !validNow(now)) throw new Error('Invalid roll publication');
  return transaction(db, () => {
    const roll = db.prepare(`SELECT guild_id AS guildId, character_id AS characterId,
      escape_marriage_id AS escapeMarriageId, escape_owner_id AS escapeOwnerId
      FROM character_rolls WHERE id = ? AND state = 'pending' AND mystery_session_id IS NULL`).get(rollId);
    if (!roll) return false;
    if (roll.escapeMarriageId && !originalMarriageExists(db, roll)) {
      db.prepare(`UPDATE character_rolls SET message_id = ?, state = 'closed', published_at = ?,
        escape_outcome = 'canceled', escape_resolved_at = ? WHERE id = ?`).run(messageId, now, now, rollId);
      return false;
    }
    return db.prepare(`UPDATE character_rolls SET message_id = ?, state = 'open',
      published_at = ?, protected_until = ?, expires_at = ? WHERE id = ? AND state = 'pending'`)
      .run(messageId, now, roll.escapeMarriageId ? now + WINDOW : null,
        now + (roll.escapeMarriageId ? 2 * WINDOW : WINDOW), rollId).changes === 1;
  });
}

export function failRoll(db, rollId) {
  if (!Number.isSafeInteger(rollId)) throw new Error('Invalid roll');
  return transaction(db, () => {
    const roll = db.prepare('SELECT mystery_session_id AS sessionId FROM character_rolls WHERE id = ?').get(rollId);
    const failed = db.prepare(`UPDATE character_rolls SET state = 'failed',
      escape_outcome = CASE WHEN escape_marriage_id IS NOT NULL THEN 'failed' END,
      escape_resolved_at = CASE WHEN escape_marriage_id IS NOT NULL THEN ? END
      WHERE id = ? AND state IN ('pending', 'open')`)
      .run(Date.now(), rollId).changes === 1;
    if (failed && roll?.sessionId) finishMystery(db, roll.sessionId, 'failed', Date.now());
    return failed;
  });
}

export function getMysterySession(db, sessionId) {
  if (!Number.isSafeInteger(sessionId) || sessionId <= 0) return null;
  return db.prepare(`SELECT id, guild_id AS guildId, origin_roll_id AS originRollId,
    event_id AS eventId, character_id AS characterId, rank_snapshot AS rankSnapshot,
    roller_id AS rollerId, event_channel_id AS eventChannelId,
    event_message_id AS eventMessageId, state, state_json AS stateJson,
    started_at AS startedAt, next_at AS nextAt, deadline_at AS deadlineAt,
    winner_id AS winnerId, resolved_at AS resolvedAt, outcome
    FROM mystery_sessions WHERE id = ?`).get(sessionId) ?? null;
}

export function publishMysteryIntro(db, sessionId, messageId, now = Date.now()) {
  if (!Number.isSafeInteger(sessionId) || sessionId <= 0 || !validId(messageId) || !validNow(now)) {
    throw new Error('Invalid mystery intro');
  }
  return transaction(db, () => {
    const session = getMysterySession(db, sessionId);
    if (session?.state !== 'reserved' || session.eventMessageId) return false;
    const promptAt = now + 5_000;
    const deadlineAt = promptAt + session.deadlineAt - session.startedAt;
    if (!validNow(promptAt) || !validNow(deadlineAt)) throw new Error('Invalid mystery deadline');
    return db.prepare(`UPDATE mystery_sessions SET event_message_id = ?,
      started_at = ?, next_at = ?, deadline_at = ?
      WHERE id = ? AND state = 'reserved' AND event_message_id IS NULL`)
      .run(messageId, promptAt, promptAt, deadlineAt, sessionId).changes === 1;
  });
}

export function advanceMysterySession(db, { sessionId, expectedState, expectedStateJson, state, stateJson,
  nextAt = /** @type {number | null} */ (null), winnerId = null, puzzleId = null, now = Date.now() }) {
  if (!Number.isSafeInteger(sessionId) || sessionId <= 0 || !validNow(now)
    || (nextAt != null && !validNow(nextAt)) || (winnerId != null && !validId(winnerId))
    || (puzzleId != null && (typeof puzzleId !== 'string' || !puzzleId))
    || (expectedStateJson !== null && typeof expectedStateJson !== 'string')) {
    throw new Error('Invalid mystery transition');
  }
  const allowed = (expectedState === 'reserved' && state === 'running')
    || (expectedState === 'running' && ['running', 'countdown'].includes(state));
  if (!allowed || (state === 'countdown' && !winnerId) || (puzzleId && state !== 'countdown')) {
    throw new Error('Invalid mystery transition');
  }
  return transaction(db, () => {
    const session = getMysterySession(db, sessionId);
    if (session?.state !== expectedState || session.stateJson !== expectedStateJson) return { status: 'stale' };
    if (expectedState === 'reserved' && (!session.eventMessageId || now < session.nextAt)) {
      return { status: 'early' };
    }
    if (now >= session.deadlineAt) return { status: 'expired' };
    const next = state === 'countdown' ? (nextAt ?? now + 5_000) : nextAt;
    if (next != null && !validNow(next)) throw new Error('Invalid mystery transition');
    const serialized = stateJson === undefined ? session.stateJson : JSON.stringify(stateJson);
    const changed = db.prepare(`UPDATE mystery_sessions SET state = ?, state_json = ?, next_at = ?,
      winner_id = COALESCE(?, winner_id) WHERE id = ? AND state = ? AND state_json IS ?`)
      .run(state, serialized, next, winnerId, sessionId, expectedState, expectedStateJson).changes;
    if (changed !== 1) return { status: 'stale' };
    if (puzzleId) db.prepare(`INSERT INTO treasure_puzzle_wins (guild_id, puzzle_id, won_at)
      VALUES (?, ?, ?)`).run(session.guildId, puzzleId, now);
    return { status: 'advanced', session: getMysterySession(db, sessionId) };
  });
}

function finishMystery(db, sessionId, outcome, now) {
  const state = outcome === 'canceled' ? 'canceled' : outcome === 'failed' ? 'failed' : 'completed';
  const changed = db.prepare(`UPDATE mystery_sessions SET state = ?, outcome = ?, resolved_at = ?, next_at = NULL
    WHERE id = ? AND state IN ${ACTIVE_MYSTERY}`).run(state, outcome, now, sessionId).changes === 1;
  if (changed) db.prepare(`UPDATE character_rolls SET state = 'closed'
    WHERE mystery_session_id = ? AND state IN ('pending', 'open')`).run(sessionId);
  return changed;
}

export function endMysterySession(db, { sessionId, outcome, now = Date.now() }) {
  if (!Number.isSafeInteger(sessionId) || sessionId <= 0 || typeof outcome !== 'string' || !outcome.trim()
    || !validNow(now)) throw new Error('Invalid mystery resolution');
  return transaction(db, () => finishMystery(db, sessionId, outcome, now));
}

export function openMysteryClaim(db, { sessionId, messageId, now = Date.now() }) {
  if (!Number.isSafeInteger(sessionId) || sessionId <= 0 || !validId(messageId) || !validNow(now)) {
    throw new Error('Invalid mystery claim publication');
  }
  return transaction(db, () => {
    const session = getMysterySession(db, sessionId);
    if (session?.state !== 'countdown' || !session.winnerId) return { status: 'stale' };
    if (now < session.nextAt) return { status: 'early' };
    const character = db.prepare('SELECT 1 FROM characters WHERE id = ?').get(session.characterId);
    if (!character || getMarriage(db, session.guildId, session.characterId)) {
      finishMystery(db, sessionId, 'unavailable', now);
      return { status: 'unclaimable', reason: 'unavailable' };
    }
    if (!getClaimStatus(db, session.guildId, session.winnerId, now).canClaim) {
      finishMystery(db, sessionId, 'forfeited', now);
      return { status: 'unclaimable', reason: 'no_claim' };
    }
    const published = db.prepare(`UPDATE character_rolls SET message_id = ?, state = 'open',
      exclusive_user_id = ?, published_at = ?, expires_at = ?
      WHERE id = ? AND mystery_session_id = ? AND state = 'pending'`)
      .run(messageId, session.winnerId, now, now + WINDOW, session.originRollId, sessionId).changes === 1;
    if (!published) return { status: 'stale' };
    db.prepare("UPDATE mystery_sessions SET state = 'claim_open', next_at = ? WHERE id = ? AND state = 'countdown'")
      .run(now + WINDOW, sessionId);
    return { status: 'open', rollId: session.originRollId, expiresAt: now + WINDOW,
      winnerId: session.winnerId };
  });
}

export function cancelActiveMysteries(db, now = Date.now()) {
  if (!validNow(now)) throw new Error('Invalid mystery cancellation');
  return transaction(db, () => {
    const ids = db.prepare(`SELECT id FROM mystery_sessions WHERE state IN ${ACTIVE_MYSTERY}`).all();
    for (const { id } of ids) finishMystery(db, id, 'canceled', now);
    return ids.length;
  });
}

export function getRoll(db, guildId, channelId, messageId) {
  if (![guildId, channelId, messageId].every(validId)) return null;
  return db.prepare(`SELECT id, guild_id AS guildId, channel_id AS channelId,
    message_id AS messageId, character_id AS characterId,
    character_name AS characterName, state, published_at AS publishedAt,
    expires_at AS expiresAt, mystery_session_id AS mysterySessionId,
    exclusive_user_id AS exclusiveUserId, escape_marriage_id AS escapeMarriageId,
    escape_owner_id AS escapeOwnerId, protected_until AS protectedUntil,
    escape_outcome AS escapeOutcome, escape_winner_id AS escapeWinnerId,
    escape_resolved_at AS escapeResolvedAt FROM character_rolls
    WHERE guild_id = ? AND channel_id = ? AND message_id = ?`)
    .get(guildId, channelId, messageId) ?? null;
}

function originalMarriageExists(db, roll) {
  const marriage = getMarriage(db, roll.guildId, roll.characterId);
  return marriage?.id === roll.escapeMarriageId && marriage?.ownerId === roll.escapeOwnerId;
}

function closeEscape(db, roll, outcome, now, winnerId = null) {
  db.prepare(`UPDATE character_rolls SET state = 'closed', escape_outcome = ?,
    escape_winner_id = ?, escape_resolved_at = ? WHERE id = ? AND state = 'open'`)
    .run(outcome, winnerId, now, roll.id);
}

function settleEscape(db, roll, now) {
  if (!roll?.escapeMarriageId || roll.state !== 'open') return;
  if (!originalMarriageExists(db, roll)
    || !db.prepare('SELECT 1 FROM characters WHERE id = ?').get(roll.characterId)) {
    closeEscape(db, roll, 'canceled', now);
  } else if (now >= roll.expiresAt) {
    closeEscape(db, roll, 'expired', now);
  }
}

export function refreshEscapeRoll(db, guildId, channelId, messageId, now = Date.now()) {
  if (!validNow(now)) throw new Error('Invalid escape time');
  return transaction(db, () => {
    const roll = getRoll(db, guildId, channelId, messageId);
    settleEscape(db, roll, now);
    return getRoll(db, guildId, channelId, messageId);
  });
}

export function claimRoll(db, { guildId, channelId, messageId, userId, now = Date.now() }) {
  if (![guildId, channelId, messageId, userId].every(validId) || !validNow(now)) throw new Error('Invalid claim');
  return transaction(db, () => {
    const roll = getRoll(db, guildId, channelId, messageId);
    if (!roll) return { status: 'unknown' };
    if (roll.state !== 'open') return { status: 'closed' };
    if (roll.escapeMarriageId) {
      settleEscape(db, roll, now);
      if (getRoll(db, guildId, channelId, messageId).state !== 'open') {
        return { status: now >= roll.expiresAt ? 'expired' : 'closed' };
      }
      if (userId === roll.escapeOwnerId) {
        closeEscape(db, roll, 'reclaimed', now, userId);
        db.prepare("UPDATE character_rolls SET state = 'closed' WHERE guild_id = ? AND character_id = ? AND state = 'open'")
          .run(guildId, roll.characterId);
        return { status: 'reclaimed', characterName: roll.characterName, characterId: roll.characterId };
      }
      if (now < roll.protectedUntil) return { status: 'protected' };
    }
    if (now >= roll.expiresAt) return { status: 'expired' };
    if (roll.mysterySessionId) {
      const session = db.prepare('SELECT state FROM mystery_sessions WHERE id = ? AND guild_id = ?')
        .get(roll.mysterySessionId, guildId);
      if (session?.state !== 'claim_open') return { status: 'closed' };
      if (!roll.exclusiveUserId || roll.exclusiveUserId !== userId) return { status: 'protected' };
    }
    if (!roll.escapeMarriageId && getMarriage(db, guildId, roll.characterId)) {
      db.prepare("UPDATE character_rolls SET state = 'closed' WHERE guild_id = ? AND character_id = ? AND state = 'open'")
        .run(guildId, roll.characterId);
      if (roll.mysterySessionId) finishMystery(db, roll.mysterySessionId, 'unavailable', now);
      return { status: 'closed' };
    }
    const period = Math.floor((now + VIETNAM_OFFSET) / CLAIM_PERIOD);
    const allowance = db.prepare('SELECT period FROM claim_allowances WHERE guild_id = ? AND user_id = ?')
      .get(guildId, userId);
    if (allowance?.period === period) return { status: 'exhausted', resetAt: nextClaimReset(now), rollId: roll.id };
    if (roll.escapeMarriageId && !divorceCharacter(db, guildId, roll.characterId,
      roll.escapeOwnerId, roll.escapeMarriageId)) throw new Error('Escape marriage changed during transfer');
    const result = marryCharacter(db, guildId, roll.characterId, userId);
    if (result.status !== 'married') {
      if (roll.escapeMarriageId) throw new Error('Escape marriage transfer failed');
      if (result.status === 'already_owned' || result.status === 'already_yours') {
        db.prepare("UPDATE character_rolls SET state = 'closed' WHERE guild_id = ? AND character_id = ? AND state = 'open'")
          .run(guildId, roll.characterId);
        if (roll.mysterySessionId) finishMystery(db, roll.mysterySessionId, 'unavailable', now);
      }
      return { status: 'closed' };
    }
    db.prepare(`INSERT INTO claim_allowances (guild_id, user_id, period) VALUES (?, ?, ?)
      ON CONFLICT(guild_id, user_id) DO UPDATE SET period = excluded.period`)
      .run(guildId, userId, period);
    if (roll.escapeMarriageId) closeEscape(db, roll, 'married', now, userId);
    db.prepare("UPDATE character_rolls SET state = 'closed' WHERE guild_id = ? AND character_id = ? AND state = 'open'")
      .run(guildId, roll.characterId);
    if (roll.mysterySessionId) finishMystery(db, roll.mysterySessionId, 'claimed', now);
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
  db.prepare(`UPDATE character_rolls SET state = 'closed', escape_outcome = 'canceled', escape_resolved_at = ?
    WHERE escape_marriage_id IS NOT NULL AND state IN ('pending', 'open')`).run(now);
  db.prepare("UPDATE character_rolls SET state = 'failed' WHERE state = 'pending' AND mystery_session_id IS NULL").run();
  return db.prepare(`SELECT id, guild_id AS guildId, channel_id AS channelId,
    message_id AS messageId, character_id AS characterId, expires_at AS expiresAt
    FROM character_rolls WHERE state = 'open' AND mystery_session_id IS NULL AND expires_at > ?`).all(now);
}

export function cleanupRolls(db, now = Date.now()) {
  return transaction(db, () => {
    db.prepare(`DELETE FROM roll_notices WHERE roll_id IN
      (SELECT id FROM character_rolls WHERE published_at < ? OR escape_resolved_at < ? OR state = 'failed'
        OR mystery_session_id IN (SELECT id FROM mystery_sessions
          WHERE resolved_at < ? AND state IN ('completed', 'canceled', 'failed')))`)
      .run(now - REPORT_LIFETIME, now - REPORT_LIFETIME, now - REPORT_LIFETIME);
    return db.prepare(`DELETE FROM character_rolls WHERE published_at < ? OR escape_resolved_at < ? OR state = 'failed'
      OR mystery_session_id IN (SELECT id FROM mystery_sessions
        WHERE resolved_at < ? AND state IN ('completed', 'canceled', 'failed'))`)
      .run(now - REPORT_LIFETIME, now - REPORT_LIFETIME, now - REPORT_LIFETIME).changes;
  });
}
