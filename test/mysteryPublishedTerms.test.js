import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCatalog } from '../lib/catalogDb.js';
import { migrateCharacterIdentities } from '../lib/characterIdentityMigration.js';
import { reserveRoll, getMysterySession, publishMysteryIntro, advanceMysterySession,
  openMysteryClaim } from '../lib/characterRolls.js';
import { beginMysteryEvent, advanceMysteryEvent } from '../lib/mysteryCoordinator.js';
import { captureCharacterSnapshot, validateCharacterSnapshot } from '../lib/characterSnapshot.js';

function fixture(t, { migrated = true, file = ':memory:' } = {}) {
  const db = openCatalog(file);
  // Actual migration, including provenance column, not a synthetic TEXT schema.
  db.exec(`INSERT INTO characters(id,rank,favourites,name_full,image_url,anime_titles,gender)
    VALUES(12,1,1234,'Published prize','https://example.invalid/original.png','["Original anime"]','Female');
    INSERT INTO character_identities SELECT id,name_full,image_url FROM characters;`);
  if (migrated) migrateCharacterIdentities(db, { dryRun: false, targetVersion: 11 });
  t.after(() => { if (db.isOpen) db.close(); });
  return db;
}
function reserve(db, eventId = 'doors', state = {}) {
  const result = reserveRoll(db, { guildId: '1', channelId: '10', commandMessageId: '100',
    userId: '101', pool: 'w', now: 1000, random: () => 0,
    mystery: { eventChannelId: '10', selectEvent: () => ({ eventId, durationMs: 60000, state }) } });
  assert.equal(result.status, 'mystery');
  return result;
}
const terms = (db, id) => JSON.parse(getMysterySession(db, id).stateJson).characterSnapshot;
function edit(db, id, suffix = 'edited') {
  db.prepare(`UPDATE characters SET rank=2000,favourites=9876,likes_source='generated',
    name_full=?,image_url=?,anime_titles='["Edited anime"]',gender='Male' WHERE id=?`)
    .run(`Name ${suffix}`, `https://example.invalid/${suffix}.png`, id);
}
function start(db, id) {
  assert.equal(publishMysteryIntro(db, id, '500', 1100), true);
  return beginMysteryEvent(db, id, 6100, () => 0);
}
function advance(db, id, input, now = 6200) {
  return advanceMysteryEvent(db, { sessionId: id, guildId: '1', channelId: '10', input, now });
}

for (const ending of ['winner', 'loser', 'timer', 'deadline', 'reserved_deadline']) {
  test(`migrated published terms survive catalog edits: ${ending}`, t => {
    const db = fixture(t);
    const roll = reserve(db, 'doors', { custom: 'retained on reserve', characterSnapshot: { id: 'forged' } });
    const snapshot = terms(db, roll.sessionId);
    assert.deepEqual(snapshot, captureCharacterSnapshot(roll.character));
    assert.equal(typeof snapshot.id, 'string');
    assert.equal(snapshot.likes_source, 'anilist');
    assert.equal(JSON.parse(getMysterySession(db, roll.sessionId).stateJson).custom, 'retained on reserve');
    edit(db, roll.character.id);
    if (ending === 'reserved_deadline') {
      publishMysteryIntro(db, roll.sessionId, '500', 1100);
      const result = beginMysteryEvent(db, roll.sessionId, 66100);
      assert.equal(result.status, 'no_winner');
      assert.deepEqual(result.character, snapshot);
      assert.deepEqual(terms(db, roll.sessionId), snapshot);
      return;
    }
    const started = start(db, roll.sessionId);
    assert.equal(started.status, 'started');
    assert.deepEqual(started.character, snapshot);
    assert.deepEqual(terms(db, roll.sessionId), snapshot);
    edit(db, roll.character.id, 'again');
    const result = ending === 'deadline'
      ? advance(db, roll.sessionId, { type: 'timer' }, 66100)
      : ending === 'timer' ? advance(db, roll.sessionId, { type: 'timer' }, started.session.nextAt)
        : advance(db, roll.sessionId, { type: 'button', userId: '101', value: ending === 'winner' ? '1' : '2' });
    assert.equal(result.status, ending === 'winner' ? 'winner' : ending === 'loser' ? 'doors_lost' : 'no_winner');
    if (ending !== 'loser') assert.deepEqual(result.character, snapshot);
    assert.deepEqual(terms(db, roll.sessionId), snapshot);
    if (ending === 'winner') {
      assert.equal(openMysteryClaim(db, { sessionId: roll.sessionId, messageId: '501', now: result.session.nextAt }).status, 'open');
      assert.deepEqual(terms(db, roll.sessionId), snapshot);
    }
  });
}

test('shared replacements cannot drop, replace or mutate original snapshot', t => {
  const db = fixture(t);
  const roll = reserve(db);
  const snapshot = terms(db, roll.sessionId);
  start(db, roll.sessionId);
  for (const replacement of [{ custom: 1 }, { custom: 2, characterSnapshot: { version: 999 } }, null]) {
    const session = getMysterySession(db, roll.sessionId);
    assert.equal(advanceMysterySession(db, { sessionId: session.id, expectedState: 'running',
      expectedStateJson: session.stateJson, state: 'running', stateJson: replacement, now: 6200 }).status, 'advanced');
    assert.deepEqual(terms(db, session.id), snapshot);
  }
});

test('legacy sessions without snapshots deliberately use live rows and keep custom state', t => {
  const db = fixture(t);
  const roll = reserve(db);
  db.prepare('UPDATE mystery_sessions SET state_json=? WHERE id=?').run(JSON.stringify({ custom: 42 }), roll.sessionId);
  edit(db, roll.character.id);
  assert.equal(start(db, roll.sessionId).character.name_full, 'Name edited');
  assert.equal(terms(db, roll.sessionId), undefined);
  const session = getMysterySession(db, roll.sessionId);
  advanceMysterySession(db, { sessionId: session.id, expectedState: 'running', expectedStateJson: session.stateJson,
    state: 'running', stateJson: { custom: 43 }, now: 6200 });
  assert.deepEqual(JSON.parse(getMysterySession(db, session.id).stateJson), { custom: 43 });
});

test('legacy numeric reserve also captures durable terms without a provenance column', t => {
  const db = fixture(t, { migrated: false });
  const roll = reserve(db);
  assert.equal(terms(db, roll.sessionId).id, 12);
  assert.equal(terms(db, roll.sessionId).likes_source, 'anilist');
  assert.deepEqual(start(db, roll.sessionId).character, terms(db, roll.sessionId));
});

for (const phase of ['reserved', 'running', 'timeout']) {
  test(`invalid present snapshot fails closed before ${phase} changes state`, t => {
    const db = fixture(t);
    const roll = reserve(db);
    if (phase !== 'reserved') start(db, roll.sessionId);
    else publishMysteryIntro(db, roll.sessionId, '500', 1100);
    const valid = terms(db, roll.sessionId);
    for (const invalid of [null, {}, { ...valid, version: 2 }, { ...valid, id: '00000000-0000-4000-8000-000000000099' },
      { ...valid, rank: '1' }, { ...valid, favourites: -1 }, { ...valid, likes_source: 'unknown' },
      { ...valid, image_url: {} }, { ...valid, name_full: 'x'.repeat(4097) }]) {
      const state = JSON.parse(getMysterySession(db, roll.sessionId).stateJson);
      state.characterSnapshot = invalid;
      db.prepare('UPDATE mystery_sessions SET state_json=? WHERE id=?').run(JSON.stringify(state), roll.sessionId);
      const before = getMysterySession(db, roll.sessionId);
      assert.throws(() => phase === 'reserved' ? beginMysteryEvent(db, roll.sessionId, 6100)
        : advance(db, roll.sessionId, { type: 'timer' }, phase === 'timeout' ? 66100 : 6200), /Invalid mystery character snapshot/);
      assert.deepEqual(getMysterySession(db, roll.sessionId), before);
    }
  });
}

test('capture is bounded, explicit, detached, and accepts only canonical UUID or positive numeric identity', () => {
  const row = { id: 12, name_full: 'Prize', rank: 1, favourites: 0, likes_source: 'generated',
    image_url: null, anime_titles: '[]', gender: null, tag_name: 'prize_tag', secret: 'excluded' };
  const snapshot = captureCharacterSnapshot(row);
  assert.equal(snapshot.secret, undefined);
  assert.equal(snapshot.tag_name, 'prize_tag');
  row.name_full = 'Changed';
  assert.equal(snapshot.name_full, 'Prize');
  assert.equal(Object.isFrozen(snapshot), true);
  for (const id of [0, -1, 1.5, '12', 'ABCDEF01-2345-4678-9ABC-DEF012345678']) {
    assert.throws(() => captureCharacterSnapshot({ ...row, id }), /Invalid mystery character snapshot/);
  }
  assert.equal(validateCharacterSnapshot({ ...snapshot, id: 'abcdef01-2345-4678-9abc-def012345678' }).id,
    'abcdef01-2345-4678-9abc-def012345678');
  assert.throws(() => validateCharacterSnapshot({ ...snapshot, extra: 1 }), /Invalid mystery character snapshot/);
});

test('raw file close/reopen preserves terms through begin and winner (not runtime recovery)', t => {
  const dir = mkdtempSync(join(tmpdir(), 'mystery-published-'));
  const file = join(dir, 'synthetic.sqlite');
  let db = fixture(t, { file });
  t.after(() => {
    if (db.isOpen) db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const roll = reserve(db);
  const snapshot = terms(db, roll.sessionId);
  edit(db, roll.character.id);
  db.close();
  // The normal opener intentionally rejects UUID schema v11. This is an offline
  // synthetic persistence proof only, not a claim of supported restart/resume.
  db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys=ON');
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 11);
  assert.deepEqual(start(db, roll.sessionId).character, snapshot);
  edit(db, roll.character.id, 'after-reopen');
  db.close();
  db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys=ON');
  const result = advance(db, roll.sessionId, { type: 'button', userId: '101', value: '1' });
  assert.equal(result.status, 'winner');
  assert.deepEqual(result.character, snapshot);
  assert.deepEqual(terms(db, roll.sessionId), snapshot);
});
