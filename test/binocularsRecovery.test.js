import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCatalog } from '../lib/catalogDb.js';
import { getMysterySession } from '../lib/characterRolls.js';
import { MYSTERY_ROSTER, reserveMysteryAwareRoll } from '../lib/mysteryCoordinator.js';
import { addItemToInventory, getInventory } from '../lib/itemStorage.js';
import { cancelMysteryRuntime, onMysteryButton, recoverMysteryRuntime, startMysteryRoll } from '../lib/mysteryRuntime.js';

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'binoculars-recovery-'));
  const path = join(dir, 'catalog.sqlite');
  let db = openCatalog(path);
  t.after(() => {
    cancelMysteryRuntime(db, { cancelPaidSessions: false });
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  db.exec(`INSERT INTO characters (id, rank, favourites, name_full, gender, anime_titles)
    VALUES (1, 1, 1000, 'Synthetic Prize', 'Female', '["Synthetic Anime"]');
    INSERT INTO anime (id, title_english, genres, tags, season_year, format, is_adult, fetched_at)
    VALUES (10, 'Synthetic Anime', '["Adventure"]', '[{"name":"Space","rank":90}]', 2020, 'TV', 0, 'now');
    INSERT INTO character_anime (character_id, anime_id) VALUES (1, 10)`);
  addItemToInventory(db, '1', '101', 'binoculars', 3);
  const sent = [], deleted = new Set(), dms = [];
  let dmFails = false, fetchFails = false, current = 1100, timerId = 0;
  const timers = new Map();
  const time = {
    now: () => current,
    setTimer(fn) { timers.set(++timerId, fn); return timerId; },
    clearTimer(id) { timers.delete(id); },
  };
  const channel = { id: '10', messages: { async fetch(id) {
    if (fetchFails) throw Object.assign(new Error('temporary fetch failure'), { code: 50013 });
    const message = sent.find(message => message.id === id);
    if (!message || deleted.has(id)) throw Object.assign(new Error('deleted'), { code: 10008 });
    return message;
  } }, async send(payload) {
    const message = { id: String(500 + sent.length), payload,
      async edit(change) { this.payload = { ...this.payload, ...change }; return this; } };
    sent.push(message); return message;
  } };
  const client = { channels: { async fetch() { return channel; } }, users: { async fetch() {
    return { async send(payload) { if (dmFails) throw new Error('DM blocked'); dms.push(payload); return {}; } };
  } } };
  const selection = (MYSTERY_ROSTER.findIndex(entry => entry.id === 'clue_reveal') + 0.1) / MYSTERY_ROSTER.length;
  const draws = [0, 0, selection][Symbol.iterator]();
  const reservation = reserveMysteryAwareRoll(db, { guildId: '1', channelId: '10', commandMessageId: '100',
    userId: '101', pool: 'w', now: 1000, random: () => draws.next().value, mysteryEnabled: true });
  assert.equal(reservation.status, 'mystery');
  await startMysteryRoll({ db, client, reservation, message: { channelId: '10', channel }, ...time, random: () => 0 });
  current = getMysterySession(db, reservation.sessionId).nextAt;
  const [id, begin] = timers.entries().next().value;
  timers.delete(id); await begin();
  const prompt = sent.find(message => JSON.stringify(message.payload).includes(':binoculars'));
  assert.ok(prompt);
  const recover = () => recoverMysteryRuntime({ db, client, ...time,
    random: () => { throw new Error('Recovery must not reroll'); } });
  return {
    get db() { return db; }, sent, deleted, dms, prompt, recover,
    failDM(value) { dmFails = value; }, failFetch(value) { fetchFails = value; },
    charges: () => getInventory(db, '1', '101').find(item => item.item_id === 'binoculars')?.charges ?? 0,
    saved: () => JSON.parse(getMysterySession(db, reservation.sessionId).stateJson).runtime,
    async reopen() {
      cancelMysteryRuntime(db, { cancelPaidSessions: false }); db.close(); db = openCatalog(path);
      return recover();
    },
    async click(message = prompt, overrides = {}) {
      const interaction = { customId: `mystery:${reservation.sessionId}:binoculars`, message,
        guildId: '1', channelId: '10', user: { id: '101' }, isButton: () => true,
        async deferReply() {}, async editReply(content) { this.reply = content; }, ...overrides };
      await onMysteryButton(db, interaction); return interaction.reply;
    },
  };
}

test('unused Binoculars binding survives normal close/reopen and repeated recovery', async t => {
  const f = await fixture(t);
  const allowance = f.db.prepare('SELECT * FROM roll_allowances').all();
  assert.equal((await f.reopen()).safe, true);
  const count = f.sent.length;
  assert.equal((await f.recover()).safe, true);
  assert.equal(f.sent.length, count);
  assert.equal(f.saved().binocularsMessageId, f.prompt.id);
  assert.equal(f.saved().binocularsUsed, false);
  assert.match(await f.click(), /One charge was spent/);
  assert.equal(f.charges(), 2);
  assert.equal(f.dms.length, 1);
  assert.deepEqual(f.db.prepare('SELECT * FROM roll_allowances').all(), allowance);
});

test('used Binoculars cannot spend again across repeated normal reopen, even if edit failed', async t => {
  const f = await fixture(t);
  f.prompt.edit = async () => { throw new Error('temporary edit failure'); };
  assert.match(await f.click(), /One charge was spent/);
  assert.equal(f.saved().binocularsUsed, true);
  for (let i = 0; i < 2; i++) {
    assert.equal((await f.reopen()).safe, true);
    assert.match(await f.click(), /No charge was spent/);
  }
  assert.equal(f.charges(), 2);
  assert.equal(f.dms.length, 1);
  assert.equal(f.sent.length, 3);
});

test('failed DM remains unused and retryable after normal reopen', async t => {
  const f = await fixture(t);
  f.failDM(true);
  assert.match(await f.click(), /Enable DMs and try again/);
  assert.equal(f.charges(), 3);
  assert.equal(f.saved().binocularsUsed, false);
  assert.equal((await f.reopen()).safe, true);
  f.failDM(false);
  assert.match(await f.click(), /One charge was spent/);
  assert.equal(f.charges(), 2);
  assert.equal(f.dms.length, 1);
  assert.ok(f.sent.every(message => !JSON.stringify(message.payload).includes('reveals the answer:')));
});

test('deleted unused prompt is rebound, rejecting old and foreign controls', async t => {
  const f = await fixture(t);
  f.deleted.add(f.prompt.id);
  assert.equal((await f.reopen()).safe, true);
  const replacement = f.sent.at(-1);
  assert.notEqual(replacement.id, f.prompt.id);
  assert.equal(f.saved().binocularsMessageId, replacement.id);
  assert.match(await f.click(), /No charge was spent/);
  assert.match(await f.click(replacement, { user: { id: '102' } }), /Only the roller/);
  assert.match(await f.click(replacement, { channelId: '20' }), /No charge was spent/);
  assert.match(await f.click(replacement), /One charge was spent/);
  assert.equal(f.charges(), 2);
});

test('transient fetch failure defers without replacement or charge and can retry', async t => {
  const f = await fixture(t);
  const before = getMysterySession(f.db, 1), count = f.sent.length;
  f.failFetch(true);
  assert.equal((await f.reopen()).safe, false);
  assert.deepEqual(getMysterySession(f.db, 1), before);
  assert.equal(f.sent.length, count);
  assert.equal(f.charges(), 3);
  f.failFetch(false);
  assert.equal((await f.recover()).safe, true);
  assert.match(await f.click(), /One charge was spent/);
});

for (const mode of ['unpublished', 'legacy', 'overdue']) {
  test(`${mode} Binoculars offer recovery is conservative and does not spend`, async t => {
    const f = await fixture(t);
    const state = JSON.parse(getMysterySession(f.db, 1).stateJson);
    if (mode === 'unpublished') state.runtime.binocularsMessageId = null;
    if (mode === 'legacy') {
      delete state.runtime.binocularsMessageId;
      delete state.runtime.binocularsUsed;
    }
    f.db.prepare('UPDATE mystery_sessions SET state_json=? WHERE id=1').run(JSON.stringify(state));
    if (mode === 'overdue') f.db.prepare('UPDATE mystery_sessions SET next_at=0 WHERE id=1').run();
    const count = f.sent.length;
    assert.equal((await f.reopen()).safe, true);
    assert.equal(f.sent.length, count + (mode === 'unpublished' ? 1 : 0));
    assert.match(await f.click(), /No charge was spent/);
    assert.equal(f.charges(), 3);
    assert.equal(f.dms.length, 0);
  });
}

test('corrupt source snapshot stays a read-only recovery blocker', async t => {
  const f = await fixture(t);
  const state = JSON.parse(getMysterySession(f.db, 1).stateJson);
  state.characterSnapshot.rank = 0;
  f.db.prepare('UPDATE mystery_sessions SET state_json=? WHERE id=1').run(JSON.stringify(state));
  const before = f.db.prepare('SELECT * FROM mystery_sessions').all(), count = f.sent.length;
  const result = await f.reopen();
  assert.equal(result.safe, false);
  assert.equal(result.blockers.length, 1);
  assert.deepEqual(f.db.prepare('SELECT * FROM mystery_sessions').all(), before);
  assert.equal(f.sent.length, count);
  assert.equal(f.charges(), 3);
});
