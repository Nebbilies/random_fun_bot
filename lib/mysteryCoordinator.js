import { reserveRoll, getMysterySession, advanceMysterySession, endMysterySession } from './characterRolls.js';
import { getGameConfig } from './gameConfig.js';
import { characterLikesProjection } from './characterLikesProjection.js';
import { characterSnapshotFromState } from './characterSnapshot.js';
import { getUsableInventory } from './itemStorage.js';
import { getTreasurePuzzle } from './mysteryEvents/treasurePuzzles.js';
import { selectMysteryEvent, validateMysteryRoster } from './mysteryRoster.js';
import { doorsEvent } from './mysteryEvents/doors.js';
import { treasureHuntEvent } from './mysteryEvents/treasureHunt.js';
import { clueRevealEvent } from './mysteryEvents/clueReveal.js';
import { greedChamberEvent } from './mysteryEvents/greedChamber.js';
import { deadlockEvent } from './mysteryEvents/deadlock.js';
import { glassBridgeEvent } from './mysteryEvents/glassBridge.js';

const MAX_DURATION = 180_000;
const ANSWER_COOLDOWN = 3_000;
/** @type {Map<string, any>} */
const events = new Map([doorsEvent, treasureHuntEvent, clueRevealEvent, greedChamberEvent, deadlockEvent, glassBridgeEvent]
  .map((event) => [event.id, event]));
export const MYSTERY_ROSTER = Object.freeze(validateMysteryRoster([
  { id: 'doors', enabled: true, weight: 1 },
  { id: 'clue_reveal', enabled: true, weight: 1 },
  { id: 'greed_chamber', enabled: true, weight: 1 },
  { id: 'deadlock', enabled: true, weight: 1 },
  { id: 'glass_bridge', enabled: true, weight: 1 },
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

function eventRules(config, id) {
  return { ...config.mysteryEvents.roundTiming, ...config.mysteryEvents[id] };
}

export function getMysterySessionConfig(session) {
  return parsedState(session)?.gameConfig ?? getGameConfig();
}

export function selectedMysteryCharacter(db, session) {
  const snapshot = characterSnapshotFromState(parsedState(session), session.characterId, session.rankSnapshot);
  if (snapshot) return snapshot;
  // Explicit compatibility for sessions reserved before published snapshots.
  return db.prepare(`SELECT id, name_full, rank, favourites, ${characterLikesProjection(db)}, image_url, anime_titles FROM characters WHERE id = ?`)
    .get(session.characterId) ?? null;
}

/** The answer a Binoculars charge should reveal for the started minigame. */
function minigameAnswer(session, state) {
  if (session.eventId === 'doors') {
    const door = Number(state?.winningDoor);
    return door === 1 ? 'Left' : door === 2 ? 'Right' : null;
  }
  if (session.eventId === 'treasure_hunt') return getTreasurePuzzle(state?.puzzleId)?.answer ?? null;
  if (session.eventId === 'clue_reveal') return state?.title ?? null;
  return null;
}

/** Look up an available reveal without spending a charge; use requires roller consent. */
export function revealWithBinoculars(db, session, now = Date.now()) {
  const answer = minigameAnswer(session, parsedState(session));
  if (!answer) return null;
  const binoculars = getUsableInventory(db, session.guildId, session.rollerId, now)
    .find((item) => item.item_id === 'binoculars');
  if (!binoculars) return null;
  return { answer, inventoryId: binoculars.id };
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
  const gameConfig = structuredClone(options.gameConfig ?? getGameConfig(db, guildId));
  const enabled = gameConfig.mystery.enabled
    && (options.mysteryEnabled ?? process.env.MYSTERY_ROLLS_DISABLED !== '1');
  if (!enabled) return reserveRoll(db, { ...options, gameConfig });
  const eventChannelId = getMysteryEventChannel(db, guildId, channelId);
  return reserveRoll(db, { ...options, gameConfig, mystery: { eventChannelId,
    selectEvent: ({ db: source, character, guildId: serverId, userId, now, random }) => {
      const context = { db: source, guildId: serverId, rollerId: userId, character, now, random, gameConfig };
      const availableIds = [...events.values()].filter((event) => event.available({ ...context,
        rules: eventRules(gameConfig, event.id) })).map((event) => event.id);
      const roster = [...MYSTERY_ROSTER.map(({ id }) => id), 'treasure_hunt']
        .map((id) => ({ id, enabled: gameConfig.mysteryEvents[id].enabled,
          weight: gameConfig.mysteryEvents[id].weight }))
        .filter((entry) => entry.weight > 0);
      const entry = selectMysteryEvent(roster, availableIds, random);
      if (!entry) return null;
      const event = eventFor(entry.id);
      const durationMs = gameConfig.mysteryEvents[event.id].durationMs ?? event.durationMs;
      if (!Number.isSafeInteger(durationMs) || durationMs <= 0
        || durationMs > MAX_DURATION) throw new Error('Mystery event exceeds the global deadline');
      return { eventId: event.id, state: { gameConfig }, durationMs };
    },
  } });
}

export function beginMysteryEvent(db, sessionId, now = Date.now(), random = Math.random) {
  const session = getMysterySession(db, sessionId);
  if (!session || session.state !== 'reserved') return { status: 'stale' };
  if (now < session.nextAt) return { status: 'early', nextAt: session.nextAt };
  const character = selectedMysteryCharacter(db, session);
  if (now >= session.deadlineAt && session.eventId !== 'glass_bridge') {
    endMysterySession(db, { sessionId, outcome: 'no_winner', now });
    return { status: 'no_winner', session, character };
  }
  const event = eventFor(session.eventId);
  if (!event || !character) {
    endMysterySession(db, { sessionId, outcome: 'unavailable', now });
    return { status: 'unavailable', session, character };
  }
  const gameConfig = getMysterySessionConfig(session);
  const started = event.start({ db, guildId: session.guildId, rollerId: session.rollerId,
    character, now, random, gameConfig, rules: eventRules(gameConfig, event.id) });
  if (!started) {
    endMysterySession(db, { sessionId, outcome: 'unavailable', now });
    return { status: 'unavailable', session, character };
  }
  const nextAt = session.eventId === 'glass_bridge' ? now + started.nextInMs
    : Math.min(session.deadlineAt, now + (started.nextInMs ?? event.durationMs));
  const result = advanceMysterySession(db, { sessionId, expectedState: 'reserved',
    expectedStateJson: session.stateJson, state: 'running', stateJson: { ...started.state, gameConfig, runtime: {
      version: 1, phase: 'running', view: started.view, remaining: parsedState(session)?.runtime?.remaining,
      introMessageId: session.eventMessageId, eventMessageId: null,
    } },
    nextAt, now, ...(session.eventId === 'glass_bridge'
      ? { deadlineAt: now + started.nextInMs + MAX_DURATION } : {}) });
  return result.status === 'advanced'
    ? { status: 'started', session: result.session, view: started.view, character,
      reveal: revealWithBinoculars(db, result.session) }
    : result;
}

function answerCooldown(db, sessionId, userId, now, cooldownMs = ANSWER_COOLDOWN) {
  let bySession = answerTimes.get(db);
  if (!bySession) { bySession = new Map(); answerTimes.set(db, bySession); }
  let byUser = bySession.get(sessionId);
  if (!byUser) { byUser = new Map(); bySession.set(sessionId, byUser); }
  const last = byUser.get(userId);
  if (last !== undefined && now - last < cooldownMs) return false;
  byUser.set(userId, now);
  return true;
}

function clearAnswerCooldown(db, sessionId) {
  answerTimes.get(db)?.delete(sessionId);
}

export function advanceMysteryEvent(db, { sessionId, guildId, channelId, input, now = Date.now(), random = Math.random }) {
  const session = getMysterySession(db, sessionId);
  if (!session || session.state !== 'running') return { status: 'stale' };
  if ((guildId && session.guildId !== guildId) || (channelId && session.eventChannelId !== channelId)) {
    return { status: 'wrong_channel' };
  }
  const character = selectedMysteryCharacter(db, session);
  if (now >= session.deadlineAt && session.eventId !== 'glass_bridge') {
    endMysterySession(db, { sessionId, outcome: 'no_winner', now });
    clearAnswerCooldown(db, sessionId);
    return { status: 'no_winner', session, character,
      answer: parsedState(session)?.title ?? null };
  }
  const gameConfig = getMysterySessionConfig(session);
  if (input?.type === 'answer' && (!validId(input.userId)
    || !answerCooldown(db, sessionId, input.userId, now, gameConfig.mystery.answerCooldownMs))) return { status: 'cooldown' };
  const event = eventFor(session.eventId);
  if (!event) return { status: 'stale' };
  const advanced = event.advance({ db, guildId: session.guildId, state: parsedState(session), input, now, random,
    gameConfig, rules: eventRules(gameConfig, event.id) });
  const previous = parsedState(session)?.runtime;
  advanced.state = { ...advanced.state, gameConfig, runtime: {
    ...previous, version: 1, phase: 'running',
    view: advanced.view ?? advanced.views?.at(-1) ?? previous?.view,
  } };
  if (advanced.outcome) advanced.state.runtime = {
    ...advanced.state.runtime, phase: 'countdown',
    resolved: { type: advanced.outcome.type, winnerId: advanced.outcome.userId ?? null,
      selected: session.eventId === 'doors' ? Number(input.value) : null },
  };
  if (session.eventId === 'doors' && input.type === 'button' && advanced.outcome?.type === 'no_winner') {
    const moved = advanceMysterySession(db, { sessionId, expectedState: 'running',
      expectedStateJson: session.stateJson, state: 'countdown', stateJson: advanced.state,
      winnerId: session.rollerId, nextAt: now + gameConfig.mystery.winnerDelayMs, now });
    return moved.status === 'advanced' ? { status: 'doors_lost', session: moved.session } : moved;
  }
  if (advanced.outcome?.type === 'no_winner') {
    const saved = advanceMysterySession(db, { sessionId, expectedState: 'running',
      expectedStateJson: session.stateJson, state: 'running', stateJson: advanced.state, now,
      ...(session.eventId === 'glass_bridge' ? { deadlineAt: now + MAX_DURATION } : {}) });
    if (saved.status !== 'advanced') return saved;
    endMysterySession(db, { sessionId, outcome: 'no_winner', now });
    clearAnswerCooldown(db, sessionId);
    return { status: 'no_winner', session, character,
      answer: advanced.outcome.answer ?? null, views: advanced.views ?? [], view: advanced.view ?? null };
  }
  const winner = advanced.outcome?.type === 'winner';
  const nextAt = winner ? now + gameConfig.mystery.winnerDelayMs
    : advanced.nextInMs == null ? session.nextAt
      : session.eventId === 'glass_bridge' ? now + advanced.nextInMs
        : Math.min(session.deadlineAt, now + advanced.nextInMs);
  const result = advanceMysterySession(db, { sessionId, expectedState: 'running',
    expectedStateJson: session.stateJson, state: winner ? 'countdown' : 'running',
    stateJson: advanced.state, nextAt, winnerId: winner ? advanced.outcome.userId : null,
    puzzleId: winner ? advanced.outcome.puzzleId ?? null : null, now, random,
    ...(session.eventId === 'glass_bridge' ? { deadlineAt: (nextAt ?? now) + MAX_DURATION } : {}) });
  if (result.status !== 'advanced') return result;
  if (winner) clearAnswerCooldown(db, sessionId);
  return { status: winner ? 'winner' : 'ongoing', session: result.session,
    character: winner ? character : null,
    view: advanced.view ?? null, views: advanced.views ?? [], feedback: advanced.feedback ?? null,
    answer: advanced.outcome?.answer ?? null };
}

export function activeMysteryInGuild(db, guildId) {
  if (!validId(guildId)) return null;
  return db.prepare(`SELECT id FROM mystery_sessions WHERE guild_id = ?
    AND state IN ('reserved', 'running', 'countdown', 'claim_open') LIMIT 1`).get(guildId)?.id ?? null;
}
