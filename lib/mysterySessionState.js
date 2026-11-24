import { currentSeasonRows } from './seasonSchema.js';
import { hasAffection, cancelAppearanceInTransaction } from './characterAffection.js';

const ACTIVE_MYSTERY = "('reserved', 'running', 'countdown', 'claim_open')";

export function getMysterySession(db, sessionId) {
  if (!Number.isSafeInteger(sessionId) || sessionId <= 0) return null;
  return db.prepare(`SELECT id, guild_id AS guildId, origin_roll_id AS originRollId,
    event_id AS eventId, character_id AS characterId, rank_snapshot AS rankSnapshot,
    roller_id AS rollerId, event_channel_id AS eventChannelId,
    event_message_id AS eventMessageId, state, state_json AS stateJson,
    started_at AS startedAt, next_at AS nextAt, deadline_at AS deadlineAt,
    winner_id AS winnerId, resolved_at AS resolvedAt, outcome
    FROM ${currentSeasonRows(db,'mystery_sessions')} WHERE id = ?`).get(sessionId) ?? null;
}

// Caller owns the write transaction, including roll and affection settlement.
export function finishMystery(db, sessionId, outcome, now) {
  if (!getMysterySession(db,sessionId)) return false;
  const state = outcome === 'canceled' ? 'canceled' : outcome === 'failed' ? 'failed' : 'completed';
  const changed = db.prepare(`UPDATE mystery_sessions SET state = ?, outcome = ?, resolved_at = ?, next_at = NULL
    WHERE id = ? AND state IN ${ACTIVE_MYSTERY}`).run(state, outcome, now, sessionId).changes === 1;
  if (changed) {
    db.prepare(`UPDATE character_rolls SET state = 'closed'
      WHERE mystery_session_id = ? AND state IN ('pending', 'open')`).run(sessionId);
    if (hasAffection(db)) {
      const session = getMysterySession(db, sessionId);
      const origin = db.prepare('SELECT rules_json FROM character_rolls WHERE id=?').get(session.originRollId);
      const terms = origin?.rules_json ? JSON.parse(origin.rules_json) : {};
      if (terms.affectionVersion === 1) {
        if (['canceled','failed'].includes(outcome)) cancelAppearanceInTransaction(db, terms.affectionSourceKey, now);
        else {
          const captured = db.prepare(`SELECT state FROM ${currentSeasonRows(db,'affection_contexts')} WHERE source_key=?`).get(terms.affectionSourceKey);
          if (captured?.state === 'captured') {
            const state = JSON.parse(session.stateJson || '{}');
            state.runtime = { ...state.runtime, affectionRevealPending: true };
            db.prepare('UPDATE mystery_sessions SET state_json=? WHERE id=?').run(JSON.stringify(state),sessionId);
          }
        }
      }
    }
  }
  return changed;
}
