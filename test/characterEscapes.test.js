import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCatalog, openCatalogReadOnly } from '../lib/catalogDb.js';
import { divorceCharacter, getMarriage, marryCharacter } from '../lib/characterMarriage.js';
import {
  claimRoll, cleanupRolls, failRoll, getClaimStatus, getRoll, getRollStatus, markClaimNotice, publishRoll,
  recoverRolls, refreshEscapeRoll, reserveRoll,
} from '../lib/characterRolls.js';
import { onRollReaction, onRollReport, rollCard, runRoll, startEscapeUpdates } from '../lib/characterRollRuntime.js';

const start = Date.parse('2026-10-18T01:00:00Z');

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'character-escape-'));
  const path = join(dir, 'catalog.sqlite');
  const db = openCatalog(path);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  db.exec(`INSERT INTO characters (id, rank, favourites, name_full, gender, anime_titles, image_url) VALUES
    (1, 1, 100, 'A *name* <@999>', 'Female', '["Show"]', 'https://example.com/a.png'),
    (2, 2, 90, 'B', 'Male', '[]', NULL),
    (3, 3, 80, 'C', NULL, '[]', NULL);
    INSERT INTO marriages (guild_id, character_id, owner_id, married_at) VALUES ('1', 1, '101', 'original-date');`);
  const original = getMarriage(db, '1', 1);
  assert.ok(original);
  return { db, original, path };
}

function reserve(db, extra = {}) {
  return reserveRoll(db, { guildId: '1', channelId: '10', commandMessageId: '100',
    userId: '101', pool: 'w', now: start, random: () => 0, ...extra });
}

function publish(db, extra = {}, messageId = '500') {
  const result = reserve(db, extra);
  assert.equal(result.status, 'reserved');
  assert.equal(publishRoll(db, result.rollId, messageId, extra.now ?? start), true);
  return result;
}

function claim(db, userId, offset, messageId = '500') {
  return claimRoll(db, { guildId: '1', channelId: '10', messageId, userId, now: start + offset });
}

function exhaust(db, userId, now = start) {
  db.prepare('INSERT INTO claim_allowances (guild_id, user_id, period) VALUES (?, ?, ?)')
    .run('1', userId, Math.floor((now + 7 * 3_600_000) / (3 * 3_600_000)));
}

test('owned results share the uniform pool, include the roller, and bypass mystery entirely', (t) => {
  const { db, original } = fixture(t);
  let draws = 0;
  const owned = reserve(db, { random: () => { draws++; return 0; },
    mystery: { eventChannelId: '20', selectEvent: () => { throw new Error('Owned result selected mystery'); } } });
  assert.equal(owned.character.id, 1);
  assert.equal(owned.escapeOwnerId, '101');
  assert.equal(draws, 1);
  assert.equal(getRollStatus(db, '1', '101', start).remaining, 6);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mystery_sessions').get()?.n, 0);
  assert.equal(db.prepare('SELECT escape_marriage_id FROM character_rolls').get()?.escape_marriage_id, original.id);
  failRoll(db, owned.rollId);
  const other = reserve(db, { commandMessageId: '101', random: () => 0.5 });
  assert.equal(other.character.id, 3);
  assert.equal(other.escapeOwnerId, null);
  failRoll(db, other.rollId);
  const otherGuild = reserve(db, { guildId: '2', commandMessageId: '102' });
  assert.equal(otherGuild.character.id, 1);
  assert.equal(otherGuild.escapeOwnerId, null);
});

test('owned male and unknown-gender characters keep gender filtering and need no membership lookup', (t) => {
  const { db } = fixture(t);
  marryCharacter(db, '1', 2, '999');
  marryCharacter(db, '1', 3, '998');
  const male = reserve(db, { pool: 'h' });
  assert.equal(male.character.id, 2);
  assert.equal(male.escapeOwnerId, '999');
  failRoll(db, male.rollId);
  const unknown = reserve(db, { pool: 'h', commandMessageId: '101', random: () => 0.99 });
  assert.equal(unknown.character.id, 3);
  assert.equal(unknown.escapeOwnerId, '998');
});

test('live escape cards stay excluded through both phases; ended attempts have no cooldown', (t) => {
  const { db } = fixture(t);
  publish(db);
  const other = reserve(db, { commandMessageId: '101', now: start + 60_000 });
  assert.equal(other.character.id, 3);
  failRoll(db, other.rollId);
  assert.equal(claim(db, '101', 60_001).status, 'reclaimed');
  const next = reserve(db, { commandMessageId: '102', now: start + 60_002 });
  assert.equal(next.character.id, 1);
  assert.equal(next.escapeOwnerId, '101');
});

for (const offset of [0, 59_999, 60_000, 119_999]) {
  test(`owner reclaims free at ${offset}ms even with an exhausted allowance`, (t) => {
    const { db, original } = fixture(t);
    publish(db);
    exhaust(db, '101');
    assert.equal(claim(db, '101', offset).status, 'reclaimed');
    assert.deepEqual(getMarriage(db, '1', 1), original);
    assert.equal(getClaimStatus(db, '1', '101', start + offset).canClaim, false);
    assert.equal(claim(db, '102', offset + 1).status, 'closed');
    assert.equal(getRoll(db, '1', '10', '500').escapeOutcome, 'reclaimed');
  });
}

test('protection ends exactly at 60 seconds, transfers once, and charges only the winner', (t) => {
  const { db, original } = fixture(t);
  publish(db);
  assert.equal(claim(db, '102', 59_999).status, 'protected');
  assert.equal(getClaimStatus(db, '1', '102', start).canClaim, true);
  assert.deepEqual(getMarriage(db, '1', 1), original);
  assert.equal(claim(db, '102', 60_000).status, 'married');
  const marriage = getMarriage(db, '1', 1);
  assert.ok(marriage);
  assert.equal(marriage.ownerId, '102');
  assert.notEqual(marriage.id, original.id);
  assert.notEqual(marriage.marriedAt, original.marriedAt);
  assert.equal(getClaimStatus(db, '1', '102', start + 60_000).canClaim, false);
  assert.equal(claim(db, '103', 60_000).status, 'closed');
  assert.equal(claim(db, '101', 60_000).status, 'closed');
  assert.equal(getClaimStatus(db, '1', '103', start + 60_000).canClaim, true);
  assert.equal(getClaimStatus(db, '1', '101', start + 60_000).canClaim, true);
});

test('exhausted outsider cannot transfer ownership; original owner may still reclaim', (t) => {
  const { db, original } = fixture(t);
  publish(db);
  exhaust(db, '102');
  assert.equal(claim(db, '102', 60_000).status, 'exhausted');
  assert.deepEqual(getMarriage(db, '1', 1), original);
  assert.equal(getRoll(db, '1', '10', '500').state, 'open');
  assert.equal(claim(db, '101', 60_001).status, 'reclaimed');
});

test('public transfer at a three-hour reset uses the new allowance', (t) => {
  const { db } = fixture(t);
  const before = Date.parse('2026-10-17T19:59:00Z');
  publish(db, { now: before });
  exhaust(db, '102', before);
  const result = claimRoll(db, { guildId: '1', channelId: '10', messageId: '500', userId: '102', now: before + 60_000 });
  assert.equal(result.status, 'married');
  assert.equal(getClaimStatus(db, '1', '102', before + 60_000).canClaim, false);
});

test('both owner and outsiders expire exactly at 120 seconds without losing ownership', (t) => {
  const { db, original } = fixture(t);
  publish(db);
  assert.equal(claim(db, '102', 120_000).status, 'expired');
  assert.equal(claim(db, '101', 120_000).status, 'closed');
  assert.deepEqual(getMarriage(db, '1', 1), original);
  assert.equal(getRoll(db, '1', '10', '500').escapeOutcome, 'expired');
  assert.equal(getClaimStatus(db, '1', '102', start + 120_000).canClaim, true);
});

for (const change of ['divorce', 'same-owner-remarriage', 'new-owner', 'catalog-removal']) {
  test(`escape is invalid after ${change}, without touching later ownership or allowances`, (t) => {
    const { db, original } = fixture(t);
    publish(db);
    if (change === 'catalog-removal') db.exec('DELETE FROM characters WHERE id = 1');
    else {
      divorceCharacter(db, '1', 1, '101', original.id);
      if (change !== 'divorce') marryCharacter(db, '1', 1, change === 'new-owner' ? '104' : '101');
    }
    const current = getMarriage(db, '1', 1);
    assert.equal(claim(db, '102', 60_000).status, 'closed');
    assert.deepEqual(getMarriage(db, '1', 1), current);
    assert.equal(getClaimStatus(db, '1', '102', start + 60_000).canClaim, true);
    assert.equal(getRoll(db, '1', '10', '500').escapeOutcome, 'canceled');
  });
}

test('ownership changed while publishing produces a dead card without altering the new marriage', (t) => {
  const { db, original } = fixture(t);
  const result = reserve(db);
  divorceCharacter(db, '1', 1, '101', original.id);
  marryCharacter(db, '1', 1, '104');
  assert.equal(publishRoll(db, result.rollId, '500', start), false);
  assert.equal(getRoll(db, '1', '10', '500').escapeOutcome, 'canceled');
  assert.equal(claim(db, '102', 60_000).status, 'closed');
  assert.equal(getMarriage(db, '1', 1)?.ownerId, '104');
});

test('failed transfer rolls back the original marriage and leaves the allowance untouched', (t) => {
  const { db, original } = fixture(t);
  publish(db);
  db.exec(`CREATE TRIGGER reject_transfer BEFORE INSERT ON marriages
    WHEN NEW.owner_id = '102' BEGIN SELECT RAISE(ABORT, 'test transfer failure'); END;`);
  assert.throws(() => claim(db, '102', 60_000), /test transfer failure/);
  assert.deepEqual(getMarriage(db, '1', 1), original);
  assert.equal(getClaimStatus(db, '1', '102', start + 60_000).canClaim, true);
  assert.equal(getRoll(db, '1', '10', '500').state, 'open');
});

test('one player cannot spend one allowance on both a transfer and another character', (t) => {
  const { db } = fixture(t);
  publish(db);
  publish(db, { commandMessageId: '101', pool: 'h', now: start + 60_000 }, '501');
  assert.equal(claim(db, '102', 60_000).status, 'married');
  assert.equal(claim(db, '102', 60_001, '501').status, 'exhausted');
  assert.equal(getMarriage(db, '1', 2), null);
});

test('restart cancels pending, protected, and public escapes while retaining ordinary cards', (t) => {
  const { db, original } = fixture(t);
  publish(db);
  publish(db, { commandMessageId: '101', pool: 'h' }, '501');
  const normal = getRoll(db, '1', '10', '501');
  const recovered = recoverRolls(db, start + 30_000);
  assert.deepEqual(recovered.map((row) => row.messageId), ['501']);
  assert.equal(getRoll(db, '1', '10', '500').escapeOutcome, 'canceled');
  assert.equal(getRoll(db, '1', '10', '501').expiresAt, normal.expiresAt);
  assert.deepEqual(getMarriage(db, '1', 1), original);
  const next = publish(db, { commandMessageId: '102', now: start + 30_001 }, '502');
  recoverRolls(db, start + 100_000);
  assert.equal(getRoll(db, '1', '10', '502').escapeOutcome, 'canceled');
  assert.equal(claim(db, '102', 100_001, '502').status, 'closed');
  assert.equal(getRollStatus(db, '1', '101', start).remaining, 4);
  reserve(db, { commandMessageId: '103', now: start + 100_002 });
  recoverRolls(db, start + 100_003);
  assert.equal(db.prepare('SELECT state FROM character_rolls WHERE id > ?').get(next.rollId)?.state, 'closed');
});

test('v6 migration preserves existing game data, opens read-only, and is repeatable', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'escape-migration-'));
  const path = join(dir, 'catalog.sqlite');
  let db = openCatalog(path);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  db.exec(`INSERT INTO characters (id, rank, favourites, name_full) VALUES (1, 1, 100, 'A');
    INSERT INTO marriages (guild_id, character_id, owner_id, married_at) VALUES ('1', 1, '101', 'original');
    INSERT INTO claim_allowances (guild_id, user_id, period) VALUES ('1', '101', 12);
    INSERT INTO character_rolls (guild_id, channel_id, command_message_id, message_id,
      character_id, character_name, state, published_at, expires_at)
      VALUES ('1', '10', '100', '500', 1, 'A', 'open', 1000, 61000);
    INSERT INTO mystery_sessions (guild_id, origin_roll_id, event_id, character_id, rank_snapshot,
      roller_id, event_channel_id, state, started_at, deadline_at)
      VALUES ('2', 2, 'doors', 1, 1, '101', '20', 'running', 1000, 61000);`);
  for (const name of ['escape_marriage_id', 'escape_owner_id', 'protected_until',
    'escape_outcome', 'escape_winner_id', 'escape_resolved_at']) {
    db.exec(`ALTER TABLE character_rolls DROP COLUMN ${name}`);
  }
  db.exec('PRAGMA user_version = 6');
  db.close();
  db = openCatalog(path);
  assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 10);
  assert.equal(getMarriage(db, '1', 1)?.marriedAt, 'original');
  assert.equal(db.prepare('SELECT period FROM claim_allowances').get()?.period, 12);
  assert.equal(db.prepare('SELECT state FROM mystery_sessions').get()?.state, 'running');
  const roll = getRoll(db, '1', '10', '500');
  assert.equal(roll.expiresAt, 61000);
  assert.equal(roll.escapeMarriageId, null);
  assert.equal(roll.state, 'open');
  db.close();
  db = openCatalog(path);
  const readOnly = openCatalogReadOnly(path);
  try { assert.equal(readOnly.prepare('PRAGMA user_version').get()?.user_version, 10); }
  finally { readOnly.close(); }
});

test('unpublished canceled attempts and their notices expire after the reporting lifetime', (t) => {
  const { db, original } = fixture(t);
  const pending = reserve(db);
  markClaimNotice(db, pending.rollId, '102');
  recoverRolls(db, start + 1);
  assert.equal(cleanupRolls(db, start + 1 + 3_600_000), 0);
  assert.equal(cleanupRolls(db, start + 2 + 3_600_000), 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM roll_notices').get()?.n, 0);
  assert.deepEqual(getMarriage(db, '1', 1), original);
});

function fakeClock() {
  let time = start;
  const timers = new Set();
  return {
    now: () => time,
    setTimer: (callback, delay) => {
      const timer = { callback, at: time + delay, unref() {} };
      timers.add(timer);
      return timer;
    },
    clearTimer: (timer) => timers.delete(timer),
    async advance(ms) {
      const target = time + ms;
      for (;;) {
        const timer = [...timers].sort((a, b) => a.at - b.at)[0];
        if (!timer || timer.at > target) break;
        timers.delete(timer);
        time = timer.at;
        await timer.callback();
      }
      time = target;
    },
  };
}

function runtimeFixture(t) {
  const x = fixture(t);
  const clock = fakeClock();
  t.mock.method(Date, 'now', clock.now);
  const sent = [];
  const edits = [];
  const channel = { send: async (payload) => { sent.push(payload); } };
  const card = { id: '500', guildId: '1', channelId: '10', channel,
    edit: async (payload) => { edits.push(payload); }, react: async () => {} };
  const message = { id: '100', guildId: '1', channelId: '10', author: { id: '102' },
    reply: async (payload) => { sent.push(payload); return card; } };
  const yoshiko = { catalogDb: x.db, mysteryEnabled: true,
    imagePicker: { pick: async () => ({ url: 'https://example.com/a.png' }) } };
  const reaction = { emoji: { name: '❤️' }, message: card };
  return { ...x, clock, sent, edits, card, message, yoshiko, reaction };
}

function serialized(payload) {
  return payload.components.map((component) => component.toJSON());
}

test('escape card pings only its owner, turns normal color at 60 seconds, and expires without transfer', async (t) => {
  const x = runtimeFixture(t);
  await runRoll({ message: x.message, yoshiko: x.yoshiko }, 'w', () => 0.02, x.clock);
  const initial = serialized(x.sent[0]);
  assert.equal(initial[0].type, 10);
  assert.match(initial[0].content, /<@101>.*tries to leave your harem/);
  assert.ok(initial[0].content.includes('A \\*name\\* <@999>'));
  assert.equal(initial[1].accent_color, 0x9b59b6);
  assert.deepEqual(x.sent[0].allowedMentions, { parse: [], users: ['101'], repliedUser: false });
  await onRollReaction(x.yoshiko, x.reaction, { id: '103', bot: false });
  assert.equal(getMarriage(x.db, '1', 1)?.ownerId, '101');
  await x.clock.advance(60_000);
  const publicCard = serialized(x.edits.at(-1));
  assert.equal(publicCard[0].content, '**A \\*name\\* <@999>** has left the harem! Anyone can now marry her!');
  assert.equal(publicCard[1].accent_color, 0xe91e63);
  assert.doesNotMatch(publicCard[0].content, /<t:|deadline/);
  assert.deepEqual(x.edits.at(-1).allowedMentions.users, []);
  assert.deepEqual(getMarriage(x.db, '1', 1), x.original);
  assert.equal(getRoll(x.db, '1', '10', '500').state, 'open');
  await x.clock.advance(60_000);
  assert.match(serialized(x.edits.at(-1))[0].content, /Expired.*ownership is unchanged/);
  assert.deepEqual(getMarriage(x.db, '1', 1), x.original);
  assert.equal(getClaimStatus(x.db, '1', '103').canClaim, true);
});

test('owner reaction updates Reclaimed and keeps the protected color without a new ping', async (t) => {
  const x = runtimeFixture(t);
  exhaust(x.db, '101');
  await runRoll({ message: x.message, yoshiko: x.yoshiko }, 'w', () => 0.02, x.clock);
  await onRollReaction(x.yoshiko, x.reaction, { id: '101', bot: false });
  const card = serialized(x.edits.at(-1));
  assert.match(card[0].content, /Reclaimed.*<@101>/);
  assert.equal(card[1].accent_color, 0x9b59b6);
  assert.deepEqual(x.edits.at(-1).allowedMentions.users, []);
  assert.equal(x.sent.length, 1);
  const count = x.edits.length;
  await x.clock.advance(120_000);
  assert.equal(x.edits.length, count);
  assert.deepEqual(getMarriage(x.db, '1', 1), x.original);
});

test('fresh public reaction marries, announces the winner, and preserves the report button', async (t) => {
  const x = runtimeFixture(t);
  await runRoll({ message: x.message, yoshiko: x.yoshiko }, 'w', () => 0.02, x.clock);
  await x.clock.advance(60_000);
  await onRollReaction(x.yoshiko, x.reaction, { id: '103', bot: false });
  assert.equal(getMarriage(x.db, '1', 1)?.ownerId, '103');
  assert.match(serialized(x.edits.at(-1))[0].content, /Married.*<@103>/);
  assert.match(x.sent.at(-1).content, /<@103> has married/);
  assert.deepEqual(x.sent.at(-1).allowedMentions.users, ['103']);
  const replies = [];
  await onRollReport(x.db, { isButton: () => true, customId: 'roll:report', guildId: '1', channelId: '10',
    message: x.card, user: { id: '104' }, reply: async (payload) => { replies.push(payload); } });
  assert.match(replies[0].content, /saved/);
  assert.match(JSON.stringify(serialized(x.edits.at(-1))), /Report tag/);
});

test('public-card edit in flight cannot overwrite a later marriage result', async (t) => {
  const x = runtimeFixture(t);
  publish(x.db);
  /** @type {() => void} */
  let release = () => {};
  const blocked = new Promise((resolve) => { release = () => resolve(undefined); });
  let started;
  const editing = new Promise((resolve) => { started = resolve; });
  x.card.edit = async (payload) => {
    if (serialized(payload)[0].content.includes('has left the harem')) {
      started();
      await blocked;
    }
    x.edits.push(payload);
  };
  const updates = startEscapeUpdates({ db: x.db, message: x.card,
    character: { name_full: 'A', gender: 'Female' }, image: null, remaining: 6, ...x.clock });
  t.after(updates.stop);
  const advancing = x.clock.advance(60_000);
  await editing;
  const marrying = onRollReaction(x.yoshiko, x.reaction, { id: '103', bot: false });
  assert.equal(getMarriage(x.db, '1', 1)?.ownerId, '103');
  assert.match(x.sent.at(-1).content, /<@103> has married/);
  assert.ok(release);
  release();
  await Promise.all([advancing, marrying]);
  assert.match(serialized(x.edits.at(-1))[0].content, /Married/);
  const count = x.edits.length;
  await x.clock.advance(60_000);
  assert.equal(x.edits.length, count);
});

test('Discord edit failure cannot prevent reclaim or leave the card transferable', async (t) => {
  const x = runtimeFixture(t);
  t.mock.method(console, 'error', () => {});
  x.card.edit = async () => { throw new Error('Missing permissions'); };
  await runRoll({ message: x.message, yoshiko: x.yoshiko }, 'w', () => 0.02, x.clock);
  await onRollReaction(x.yoshiko, x.reaction, { id: '101', bot: false });
  assert.equal(getRoll(x.db, '1', '10', '500').escapeOutcome, 'reclaimed');
  await x.clock.advance(120_000);
  assert.deepEqual(getMarriage(x.db, '1', 1), x.original);
});

test('failed heart and failed publication keep the roll spent and preserve ownership', async (t) => {
  const x = runtimeFixture(t);
  t.mock.method(console, 'error', () => {});
  x.card.react = async () => { throw new Error('Missing permissions'); };
  await runRoll({ message: x.message, yoshiko: x.yoshiko }, 'w', () => 0.02, x.clock);
  assert.equal(getRoll(x.db, '1', '10', '500').state, 'failed');
  assert.match(serialized(x.edits.at(-1))[0].content, /Canceled/);
  assert.deepEqual(getMarriage(x.db, '1', 1), x.original);
  x.message.id = '101';
  x.message.reply = async () => { throw new Error('Send failed'); };
  await assert.rejects(runRoll({ message: x.message, yoshiko: x.yoshiko }, 'w', () => 0.02, x.clock), /Send failed/);
  assert.equal(getRollStatus(x.db, '1', '102').remaining, 5);
  assert.deepEqual(getMarriage(x.db, '1', 1), x.original);
});

test('escape card pronouns match male and unknown gender', () => {
  for (const [gender, pronoun] of [[' Male ', 'him'], [null, 'them'], ['Non-binary', 'them']]) {
    const card = rollCard({ name_full: 'A', gender }, null, 6,
      { phase: 'public', ownerId: '101', protectedUntil: start + 60_000 });
    assert.equal(serialized(card)[0].content, `**A** has left the harem! Anyone can now marry ${pronoun}!`);
  }
});

test('scheduled refresh cancels a stale marriage instead of opening public access', (t) => {
  const { db, original } = fixture(t);
  publish(db);
  divorceCharacter(db, '1', 1, '101', original.id);
  const roll = refreshEscapeRoll(db, '1', '10', '500', start + 60_000);
  assert.equal(roll.escapeOutcome, 'canceled');
  assert.equal(getMarriage(db, '1', 1), null);
});
