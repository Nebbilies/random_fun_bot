import assert from 'node:assert/strict';
import { test } from 'node:test';
import { greedChamberEvent as greed } from '../lib/mysteryEvents/greedChamber.js';
import { deadlockEvent as deadlock } from '../lib/mysteryEvents/deadlock.js';
import { closesAt, RESULT_DURATION_MS, SAFETY_DURATION_MS } from '../lib/mysteryEvents/roundContest.js';

const close = (round) => closesAt({ startedAt: 0, round });
const open = (round) => round === 1 ? 0 : close(round - 1) + RESULT_DURATION_MS;
const SURVIVE = 1 - Number.EPSILON;

function game(event, random = () => SURVIVE) {
  let state = event.start({ now: 0 }).state;
  return {
    get state() { return state; },
    move(now, userId, value, round = state.round) {
      const result = event.advance({ state, now, random,
        input: { type: 'button', round, userId, value } });
      state = result.state;
      return result;
    },
    tick(now) {
      const result = event.advance({ state, now, random, input: { type: 'timer' } });
      state = result.state;
      return result;
    },
  };
}

test('round contests allow time to join, choose, and read results within the safety timeout', () => {
  assert.equal(close(1), 30_000);
  assert.equal(RESULT_DURATION_MS, 8_000);
  for (let round = 2; round <= 5; round++) {
    assert.equal(close(round) - open(round), 20_000);
  }
  assert.equal(close(3), 86_000);
  assert.equal(close(5), 142_000);
  assert.ok(SAFETY_DURATION_MS > close(5) + RESULT_DURATION_MS);
});

test('Greed revisions stay private, entry locks, and Escape banks before a shared collapse', () => {
  const draws = [SURVIVE, 0][Symbol.iterator]();
  const g = game(greed, () => draws.next().value);
  const joined = g.move(1, '101', 'escape');
  assert.equal(joined.feedback.choice, 'Escape');
  assert.deepEqual(joined.views[0].lines, ['**Banked standings**', '<@101>: 0']);
  assert.doesNotMatch(JSON.stringify(joined.views), /\d+%/);
  assert.equal(g.move(2, '101', 'stay').feedback.choice, 'Stay');
  g.move(3, '102', 'stay');
  g.tick(close(1));
  assert.equal(g.state.players['101'].score, 1);
  assert.equal(g.move(close(1) + 1, '101', 'escape').feedback.type, 'rejected');
  g.tick(open(2));
  assert.equal(g.move(open(2) + 1, '103', 'stay').feedback.type, 'rejected');
  g.move(open(2) + 2, '101', 'escape');
  g.move(open(2) + 3, '102', 'stay');
  const ended = g.tick(close(2));
  assert.deepEqual(ended.outcome, { type: 'winner', userId: '101' });
  assert.equal(g.state.players['101'].banked, 1);
  assert.equal(g.state.players['102'].status, 'collapsed');
  assert.match(JSON.stringify(ended.views), /chamber collapsed/);
});

test('Greed uses exactly one collapse draw for all staying players', () => {
  let calls = 0;
  const g = game(greed, () => { calls++; return 0; });
  for (const id of ['101', '102', '103']) g.move(1, id, 'stay');
  assert.deepEqual(g.tick(close(1)).outcome, { type: 'no_winner' });
  assert.equal(calls, 1);
  assert.ok(Object.values(g.state.players).every((player) => player.status === 'collapsed'));
});

test('Greed distinguishes final Stay from a missed decision', () => {
  const g = game(greed);
  for (const id of ['101', '102']) g.move(1, id, 'stay');
  for (let round = 1; round <= 4; round++) {
    if (round > 1) {
      const opens = open(round);
      g.tick(opens);
      g.move(opens + 1, '101', 'stay');
      g.move(opens + 1, '102', 'stay');
    }
    g.tick(close(round));
  }
  g.tick(open(5));
  g.move(open(5) + 1, '101', 'stay');
  const end = g.tick(close(5));
  assert.deepEqual(end.outcome, { type: 'winner', userId: '101' });
  assert.equal(g.state.players['101'].banked, 15);
  assert.equal(g.state.players['102'].banked, 10);
  assert.match(JSON.stringify(end.views), /Automatically escaped/);
});

test('Greed catches up missed windows without moving their cutoffs or accepting late choices', () => {
  const g = game(greed);
  g.move(1, '101', 'stay');
  const late = g.move(close(5) + 1, '101', 'stay', 1);
  assert.deepEqual(late.outcome, { type: 'winner', userId: '101' });
  assert.equal(g.state.round, 2);
  assert.equal(g.state.players['101'].banked, 1, 'missed round 2 automatically escapes');
  assert.equal(late.views.filter((view) => view.phase === 'choice').length, 0);
});

test('Greed empty and zero escapes have no winner; equal positive banks choose a tied player', () => {
  assert.deepEqual(game(greed).tick(close(1)).outcome, { type: 'no_winner' });
  const zero = game(greed);
  zero.move(1, '101', 'escape');
  assert.deepEqual(zero.tick(close(1)).outcome, { type: 'no_winner' });
  for (const tieDraw of [0, SURVIVE]) {
    const draws = [SURVIVE, tieDraw][Symbol.iterator]();
    const g = game(greed, () => draws.next().value);
    g.move(1, '101', 'stay');
    g.move(1, '102', 'stay');
    g.tick(close(1));
    g.tick(open(2));
    g.move(open(2) + 1, '101', 'escape');
    g.move(open(2) + 2, '102', 'escape');
    assert.equal(g.tick(close(2)).outcome.userId, tieDraw === 0 ? '101' : '102');
    assert.equal(g.move(close(2) + 1, '101', 'stay').outcome, undefined, 'terminal states never pick another winner');
  }
});

test('Deadlock evaluates final picks, duplicates, misses and late entrants over three rounds', () => {
  const g = game(deadlock);
  g.move(1, '101', '5');
  g.move(2, '102', '5');
  g.move(3, '103', '3');
  const revision = g.move(4, '103', '4');
  assert.equal(revision.feedback.choice, '4');
  assert.deepEqual(revision.views, [], 'revisions never publish current picks');
  const first = g.tick(close(1));
  assert.equal(g.state.players['101'].score, 0);
  assert.equal(g.state.players['103'].score, 4);
  assert.match(JSON.stringify(first.views), /picked 4.*total 4/);
  g.tick(open(2));
  g.move(open(2) + 1, '104', '5');
  g.tick(close(2));
  assert.equal(g.state.players['103'].score, 4, 'previous picks do not carry forward');
  assert.equal(g.state.players['104'].score, 5);
  g.tick(open(3));
  g.move(open(3) + 1, '101', '5');
  g.move(open(3) + 2, '105', '3');
  const end = g.tick(close(3));
  assert.equal(g.state.players['101'].score, 5, 'a player may return after missing a round');
  assert.equal(g.state.players['105'].score, 3, 'late entrants get no credit for earlier rounds');
  assert.equal(end.outcome.userId, '104', 'the injected high draw chooses the last tied leader');
});

test('Deadlock preserves absolute cutoffs, rejects stale and invalid picks, and allows empty rounds', () => {
  const g = game(deadlock);
  assert.equal(g.move(1, '101', '6').feedback.type, 'rejected');
  assert.equal(g.move(1, 'not-a-user', '1').feedback.type, 'rejected');
  const late = g.move(close(1), '101', '5', 1);
  assert.equal(late.feedback.type, 'rejected');
  assert.equal(g.state.phase, 'result');
  g.tick(open(3));
  assert.equal(g.state.round, 3);
  assert.equal(g.move(open(3) + 1, '101', '5', 2).feedback.type, 'rejected');
  g.move(open(3) + 2, '101', '4', 3);
  const end = g.tick(close(3) + 1);
  assert.deepEqual(end.outcome, { type: 'winner', userId: '101' });
});

test('Deadlock empty or fully colliding rounds yield no winner and catch up without expired prompts', () => {
  const empty = game(deadlock).tick(close(3) + 1);
  assert.deepEqual(empty.outcome, { type: 'no_winner' });
  assert.equal(empty.views.length, 3);
  assert.ok(empty.views.every((view) => view.phase !== 'choice'));
  const g = game(deadlock);
  for (let round = 1; round <= 3; round++) {
    if (round > 1) g.tick(open(round));
    const at = open(round) + 1;
    g.move(at, '101', '5');
    g.move(at, '102', '5');
    const result = g.tick(close(round));
    if (round === 3) assert.deepEqual(result.outcome, { type: 'no_winner' });
  }
});
