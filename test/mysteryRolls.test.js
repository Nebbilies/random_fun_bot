import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCatalog } from '../lib/catalogDb.js';
import {
  advanceMysterySession, cancelActiveMysteries, claimRoll, cleanupRolls, endMysterySession,
  failRoll, getMysterySession, getRollStatus, openMysteryClaim,
  publishMysteryIntro, publishRoll, recoverRolls, reserveRoll,
} from '../lib/characterRolls.js';

const start = Date.parse('2026-10-15T17:00:00Z');

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mystery-rolls-'));
  const db = openCatalog(join(dir, 'catalog.sqlite'));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  db.exec(`INSERT INTO characters (id,rank,favourites,name_full,gender) VALUES
    (1,1,100,'First','Female'),(2,2,90,'Second','Female'),(3,3,80,'Third','Male')`);
  return db;
}

function normal(db, commandMessageId, now = start, random = () => 0) {
  return reserveRoll(db, { guildId: '1', channelId: '10', commandMessageId,
    userId: '101', pool: 'w', now, random });
}

function mystery(db, commandMessageId = '100', selectEvent = () => ({
  eventId: 'doors', state: { winningDoor: 2 }, durationMs: 60_000,
})) {
  return reserveRoll(db, { guildId: '1', channelId: '10', commandMessageId,
    userId: '101', pool: 'w', now: start, random: () => 0,
    mystery: { eventChannelId: '20', selectEvent } });
}

function startEvent(db, reservation) {
  assert.equal(publishMysteryIntro(db, reservation.sessionId, '900', start + 1_000), true);
  const intro = getMysterySession(db, reservation.sessionId);
  const started = advanceMysterySession(db, { sessionId: reservation.sessionId,
    expectedState: 'reserved', expectedStateJson: intro.stateJson,
    state: 'running', now: start + 6_000 });
  assert.equal(started.status, 'advanced');
  return started.session;
}

test('mystery reserves one roll, pauses guild, and starts five seconds after intro', (t) => {
  const db = fixture(t);
  const picked = mystery(db);
  assert.equal(picked.status, 'mystery');
  assert.equal(picked.character.id, 1);
  assert.equal(picked.remaining, 6);
  assert.equal(db.prepare('SELECT channel_id FROM character_rolls WHERE id = ?').get(picked.rollId).channel_id, '20');
  assert.equal(getRollStatus(db, '1', '101', start).remaining, 6);
  assert.equal(normal(db, '101').status, 'paused');
  assert.equal(mystery(db).status, 'duplicate');
  assert.equal(getRollStatus(db, '1', '101', start).remaining, 6);
  assert.equal(publishMysteryIntro(db, picked.sessionId, '900', start + 1_000), true);
  const intro = getMysterySession(db, picked.sessionId);
  assert.equal(intro.state, 'reserved');
  assert.equal(intro.eventMessageId, '900');
  assert.equal(intro.nextAt, start + 6_000);
  assert.equal(intro.deadlineAt, start + 66_000);
  assert.equal(advanceMysterySession(db, { sessionId: picked.sessionId,
    expectedState: 'reserved', expectedStateJson: intro.stateJson,
    state: 'running', now: start + 5_999 }).status, 'early');
  assert.equal(advanceMysterySession(db, { sessionId: picked.sessionId,
    expectedState: 'reserved', expectedStateJson: intro.stateJson,
    state: 'running', now: start + 6_000 }).status, 'advanced');
  assert.equal(endMysterySession(db, { sessionId: picked.sessionId, outcome: 'lost', now: start + 10_000 }), true);
  assert.equal(db.prepare('SELECT state FROM character_rolls WHERE id = ?').get(picked.rollId).state, 'closed');
  assert.equal(getMysterySession(db, picked.sessionId).outcome, 'lost');
  assert.equal(normal(db, '102').status, 'reserved');
});

test('unavailable mystery falls back to one ordinary roll and active pause does not charge', (t) => {
  const db = fixture(t);
  const fallback = mystery(db, '200', () => null);
  assert.equal(fallback.status, 'reserved');
  assert.equal(getRollStatus(db, '1', '101', start).remaining, 6);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM character_rolls').get().n, 1);
  failRoll(db, fallback.rollId);
  const active = mystery(db, '201');
  assert.equal(active.status, 'mystery');
  assert.equal(normal(db, '202').status, 'paused');
  assert.equal(getRollStatus(db, '1', '101', start).remaining, 5);
  assert.equal(failRoll(db, active.rollId), true);
  assert.equal(getMysterySession(db, active.sessionId).state, 'failed');
  assert.equal(normal(db, '203').status, 'reserved');
});

test('pending and unexpired public cards are excluded; expired open cards are eligible', (t) => {
  const db = fixture(t);
  const first = normal(db, '300');
  const second = normal(db, '301');
  assert.equal(first.character.id, 1);
  assert.equal(second.character.id, 2);
  assert.equal(normal(db, '302').status, 'empty');
  publishRoll(db, first.rollId, '800', start);
  failRoll(db, second.rollId);
  assert.equal(normal(db, '303').character.id, 2);
  assert.equal(normal(db, '304', start + 60_000).character.id, 1);
});

test('stale state update cannot overwrite a newer guess or winner', (t) => {
  const db = fixture(t);
  const picked = mystery(db);
  const running = startEvent(db, picked);
  const guessed = advanceMysterySession(db, { sessionId: picked.sessionId,
    expectedState: 'running', expectedStateJson: running.stateJson,
    state: 'running', stateJson: { winningDoor: 2, guesses: 1 }, now: start + 7_000 });
  assert.equal(guessed.status, 'advanced');
  assert.equal(advanceMysterySession(db, { sessionId: picked.sessionId,
    expectedState: 'running', expectedStateJson: running.stateJson,
    state: 'countdown', winnerId: '102', now: start + 7_001 }).status, 'stale');
  const won = advanceMysterySession(db, { sessionId: picked.sessionId,
    expectedState: 'running', expectedStateJson: guessed.session.stateJson,
    state: 'countdown', winnerId: '102', puzzleId: 'puzzle-1', now: start + 7_002 });
  assert.equal(won.status, 'advanced');
  assert.equal(won.session.nextAt, start + 12_002);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM treasure_puzzle_wins').get().n, 1);
  assert.equal(advanceMysterySession(db, { sessionId: picked.sessionId,
    expectedState: 'running', expectedStateJson: guessed.session.stateJson,
    state: 'countdown', winnerId: '103', now: start + 7_003 }).status, 'stale');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM treasure_puzzle_wins').get().n, 1);
});

test('winner-only claim is atomic and ends the event', (t) => {
  const db = fixture(t);
  const picked = mystery(db);
  const running = startEvent(db, picked);
  const won = advanceMysterySession(db, { sessionId: picked.sessionId,
    expectedState: 'running', expectedStateJson: running.stateJson,
    state: 'countdown', winnerId: '102', now: start + 7_000 });
  assert.equal(won.status, 'advanced');
  assert.equal(openMysteryClaim(db, { sessionId: picked.sessionId,
    messageId: '901', now: start + 11_999 }).status, 'early');
  const opened = openMysteryClaim(db, { sessionId: picked.sessionId,
    messageId: '901', now: start + 12_000 });
  assert.equal(opened.status, 'open');
  assert.equal(claimRoll(db, { guildId: '1', channelId: '20', messageId: '901',
    userId: '103', now: start + 12_001 }).status, 'protected');
  assert.equal(claimRoll(db, { guildId: '1', channelId: '20', messageId: '901',
    userId: '102', now: start + 12_002 }).status, 'married');
  assert.equal(getMysterySession(db, picked.sessionId).outcome, 'claimed');
  assert.equal(getMysterySession(db, picked.sessionId).state, 'completed');
  assert.equal(db.prepare('SELECT owner_id FROM marriages WHERE character_id = 1').get().owner_id, '102');
  assert.equal(normal(db, '101').status, 'reserved');
});

test('winner without claim forfeits and restart cancels only mystery cards', (t) => {
  const db = fixture(t);
  const ordinary = normal(db, '500', start, () => 0.99);
  publishRoll(db, ordinary.rollId, '950', start);
  const picked = mystery(db);
  const running = startEvent(db, picked);
  const won = advanceMysterySession(db, { sessionId: picked.sessionId,
    expectedState: 'running', expectedStateJson: running.stateJson,
    state: 'countdown', winnerId: '102', now: start + 7_000 });
  assert.equal(won.status, 'advanced');
  const period = Math.floor((start + 7 * HOUR) / (3 * HOUR));
  db.prepare('INSERT INTO claim_allowances (guild_id, user_id, period) VALUES (?, ?, ?)')
    .run('1', '102', period);
  assert.deepEqual(openMysteryClaim(db, { sessionId: picked.sessionId,
    messageId: '951', now: start + 12_000 }), { status: 'unclaimable', reason: 'no_claim' });
  assert.equal(getMysterySession(db, picked.sessionId).outcome, 'forfeited');
  const next = mystery(db, '501');
  assert.equal(next.status, 'mystery');
  assert.equal(cancelActiveMysteries(db, start + 20_000), 1);
  assert.equal(getMysterySession(db, next.sessionId).state, 'canceled');
  assert.equal(db.prepare('SELECT state FROM character_rolls WHERE id = ?').get(next.rollId).state, 'closed');
  assert.equal(recoverRolls(db, start + 20_000).length, 1);
  assert.equal(db.prepare('SELECT state FROM character_rolls WHERE id = ?').get(ordinary.rollId).state, 'open');
});

test('cleanup removes an unpublished terminal card but retains outcome history', (t) => {
  const db = fixture(t);
  const picked = mystery(db);
  assert.equal(endMysterySession(db, { sessionId: picked.sessionId,
    outcome: 'timeout', now: start + 10_000 }), true);
  assert.equal(db.prepare('SELECT state FROM character_rolls WHERE id = ?').get(picked.rollId).state, 'closed');
  assert.equal(cleanupRolls(db, start + 10_000 + HOUR), 0);
  assert.equal(cleanupRolls(db, start + 10_000 + HOUR + 1), 1);
  assert.equal(db.prepare('SELECT 1 FROM character_rolls WHERE id = ?').get(picked.rollId), undefined);
  assert.equal(getMysterySession(db, picked.sessionId).outcome, 'timeout');
});

const HOUR = 3_600_000;
