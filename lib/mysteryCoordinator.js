import { reserveRoll, getMysterySession, advanceMysterySession, endMysterySession } from './characterRolls.js';
import { selectMysteryEvent, validateMysteryRoster } from './mysteryRoster.js';
import { doorsEvent } from './mysteryEvents/doors.js';
import { treasureHuntEvent } from './mysteryEvents/treasureHunt.js';
import { clueRevealEvent } from './mysteryEvents/clueReveal.js';

const MAX_DURATION = 180_000;
const ANSWER_COOLDOWN = 3_000;
/** @type {Map<string, any>} */
const events = new Map([doorsEvent, treasureHuntEvent, clueRevealEvent].map((event) => [event.id, event]));
export const MYSTERY_ROSTER = Object.freeze(validateMysteryRoster([
  { id: 'doors', enabled: true, weight: 1 },
  { id: 'treasure_hunt', enabled: true, weight: 1 },
  { id: 'clue_reveal', enabled: true, weight: 1 },
]));
const answerTimes = new WeakMap();

function validId(id) {
  return typeof id === 'string' && /^\d+$/.test(id);
}

function eventFor(id) {
  return events.get(id) ?? null;
}

function parsedState(session) {
  return JSON.parse(session.stateJson || 'null');
}

function selectedCharacter(db, session) {
  return db.prepare('SELECT id, name_full, rank, favourites, image_url, anime_titles FROM characters WHERE id = ?')
    .get(session.characterId) ?? null;
}

export function getMysteryEventChannel(db, guildId, fallbackChannelId) {
  if (!validId(guildId) || !validId(fallbackChannelId)) throw new Error('Invalid mystery channel lookup');
  return db.prepare('SELECT event_channel_id FROM guild_mystery_settings WHERE guild_id = ?')
    .get(guildId)?.event_channel_id ?? fallbackChannelId;
}

export function setMysteryEventChannel(db, guildId, channelId) {
  if (!validId(guildId) || (channelId !== null && !validId(channelId))) {
    throw new Error('Invalid mystery channel setting');
  }
  if (channelId === null) {
    db.prepare('DELETE FROM guild_mystery_settings WHERE guild_id = ?').run(guildId);
  } else {
    db.prepare(`INSERT INTO guild_mystery_settings (guild_id, event_channel_id) VALUES (?, ?)
      ON CONFLICT(guild_id) DO UPDATE SET event_channel_id = excluded.event_channel_id`).run(guildId, channelId);
  }
}

export function reserveMysteryAwareRoll(db, options) {
  const { guildId, channelId } = options;
  const enabled = options.mysteryEnabled ?? process.env.MYSTERY_ROLLS_DISABLED !== '1';
  if (!enabled) return reserveRoll(db, options);
  const eventChannelId = getMysteryEventChannel(db, guildId, channelId);
  return reserveRoll(db, { ...options, mystery: { eventChannelId,
    selectEvent: ({ db: source, character, guildId: serverId, userId, now, random }) => {
      const context = { db: source, guildId: serverId, rollerId: userId, character, now, random };
      const availableIds = [...events.values()].filter((event) => event.available(context)).map((event) => event.id);
      const entry = selectMysteryEvent(MYSTERY_ROSTER, availableIds, random);
      if (!entry) return null;
      const event = eventFor(entry.id);
      if (!Number.isSafeInteger(event.durationMs) || event.durationMs <= 0
        || event.durationMs > MAX_DURATION) throw new Error('Mystery event exceeds the global deadline');
      return { eventId: event.id, state: null, durationMs: event.durationMs };
    },
  } });
}

export function beginMysteryEvent(db, sessionId, now = Date.now(), random = Math.random) {
  const session = getMysterySession(db, sessionId);
  if (!session || session.state !== 'reserved') return { status: 'stale' };
  if (now < session.nextAt) return { status: 'early', nextAt: session.nextAt };
  if (now >= session.deadlineAt) {
    endMysterySession(db, { sessionId, outcome: 'no_winner', now });
    return { status: 'no_winner', session, character: selectedCharacter(db, session) };
  }
  const event = eventFor(session.eventId);
  const character = selectedCharacter(db, session);
  if (!event || !character) {
    endMysterySession(db, { sessionId, outcome: 'unavailable', now });
    return { status: 'unavailable', session, character };
  }
  const started = event.start({ db, guildId: session.guildId, rollerId: session.rollerId,
    character, now, random });
  if (!started) {
    endMysterySession(db, { sessionId, outcome: 'unavailable', now });
    return { status: 'unavailable', session, character };
  }
  const nextAt = Math.min(session.deadlineAt, now + (started.nextInMs ?? event.durationMs));
  const result = advanceMysterySession(db, { sessionId, expectedState: 'reserved',
    expectedStateJson: session.stateJson, state: 'running', stateJson: started.state,
    nextAt, now });
  return result.status === 'advanced'
    ? { status: 'started', session: result.session, view: started.view, character }
    : result;
}

function answerCooldown(db, sessionId, userId, now) {
  let bySession = answerTimes.get(db);
  if (!bySession) { bySession = new Map(); answerTimes.set(db, bySession); }
  let byUser = bySession.get(sessionId);
  if (!byUser) { byUser = new Map(); bySession.set(sessionId, byUser); }
  const last = byUser.get(userId);
  if (last !== undefined && now - last < ANSWER_COOLDOWN) return false;
  byUser.set(userId, now);
  return true;
}

function clearAnswerCooldown(db, sessionId) {
  answerTimes.get(db)?.delete(sessionId);
}

export function advanceMysteryEvent(db, { sessionId, guildId, channelId, input, now = Date.now() }) {
  const session = getMysterySession(db, sessionId);
  if (!session || session.state !== 'running') return { status: 'stale' };
  if ((guildId && session.guildId !== guildId) || (channelId && session.eventChannelId !== channelId)) {
    return { status: 'wrong_channel' };
  }
  if (now >= session.deadlineAt) {
    endMysterySession(db, { sessionId, outcome: 'no_winner', now });
    clearAnswerCooldown(db, sessionId);
    return { status: 'no_winner', session, character: selectedCharacter(db, session),
      answer: parsedState(session)?.title ?? null };
  }
  if (input?.type === 'answer' && (!validId(input.userId)
    || !answerCooldown(db, sessionId, input.userId, now))) return { status: 'cooldown' };
  const event = eventFor(session.eventId);
  if (!event) return { status: 'stale' };
  const advanced = event.advance({ db, guildId: session.guildId, state: parsedState(session), input, now });
  if (advanced.outcome?.type === 'no_winner') {
    endMysterySession(db, { sessionId, outcome: 'no_winner', now });
    clearAnswerCooldown(db, sessionId);
    return { status: 'no_winner', session, character: selectedCharacter(db, session),
      answer: advanced.outcome.answer ?? null };
  }
  const winner = advanced.outcome?.type === 'winner';
  const nextAt = winner ? now + 3_000
    : advanced.nextInMs == null ? session.nextAt
      : Math.min(session.deadlineAt, now + advanced.nextInMs);
  const result = advanceMysterySession(db, { sessionId, expectedState: 'running',
    expectedStateJson: session.stateJson, state: winner ? 'countdown' : 'running',
    stateJson: advanced.state, nextAt, winnerId: winner ? advanced.outcome.userId : null,
    puzzleId: winner ? advanced.outcome.puzzleId ?? null : null, now });
  if (result.status !== 'advanced') return result;
  if (winner) clearAnswerCooldown(db, sessionId);
  return { status: winner ? 'winner' : 'ongoing', session: result.session,
    character: winner ? selectedCharacter(db, session) : null,
    view: advanced.view ?? null, feedback: advanced.feedback ?? null,
    answer: advanced.outcome?.answer ?? null };
}

export function activeMysteryInGuild(db, guildId) {
  if (!validId(guildId)) return null;
  return db.prepare(`SELECT id FROM mystery_sessions WHERE guild_id = ?
    AND state IN ('reserved', 'running', 'countdown', 'claim_open') LIMIT 1`).get(guildId)?.id ?? null;
}
