import test from 'node:test';
import assert from 'node:assert/strict';
import { glassBridgeEvent } from '../lib/mysteryEvents/glassBridge.js';
import { MYSTERY_ROSTER } from '../lib/mysteryCoordinator.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCatalog } from '../lib/catalogDb.js';
import { getConfigView, saveConfigSection } from '../lib/gameConfig.js';
import { getMysterySession, publishMysteryIntro } from '../lib/characterRolls.js';
import { reserveMysteryAwareRoll, beginMysteryEvent, advanceMysteryEvent } from '../lib/mysteryCoordinator.js';

test('Glass Bridge survives database reopen and continues beyond the old event ceiling', t => {
  const dir = mkdtempSync(join(tmpdir(), 'glass-bridge-'));
  const path = join(dir, 'catalog.sqlite');
  let db = openCatalog(path);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  db.exec("INSERT INTO characters (id, rank, favourites, name_full, gender) VALUES (1, 1, 1000, 'Prize', 'Female')");
  saveConfigSection(db, { guildId: '1', section: 'mysteryEvents', expectedRevision: getConfigView(db, '1').revision,
    values: Object.fromEntries([...MYSTERY_ROSTER.map(event => event.id), 'treasure_hunt']
      .map(id => [`mysteryEvents.${id}.enabled`, id === 'glass_bridge'])) });
  const roll = reserveMysteryAwareRoll(db, { guildId: '1', channelId: '10', userId: '101',
    commandMessageId: '100', pool: 'w', now: 1000, random: () => 0, mysteryEnabled: true });
  assert.equal(roll.eventId, 'glass_bridge');
  publishMysteryIntro(db, roll.sessionId, '500', 1100);
  let result = beginMysteryEvent(db, roll.sessionId, getMysterySession(db, roll.sessionId).nextAt, () => 0);
  const move = (input, now) => advanceMysteryEvent(db, { sessionId: roll.sessionId, input, now, random: () => 0 });
  for (let round = 1; round <= 12; round++) {
    const session = getMysterySession(db, roll.sessionId);
    for (const userId of ['101', '102']) move({ type: 'button', round, userId, value: 'left' }, session.nextAt - 1);
    db.close(); db = openCatalog(path);
    result = move({ type: 'timer' }, session.nextAt);
    assert.equal(result.status, 'ongoing');
    result = move({ type: 'timer' }, result.session.nextAt);
    assert.match(result.views.at(-1).lines.join('\n'), /Unpicked[\s\S]*<@101>[\s\S]*<@102>/);
  }
  const state = JSON.parse(result.session.stateJson);
  const missed = move({ type: 'timer' }, result.session.nextAt);
  const finished = move({ type: 'timer' }, missed.session.nextAt);
  assert.equal(finished.status, 'winner');
  assert.ok(['101', '102'].includes(finished.session.winnerId));
  assert.equal(state.phase, 'choice');
});

test('Glass Bridge is available to the mystery coordinator', () => {
  assert.ok(MYSTERY_ROSTER.some(event => event.id === 'glass_bridge'));
});

test('the final step result is visible before the prize outcome', () => {
  const started = glassBridgeEvent.start({ now: 0, random: () => 0 });
  const picked = glassBridgeEvent.advance({ state: started.state, now: 1,
    input: { type: 'button', userId: '101', round: 1, value: 'left' } });
  const result = glassBridgeEvent.advance({ state: picked.state, now: picked.state.closesAt });
  assert.equal(result.outcome, undefined);
  assert.match(result.views[0].text, /results/);
});

test('Glass Bridge ends without a winner when nobody enters', () => {
  const started = glassBridgeEvent.start({ now: 0, random: () => 0 });
  const result = glassBridgeEvent.advance({ state: started.state, now: started.state.closesAt });
  assert.equal(glassBridgeEvent.advance({ state: result.state, now: result.state.resultAt }).outcome.type, 'no_winner');
});

test('players see public choices and can switch sides', () => {
  const started = glassBridgeEvent.start({ now: 0, random: () => 0 });
  const picked = glassBridgeEvent.advance({ state: started.state, now: 1,
    input: { type: 'button', userId: '101', round: 1, value: 'left' } });
  const changed = glassBridgeEvent.advance({ state: picked.state, now: 2,
    input: { type: 'button', userId: '101', round: 1, value: 'right' } });
  const view = changed.views.at(-1);
  assert.match(view.lines.find(line => line.startsWith('### Right')), /<@101>/);
  assert.doesNotMatch(view.lines.find(line => line.startsWith('### Left')), /<@101>/);
});

test('a sole participant wins by crossing the first step', () => {
  const started = glassBridgeEvent.start({ now: 0, random: () => 0 });
  const picked = glassBridgeEvent.advance({ state: started.state, now: 1,
    input: { type: 'button', userId: '101', round: 1, value: 'left' } });
  const result = glassBridgeEvent.advance({ state: picked.state, now: picked.state.closesAt });
  assert.deepEqual(glassBridgeEvent.advance({ state: result.state, now: result.state.resultAt }).outcome,
    { type: 'winner', userId: '101' });
});

test('a player who misses a later step is included in the all-fall tiebreak', () => {
  let state = glassBridgeEvent.start({ now: 0, random: () => 0 }).state;
  for (const userId of ['101', '102']) {
    state = glassBridgeEvent.advance({ state, now: 1,
      input: { type: 'button', userId, round: 1, value: 'left' } }).state;
  }
  let result = glassBridgeEvent.advance({ state, now: state.closesAt });
  state = result.state;
  result = glassBridgeEvent.advance({ state, now: state.resultAt, random: () => 0 });
  state = result.state;
  state = glassBridgeEvent.advance({ state, now: state.closesAt - 1,
    input: { type: 'button', userId: '101', round: 2, value: 'right' } }).state;
  result = glassBridgeEvent.advance({ state, now: state.closesAt, random: () => 0.9 });
  assert.deepEqual(glassBridgeEvent.advance({ state: result.state, now: result.state.resultAt }).outcome,
    { type: 'winner', userId: '102' });
});

test('a delayed timer still displays the step result before opening the next choice', () => {
  let state = glassBridgeEvent.start({ now: 0, random: () => 0 }).state;
  for (const userId of ['101', '102']) state = glassBridgeEvent.advance({ state, now: 1,
    input: { type: 'button', userId, round: 1, value: 'left' } }).state;
  const result = glassBridgeEvent.advance({ state, now: state.closesAt + 1_000_000 });
  assert.equal(result.state.phase, 'result');
  assert.ok(result.views.every(view => view.phase === 'result'));
});

test('a sole player who falls on the first step cannot win', () => {
  const started = glassBridgeEvent.start({ now: 0, random: () => 0 });
  const picked = glassBridgeEvent.advance({ state: started.state, now: 1,
    input: { type: 'button', userId: '101', round: 1, value: 'right' } });
  const result = glassBridgeEvent.advance({ state: picked.state, now: picked.state.closesAt });
  assert.equal(glassBridgeEvent.advance({ state: result.state, now: result.state.resultAt }).outcome.type, 'no_winner');
});

test('late entrants and eliminated players cannot join a later step', () => {
  let state = glassBridgeEvent.start({ now: 0, random: () => 0 }).state;
  for (const [userId, value] of [['101', 'left'], ['102', 'left'], ['103', 'right']]) {
    state = glassBridgeEvent.advance({ state, now: 1,
      input: { type: 'button', userId, round: 1, value } }).state;
  }
  state = glassBridgeEvent.advance({ state, now: state.closesAt }).state;
  state = glassBridgeEvent.advance({ state, now: state.resultAt, random: () => 0 }).state;
  for (const userId of ['103', '104']) {
    const rejected = glassBridgeEvent.advance({ state, now: state.closesAt - 1,
      input: { type: 'button', userId, round: 2, value: 'left' } });
    assert.equal(rejected.feedback.type, 'rejected');
  }
});
