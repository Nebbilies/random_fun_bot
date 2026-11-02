import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCatalog } from '../lib/catalogDb.js';
import { getConfigView, saveConfigSection } from '../lib/gameConfig.js';
import { getMysterySession, publishMysteryIntro, endMysterySession } from '../lib/characterRolls.js';
import { reserveMysteryAwareRoll, beginMysteryEvent, advanceMysteryEvent } from '../lib/mysteryCoordinator.js';
import { passesMysteryGate } from '../lib/mysteryOdds.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mystery-config-'));
  const db = openCatalog(join(dir, 'catalog.sqlite'));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  db.exec("INSERT INTO characters (id, rank, favourites, name_full, gender) VALUES (1, 1, 1000, 'Prize', 'Female')");
  return db;
}
function save(db, section, values, guildId = '1') {
  return saveConfigSection(db, { guildId, section, values,
    expectedRevision: getConfigView(db, guildId).revision });
}
function reserve(db, id, now = 1000) {
  return reserveMysteryAwareRoll(db, { guildId: '1', channelId: '10', userId: '101',
    commandMessageId: id, pool: 'w', now, random: () => 0, mysteryEnabled: true });
}
function start(db, roll) {
  publishMysteryIntro(db, roll.sessionId, '500', 1100);
  const at = getMysterySession(db, roll.sessionId).nextAt;
  return { at, result: beginMysteryEvent(db, roll.sessionId, at, () => 0) };
}
function move(db, roll, input, now, random = () => 0.9) {
  return advanceMysteryEvent(db, { sessionId: roll.sessionId, guildId: '1', channelId: '10', input, now, random });
}
function only(db, id, extra = {}) {
  save(db, 'mysteryEvents', Object.assign(Object.fromEntries(
    ['doors', 'clue_reveal', 'treasure_hunt', 'greed_chamber', 'deadlock', 'glass_bridge']
      .map((name) => [`mysteryEvents.${name}.enabled`, name === id])), extra));
}

test('persisted reservation snapshots survive edits before start, during play, and into countdown', (t) => {
  const db = fixture(t);
  only(db, 'doors', { 'mysteryEvents.doors.durationMs': 12000 });
  save(db, 'mystery', { 'mystery.winnerDelayMs': 900 });
  const roll = reserve(db, '100');
  assert.equal(JSON.parse(getMysterySession(db, roll.sessionId).stateJson).gameConfig.mystery.winnerDelayMs, 900);
  save(db, 'mysteryEvents', { 'mysteryEvents.doors.durationMs': 7000, 'mysteryEvents.doors.enabled': false,
    'mysteryEvents.deadlock.enabled': true });
  save(db, 'mystery', { 'mystery.winnerDelayMs': 1700 });
  const { at, result } = start(db, roll);
  assert.equal(result.status, 'started');
  assert.equal(result.session.nextAt, at + 12000);
  const won = move(db, roll, { type: 'button', userId: '101', value: '1' }, at + 10);
  assert.equal(won.status, 'winner');
  assert.equal(won.session.nextAt, at + 910);
  assert.equal(JSON.parse(won.session.stateJson).gameConfig.mysteryEvents.doors.durationMs, 12000);
  endMysterySession(db, { sessionId: roll.sessionId, outcome: 'cancelled', now: at + 20 });
  assert.equal(reserve(db, '101', at + 30).eventId, 'deadlock');
});

test('global/server mystery availability and zero weights affect actual selection without restarting', (t) => {
  const db = fixture(t);
  save(db, 'mysteryEvents', { 'mysteryEvents.doors.weight': 0, 'mysteryEvents.greed_chamber.weight': 0 });
  assert.equal(reserve(db, '200').eventId, 'deadlock');
  const session = db.prepare('SELECT id FROM mystery_sessions').get();
  endMysterySession(db, { sessionId: session.id, outcome: 'cancelled', now: 2000 });
  save(db, 'mystery', { 'mystery.enabled': false }, null);
  assert.equal(reserve(db, '201', 2100).status, 'reserved');
});

test('Greed configured totals, collapse table and absolute phase timing reach persisted outcomes', (t) => {
  const db = fixture(t);
  only(db, 'greed_chamber', { 'mysteryEvents.greed_chamber.rounds': 2,
    'mysteryEvents.greed_chamber.totals': [7, 19], 'mysteryEvents.greed_chamber.collapseChances': [0, 0],
    'mysteryEvents.roundTiming.firstRoundMs': 1000, 'mysteryEvents.roundTiming.laterRoundMs': 500,
    'mysteryEvents.roundTiming.resultMs': 100 });
  const roll = reserve(db, '300');
  const { at, result } = start(db, roll);
  assert.match(JSON.stringify(result.view), /7 points/);
  move(db, roll, { type: 'button', round: 1, userId: '101', value: 'stay' }, at + 1);
  move(db, roll, { type: 'timer' }, at + 1000);
  save(db, 'mysteryEvents', { 'mysteryEvents.greed_chamber.totals': [20, 30] });
  move(db, roll, { type: 'timer' }, at + 1100);
  move(db, roll, { type: 'button', round: 2, userId: '101', value: 'stay' }, at + 1101);
  const won = move(db, roll, { type: 'timer' }, at + 1600);
  assert.equal(won.status, 'winner');
  assert.equal(JSON.parse(won.session.stateJson).players['101'].banked, 19);
  assert.match(JSON.stringify(won.views), /banked 19/);
});

test('Deadlock supports configured rounds beyond five and retains timing snapshot', (t) => {
  const db = fixture(t);
  only(db, 'deadlock', { 'mysteryEvents.deadlock.rounds': 6,
    'mysteryEvents.roundTiming.firstRoundMs': 100, 'mysteryEvents.roundTiming.laterRoundMs': 100,
    'mysteryEvents.roundTiming.resultMs': 10 });
  const roll = reserve(db, '400');
  const { at, result } = start(db, roll);
  assert.match(JSON.stringify(result.view), /1\/6/);
  for (let round = 1; round <= 6; round++) {
    const open = at + (round - 1) * 110;
    if (round > 1) move(db, roll, { type: 'timer' }, open);
    move(db, roll, { type: 'button', round, userId: '101', value: '5' }, open + 1);
    const advanced = move(db, roll, { type: 'timer' }, open + 100);
    assert.equal(advanced.status, round === 6 ? 'winner' : 'ongoing');
  }
  assert.equal(JSON.parse(getMysterySession(db, roll.sessionId).stateJson).players['101'].score, 30);
});

test('Treasure Hunt opt-in uses saved clue schedule and duration', (t) => {
  const db = fixture(t);
  only(db, 'treasure_hunt', { 'mysteryEvents.treasure_hunt.durationMs': 10000,
    'mysteryEvents.treasure_hunt.clueTimesMs': [0, 1000, 3000] });
  const roll = reserve(db, '450');
  const { at, result } = start(db, roll);
  assert.equal(roll.eventId, 'treasure_hunt');
  assert.equal(result.session.nextAt, at + 1000);
  save(db, 'mysteryEvents', { 'mysteryEvents.treasure_hunt.clueTimesMs': [0, 2000, 4000] });
  const second = move(db, roll, { type: 'timer' }, at + 1000);
  assert.match(second.view.text, /Clue 2\/3/);
  assert.equal(second.session.nextAt, at + 3000);
  assert.equal(move(db, roll, { type: 'timer' }, at + 10000).status, 'no_winner');
});

test('Clue Reveal metadata policy, clue timing and answer cooldown use reservation snapshot', (t) => {
  const db = fixture(t);
  db.exec(`INSERT INTO anime (id, title_romaji, title_english, genres, tags, season_year,
    format, popularity, is_adult, fetched_at) VALUES
    (10, 'Hoshi no Monogatari', 'Star Chronicle', '["Adventure","Fantasy"]',
    '[{"name":"Space","rank":90},{"name":"Exploration","rank":70}]', 2018, 'TV', 1000, 0, 'now');
    INSERT INTO character_anime (character_id, anime_id) VALUES (1, 10)`);
  only(db, 'clue_reveal', { 'mysteryEvents.clue_reveal.durationMs': 10000,
    'mysteryEvents.clue_reveal.clueIntervalMs': 1000, 'mysteryEvents.clue_reveal.genreCount': 1,
    'mysteryEvents.clue_reveal.tagCount': 1, 'mysteryEvents.clue_reveal.tagMinRank': 80,
    'mysteryEvents.clue_reveal.longTypos': 0 });
  save(db, 'mystery', { 'mystery.answerCooldownMs': 100 });
  const roll = reserve(db, '460');
  const { at, result } = start(db, roll);
  assert.equal(result.session.nextAt, at + 1000);
  const state = JSON.parse(result.session.stateJson);
  assert.equal(state.clues[2], 'Genres: Adventure');
  assert.equal(state.clues[3], 'Tags: Space');
  save(db, 'mystery', { 'mystery.answerCooldownMs': 5000 });
  save(db, 'mysteryEvents', { 'mysteryEvents.clue_reveal.clueIntervalMs': 2000 });
  move(db, roll, { type: 'answer', userId: '101', value: 'Star Chroniclz' }, at + 1);
  assert.equal(move(db, roll, { type: 'answer', userId: '101', value: 'Star Chronicle' }, at + 20).status, 'cooldown');
  const next = move(db, roll, { type: 'timer' }, at + 1000);
  assert.equal(next.session.nextAt, at + 2000);
  assert.equal(move(db, roll, { type: 'answer', userId: '101', value: 'Star Chronicle' }, at + 1001).status, 'winner');
});

test('rank gate accepts configured anchors while preserving default call signature', () => {
  const anchors = [{ rank: 1, chance: 0.1 }, { rank: 100, chance: 0.01 }];
  assert.equal(passesMysteryGate(1, () => 0.5), true);
  assert.equal(passesMysteryGate(1, () => 0.5, anchors), false);
});
