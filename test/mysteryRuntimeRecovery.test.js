import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCatalog } from '../lib/catalogDb.js';
import { claimRoll, getClaimStatus, getMysterySession } from '../lib/characterRolls.js';
import { MYSTERY_ROSTER, reserveMysteryAwareRoll, setMysteryEventChannel } from '../lib/mysteryCoordinator.js';
import { onRollReaction } from '../lib/characterRollRuntime.js';
import { addItemToInventory, getInventory } from '../lib/itemStorage.js';
import { closesAt, RESULT_DURATION_MS } from '../lib/mysteryEvents/roundContest.js';
import { cancelMysteryRuntime, onMysteryAnswer, onMysteryButton,
  startMysteryRoll, inspectMysteryRuntime, recoverMysteryRuntime } from '../lib/mysteryRuntime.js';

function clock(start = 1100) {
  let current = start;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => current,
    setTimer(callback, delay) {
      const id = nextId++;
      timers.set(id, { at: current + delay, callback });
      return id;
    },
    clearTimer(id) { timers.delete(id); },
    async advanceTo(target) {
      while (true) {
        const due = [...timers].filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        current = Math.max(current, due[1].at);
        await due[1].callback();
      }
      current = target;
    },
    pending: () => timers.size,
    jumpTo: (at) => { current = at; },
  };
}

function channel(id) {
  const sent = [];
  return {
    id, sent, messages: { async fetch(id) { const found = sent.find(m => m.id === id); if (!found) throw Object.assign(new Error("Unknown Message"), { code: 10008 }); return found; } },
    async send(payload) {
      const messageId = String(500 + sent.length + Number(id) * 10);
      const item = { id: messageId, url: `https://discord.com/channels/1/${id}/${messageId}`,
        channelId: id, payload, edits: [], reactions: [], embeds: payload.embeds || [], components: payload.components || [],
        async edit(change) {
          this.edits.push(change);
          if (change.embeds) this.embeds = change.embeds;
          if (change.components) this.components = change.components;
          return this;
        },
        async react(emoji) { this.reactions.push(emoji); },
      };
      sent.push(item);
      return item;
    },
  };
}

function fixture(t, eventDraw = 0, slotDraw = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'mystery-runtime-'));
  const db = openCatalog(join(dir, 'catalog.sqlite'));
  t.after(() => { cancelMysteryRuntime(db); db.close(); rmSync(dir, { recursive: true, force: true }); });
  db.exec(`INSERT INTO characters (id, rank, favourites, name_full, gender, anime_titles, image_url)
    VALUES (1, 1, 1000, 'Hidden Prize', 'Female', '["Example Anime"]', 'https://example.com/prize.png')`);
  db.exec(`INSERT INTO anime (id, title_english, genres, tags, season_year, format, is_adult, fetched_at)
    VALUES (10, 'Example Anime', '["Adventure"]', '[{"name":"Space","rank":90}]', 2020, 'TV', 0, 'now');
    INSERT INTO character_anime (character_id, anime_id) VALUES (1, 10)`);
  const origin = channel('10');
  const event = channel('20');
  setMysteryEventChannel(db, '1', '20');
  const eventId = typeof eventDraw === 'string' ? eventDraw : eventDraw < 0.5 ? 'doors' : 'clue_reveal';
  const selection = (MYSTERY_ROSTER.findIndex((entry) => entry.id === eventId) + 0.1) / MYSTERY_ROSTER.length;
  const draws = [0, 0, selection][Symbol.iterator]();
  const reservation = reserveMysteryAwareRoll(db, { guildId: '1', channelId: '10',
    commandMessageId: '100', userId: '101', pool: 'w', now: 1000,
    random: () => draws.next().value, mysteryEnabled: true });
  assert.equal(reservation.status, 'mystery');
  const message = { id: '100', guildId: '1', channelId: '10', channel: origin, author: { id: '101' } };
  const client = { channels: { async fetch(id) { assert.equal(id, '20'); return event; } } };
  const time = clock();
  const start = () => startMysteryRoll({ db, client, message, reservation, ...time,
    random: typeof slotDraw === 'function' ? slotDraw : () => slotDraw });
  return { db, origin, event, reservation, time, start, client, dir };
}

function doorInteraction(intro, value, userId = '101') {
  const acknowledgements = [];
  return { customId: `mystery:1:door:${value}`, message: intro, guildId: '1', channelId: '20',
    user: { id: userId }, acknowledgements, isButton: () => true,
    async deferReply(payload) { acknowledgements.push(payload); },
    async editReply(content) { acknowledgements.push(content); },
  };
}

function roundPrompt(event, name, round) {
  const needle = `${name} · Round ${round}/`;
  return event.sent.find((message) => JSON.stringify(message.payload).includes(needle));
}

function roundInteraction(prompt, round, value, userId = '101') {
  return { ...doorInteraction(prompt, value, userId), customId: `mystery:1:choice:${round}:${value}` };
}

async function beginContest({ db, time, start }) {
  await start();
  await time.advanceTo(getMysterySession(db, 1).nextAt);
  const { startedAt } = JSON.parse(getMysterySession(db, 1).stateJson);
  const close = (round) => closesAt({ startedAt, round });
  return { close, open: (round) => round === 1 ? startedAt : close(round - 1) + RESULT_DURATION_MS };
}


for (const phase of ['reserved', 'running', 'countdown', 'loss_reveal', 'claim_open']) {
  test(`file-backed recovery preserves ${phase} without reroll or charge`, async (t) => {
    const f = fixture(t);
    const { db, event, time, start, client, dir } = f;
    await start();
    if (phase !== 'reserved') await time.advanceTo(6100);
    if (['countdown','loss_reveal','claim_open'].includes(phase))
      await onMysteryButton(db, doorInteraction(event.sent[1], phase === 'loss_reveal' ? '2' : '1'));
    if (['loss_reveal','claim_open'].includes(phase)) await time.advanceTo(9100);
    const before = getMysterySession(db, 1);
    const allowance = db.prepare('SELECT * FROM roll_allowances').all();
    cancelMysteryRuntime(db, { cancelPaidSessions: false });
    const reopened = openCatalog(join(dir, 'catalog.sqlite'));
    // Close before the fixture's directory cleanup (Windows locks open files).
    const recover = () => recoverMysteryRuntime({ db: reopened, client, ...time,
      random: () => { if (phase !== 'reserved') throw new Error('unexpected selection'); return 0; } });
    assert.equal((await recover()).safe, true);
    const pending = time.pending();
    assert.equal((await recover()).safe, true);
    assert.equal(time.pending(), pending);
    assert.deepEqual(getMysterySession(reopened, 1), before);
    assert.deepEqual(db.prepare('SELECT * FROM roll_allowances').all(), allowance);
    await time.advanceTo(100000);
    assert.equal(getMysterySession(reopened, 1).state, 'completed');
    if (phase === 'loss_reveal') assert.equal(getMysterySession(reopened, 1).outcome, 'no_winner');
    cancelMysteryRuntime(reopened); reopened.close();
  });
}

test('legacy ambiguous Doors is a read-only blocker', async (t) => {
  const { db, start, time, event } = fixture(t);
  await start(); await time.advanceTo(6100);
  await onMysteryButton(db, doorInteraction(event.sent[1], '2'));
  const state = JSON.parse(getMysterySession(db, 1).stateJson); delete state.runtime;
  db.prepare('UPDATE mystery_sessions SET state_json=? WHERE id=1').run(JSON.stringify(state));
  const before = getMysterySession(db, 1);
  assert.equal(inspectMysteryRuntime(db).safe, false);
  assert.deepEqual(getMysterySession(db, 1), before);
});

test('transient fetch defers without replacement; 10008 replaces only running controls', async (t) => {
  const { db, client, event, time, start } = fixture(t);
  await start(); await time.advanceTo(6100); cancelMysteryRuntime(db, { cancelPaidSessions: false });
  const original = event.messages.fetch;
  const count = event.sent.length;
  event.messages.fetch = async () => { throw Object.assign(new Error('temporary'), { code: 50013 }); };
  assert.equal((await recoverMysteryRuntime({ db, client, ...time })).safe, false);
  assert.equal(event.sent.length, count);
  assert.equal(getMysterySession(db, 1).state, 'running');
  event.messages.fetch = async () => { throw Object.assign(new Error('deleted'), { code: 10008 }); };
  assert.equal((await recoverMysteryRuntime({ db, client, ...time })).safe, true);
  const stale = doorInteraction(event.sent[1], '1');
  await onMysteryButton(db, stale);
  assert.match(stale.acknowledgements.at(-1), /expired/);
  assert.equal(event.sent.length, count + 1);
  event.messages.fetch = original;
});

test('overdue countdown cannot reset the original claim window', async (t) => {
  const { db, client, time, event, start } = fixture(t);
  await start(); await time.advanceTo(6100);
  await onMysteryButton(db, doorInteraction(event.sent[1], '1'));
  cancelMysteryRuntime(db, { cancelPaidSessions: false }); time.jumpTo(100000);
  await recoverMysteryRuntime({ db, client, ...time });
  await time.advanceTo(100000);
  assert.equal(getMysterySession(db, 1).outcome, 'expired');
});
