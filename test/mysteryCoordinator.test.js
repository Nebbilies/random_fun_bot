import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCatalog } from '../lib/catalogDb.js';
import { claimRoll, getMysterySession, openMysteryClaim, publishMysteryIntro } from '../lib/characterRolls.js';
import { advanceMysteryEvent, beginMysteryEvent, getMysteryEventChannel,
  reserveMysteryAwareRoll, setMysteryEventChannel } from '../lib/mysteryCoordinator.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mystery-coordinator-'));
  const db = openCatalog(join(dir, 'catalog.sqlite'));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  db.exec(`INSERT INTO characters (id, rank, favourites, name_full, gender) VALUES
    (1, 1, 1000, 'Prize', 'Female');`);
  return db;
}

function reserve(db, commandMessageId, draws = [0, 0, 0]) {
  const iterator = draws[Symbol.iterator]();
  return reserveMysteryAwareRoll(db, { guildId: '1', channelId: '10', commandMessageId,
    userId: '101', pool: 'w', now: 1000, random: () => iterator.next().value, mysteryEnabled: true });
}

test('a mystery pauses rolls, waits five seconds, then protects the winner claim', (t) => {
  const db = fixture(t);
  setMysteryEventChannel(db, '1', '20');
  assert.equal(getMysteryEventChannel(db, '1', '10'), '20');
  const roll = reserve(db, '100');
  assert.equal(roll.status, 'mystery');
  assert.equal(roll.eventId, 'doors');
  assert.equal(getMysterySession(db, roll.sessionId).eventChannelId, '20');
  assert.equal(reserve(db, '101').status, 'paused');
  assert.equal(db.prepare("SELECT used FROM roll_allowances WHERE guild_id = '1' AND user_id = '101'").get().used, 1);
  assert.equal(publishMysteryIntro(db, roll.sessionId, '500', 1100), true);
  assert.equal(beginMysteryEvent(db, roll.sessionId, 6099).status, 'early');
  const started = beginMysteryEvent(db, roll.sessionId, 6100, () => 0);
  assert.equal(started.status, 'started');
  assert.equal(started.view.buttons.length, 2);
  assert.equal(advanceMysteryEvent(db, { sessionId: roll.sessionId, guildId: '1', channelId: '10',
    input: { type: 'button', userId: '101', value: '1' }, now: 6200 }).status, 'wrong_channel');
  const won = advanceMysteryEvent(db, { sessionId: roll.sessionId, guildId: '1', channelId: '20',
    input: { type: 'button', userId: '101', value: '1' }, now: 6200 });
  assert.equal(won.status, 'winner');
  assert.equal(openMysteryClaim(db, { sessionId: roll.sessionId, messageId: '501', now: 11200 }).status, 'open');
  assert.equal(claimRoll(db, { guildId: '1', channelId: '20', messageId: '501', userId: '102', now: 11300 }).status,
    'protected');
  assert.equal(claimRoll(db, { guildId: '1', channelId: '20', messageId: '501', userId: '101', now: 11300 }).status,
    'married');
  assert.equal(getMysterySession(db, roll.sessionId).outcome, 'claimed');
});

test('a wrong door reveals an unclaimable prize and leaves history', (t) => {
  const db = fixture(t);
  const roll = reserve(db, '200');
  publishMysteryIntro(db, roll.sessionId, '600', 1100);
  beginMysteryEvent(db, roll.sessionId, 6100, () => 0);
  const lost = advanceMysteryEvent(db, { sessionId: roll.sessionId, guildId: '1', channelId: '10',
    input: { type: 'button', userId: '101', value: '2' }, now: 6200 });
  assert.equal(lost.status, 'doors_lost');
  assert.equal(getMysterySession(db, roll.sessionId).state, 'countdown');
  assert.equal(getMysterySession(db, roll.sessionId).nextAt, 9200);
  assert.equal(reserve(db, '201').status, 'paused');
});

test('disabled mystery feature leaves ordinary roll behavior available', (t) => {
  const db = fixture(t);
  const roll = reserveMysteryAwareRoll(db, { guildId: '1', channelId: '10', commandMessageId: '300',
    userId: '101', pool: 'w', now: 1000, random: () => 0, mysteryEnabled: false });
  assert.equal(roll.status, 'reserved');
  setMysteryEventChannel(db, '1', null);
  assert.equal(getMysteryEventChannel(db, '1', '10'), '10');
});
