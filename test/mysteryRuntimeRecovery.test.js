import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFinalCatalog, openCatalog } from '../lib/catalogDb.js';
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

function fixture(t, eventDraw = 0, slotDraw = 0, final = false) {
  const dir = mkdtempSync(join(tmpdir(), 'mystery-runtime-'));
  const db = (final ? createFinalCatalog : openCatalog)(join(dir, 'catalog.sqlite'));
  t.after(() => { cancelMysteryRuntime(db); db.close(); rmSync(dir, { recursive: true, force: true }); });
  const characterId = final ? '12345678-1234-4123-8123-000000000001' : 1;
  if (final) db.prepare("INSERT INTO character_identities(id,creation_method) VALUES (?,'manual')").run(characterId);
  db.prepare(`INSERT INTO characters (id, rank, favourites, name_full, gender, anime_titles, image_url${final ? ', likes_source, tie_order' : ''})
    VALUES (?, 1, 1000, 'Hidden Prize', 'Female', '["Example Anime"]', 'https://example.com/prize.png'${final ? ", 'generated', 1" : ''})`).run(characterId);
  db.exec(`INSERT INTO anime (id, title_english, genres, tags, season_year, format, is_adult, fetched_at)
    VALUES (10, 'Example Anime', '["Adventure"]', '[{"name":"Space","rank":90}]', 2020, 'TV', 0, 'now');
    `);
  db.prepare('INSERT INTO character_anime (character_id, anime_id) VALUES (?, 10)').run(characterId);
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

test('Glass Bridge public lists, final result recovery, and protected claim use the shared runtime', async t => {
  const { db, event, time, start, client } = fixture(t, 'glass_bridge', 0, true);
  await start();
  await time.advanceTo(getMysterySession(db, 1).nextAt);
  const first = event.sent.at(-1);
  await onMysteryButton(db, roundInteraction(first, 1, 'left'));
  await onMysteryButton(db, roundInteraction(first, 1, 'left', '102'));
  assert.match(JSON.stringify(first.components), /### Left[\s\S]*<@101>[\s\S]*<@102>/);
  assert.deepEqual(first.edits.at(-1).allowedMentions.parse, []);
  await time.advanceTo(getMysterySession(db, 1).nextAt);
  assert.match(JSON.stringify(first.components), /Safe side:/);
  assert.doesNotMatch(JSON.stringify(first.components), /mystery:1:choice/);
  await time.advanceTo(getMysterySession(db, 1).nextAt);
  const second = event.sent.at(-1);
  assert.match(JSON.stringify(second.components), /Unpicked[\s\S]*<@101>[\s\S]*<@102>/);
  await onMysteryButton(db, roundInteraction(second, 2, 'left'));
  await onMysteryButton(db, roundInteraction(second, 2, 'right', '102'));
  await time.advanceTo(getMysterySession(db, 1).nextAt);
  cancelMysteryRuntime(db, { cancelPaidSessions: false });
  const recovered = await recoverMysteryRuntime({ db, client, ...time,
    random: () => { throw new Error('result recovery must not draw again'); } });
  assert.equal(recovered.safe, true);
  await time.advanceTo(getMysterySession(db, 1).nextAt);
  await time.advanceTo(getMysterySession(db, 1).nextAt);
  assert.equal(getMysterySession(db, 1).state, 'claim_open');
  assert.equal(getMysterySession(db, 1).winnerId, '101');
  assert.ok(event.sent.at(-1).reactions.includes('❤️'));
});


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

test('Chit reveals before intentionally pinged direct reward and recovers terminal delivery', async (t) => {
  const {db,client,event,time,start}=fixture(t);
  db.exec(`CREATE TABLE IF NOT EXISTS reward_sources(reward_id TEXT PRIMARY KEY REFERENCES vault_rewards(vault_id),
    source_kind TEXT NOT NULL,source_id TEXT NOT NULL,metadata_json TEXT NOT NULL,UNIQUE(source_kind,source_id))`);
  addItemToInventory(db,'1','101','consolation_chit',1,{now:1000});
  db.prepare('INSERT INTO claim_allowances VALUES (?,?,?)').run('1','101',2);
  await start(); await time.advanceTo(6100);
  await onMysteryButton(db,doorInteraction(event.sent[1],'1'));
  assert.equal(JSON.parse(getMysterySession(db,1).stateJson).runtime.consolation.status,'activated');
  const {recoverVaultRewards}=await import('../lib/vaultRuntime.js');
  await recoverVaultRewards(db,client,{now:time.now});
  assert.equal(event.sent.some(m=>m.payload.nonce && m.payload.allowedMentions?.users?.includes('101')),false);
  await time.advanceTo(9100);
  assert.equal(getMysterySession(db,1).outcome,'consolation');
  const saved=JSON.parse(getMysterySession(db,1).stateJson).runtime;
  assert.equal(saved.consolationRevealAcknowledged,true);
  const prize=event.sent.findIndex(m=>m.id===saved.prizeMessageId);
  const reward=event.sent.findIndex(m=>m.payload.nonce && m.payload.allowedMentions?.users?.includes('101'));
  assert.ok(reward>prize);
  assert.deepEqual(event.sent[prize].reactions,[]);
  const count=event.sent.length;
  await recoverMysteryRuntime({db,client,...time});
  await recoverVaultRewards(db,client,{now:time.now});
  assert.equal(event.sent.length,count);
});

test('terminal Chit without reveal acknowledgement recovers reveal before reward without reroll', async (t) => {
  const {db,client,event,time,start}=fixture(t);
  db.exec(`CREATE TABLE IF NOT EXISTS reward_sources(reward_id TEXT PRIMARY KEY REFERENCES vault_rewards(vault_id),
    source_kind TEXT NOT NULL,source_id TEXT NOT NULL,metadata_json TEXT NOT NULL,UNIQUE(source_kind,source_id))`);
  addItemToInventory(db,'1','101','consolation_chit',1,{now:1000});
  db.prepare('INSERT INTO claim_allowances VALUES (?,?,?)').run('1','101',2);
  await start(); await time.advanceTo(6100);
  await onMysteryButton(db,doorInteraction(event.sent[1],'1'));
  cancelMysteryRuntime(db,{cancelPaidSessions:false});
  db.prepare("UPDATE mystery_sessions SET state='completed',outcome='consolation',resolved_at=9100,next_at=NULL WHERE id=1").run();
  const before=getInventory(db,'1','101',7000);
  assert.equal(inspectMysteryRuntime(db).recoverable.length,1);
  assert.equal((await recoverMysteryRuntime({db,client,...time,random:()=>{throw new Error('no reroll');}})).safe,true);
  assert.equal(JSON.parse(getMysterySession(db,1).stateJson).runtime.consolationRevealAcknowledged,true);
  assert.deepEqual(getInventory(db,'1','101',7000),before);
  const state=JSON.parse(getMysterySession(db,1).stateJson);
  assert.ok(event.sent.findIndex(m=>m.payload.nonce && m.payload.allowedMentions?.users?.includes('101'))>event.sent.findIndex(m=>m.id===state.runtime.prizeMessageId));
});

test('corrupt saved paid Chit linkage blocks recovery instead of reactivating', async (t) => {
  const {db,event,time,start}=fixture(t);
  db.exec(`CREATE TABLE IF NOT EXISTS reward_sources(reward_id TEXT PRIMARY KEY REFERENCES vault_rewards(vault_id),
    source_kind TEXT NOT NULL,source_id TEXT NOT NULL,metadata_json TEXT NOT NULL,UNIQUE(source_kind,source_id))`);
  addItemToInventory(db,'1','101','consolation_chit',2,{now:1000});
  db.prepare('INSERT INTO claim_allowances VALUES (?,?,?)').run('1','101',2);
  await start(); await time.advanceTo(6100);
  await onMysteryButton(db,doorInteraction(event.sent[1],'1'));
  cancelMysteryRuntime(db,{cancelPaidSessions:false});
  const before=getInventory(db,'1','101',7000);
  db.prepare("UPDATE reward_sources SET source_kind='unknown'").run();
  const report=inspectMysteryRuntime(db);
  assert.equal(report.safe,false);
  assert.match(report.blockers[0].reason,/provenance/);
  assert.deepEqual(getInventory(db,'1','101',7000),before);
});

for (const eventId of ['doors', 'clue_reveal']) for (const compensated of [false, true]) {
  test(`${eventId} winner mentions respect reveal ordering: Chit=${compensated}`, async t => {
    const { db, event, time, start } = fixture(t, eventId);
    if (compensated) {
      db.exec(`CREATE TABLE IF NOT EXISTS reward_sources(reward_id TEXT PRIMARY KEY REFERENCES vault_rewards(vault_id),
        source_kind TEXT NOT NULL,source_id TEXT NOT NULL,metadata_json TEXT NOT NULL,UNIQUE(source_kind,source_id))`);
      addItemToInventory(db, '1', '101', 'consolation_chit', 1, { now: 1000 });
      db.prepare('INSERT INTO claim_allowances VALUES (?,?,?)').run('1', '101', 2);
    }
    await start(); await time.advanceTo(6100);
    if (eventId === 'doors') await onMysteryButton(db, doorInteraction(event.sent[1], '1'));
    else await onMysteryAnswer(db, { guildId: '1', channelId: '20', author: { id: '101' },
      content: JSON.parse(getMysterySession(db, 1).stateJson).title });
    const pings = () => event.sent.filter(m => m.payload.allowedMentions?.users?.includes('101'));
    assert.equal(pings().length, compensated ? 0 : 1, 'all intentional pre-reveal winner mentions');
    assert.match(event.sent.at(-1).payload.content, eventId === 'doors' ? /has chosen/ : /won! Revealing/);
    await time.advanceTo(getMysterySession(db, 1).nextAt);
    const saved = JSON.parse(getMysterySession(db, 1).stateJson).runtime;
    const prizeIndex = event.sent.findIndex(m => m.id === saved.prizeMessageId);
    assert.ok(prizeIndex >= 0);
    assert.equal(pings().length, 1, 'normal announcement or final Chit reward still pings');
    if (compensated) {
      assert.ok(event.sent.indexOf(pings()[0]) > prizeIndex);
      assert.ok(pings()[0].payload.nonce);
    }
  });
}

for (const terminal of [false, true]) for (const ack of [undefined, false, true, null, 0, 1, 'true', {}, []]) {
  for (const messageId of [undefined, '123', '', 123, null]) {
    test(`Chit acknowledgement integrity: terminal=${terminal} ack=${JSON.stringify(ack)} message=${JSON.stringify(messageId)}`, async t => {
      const { db, event, time, start } = fixture(t, 'doors', 0, true);
      addItemToInventory(db, '1', '101', 'consolation_chit', 1, { now: 1000 });
      db.prepare('INSERT INTO claim_allowances VALUES (?,?,?)').run('1', '101', 2);
      await start(); await time.advanceTo(6100);
      await onMysteryButton(db, doorInteraction(event.sent[1], '1'));
      cancelMysteryRuntime(db, { cancelPaidSessions: false });
      const state = JSON.parse(getMysterySession(db, 1).stateJson);
      if (ack !== undefined) state.runtime.consolationRevealAcknowledged = ack;
      if (messageId !== undefined) state.runtime.prizeMessageId = messageId;
      db.prepare('UPDATE mystery_sessions SET state_json=? WHERE id=1').run(JSON.stringify(state));
      if (terminal) db.exec("UPDATE mystery_sessions SET state='completed',outcome='consolation',resolved_at=9100,next_at=NULL WHERE id=1");
      const before = db.prepare('SELECT * FROM mystery_sessions').all();
      const valid = (ack === undefined || typeof ack === 'boolean')
        && (messageId === undefined || messageId === '123') && (ack !== true || messageId === '123');
      const report = inspectMysteryRuntime(db);
      assert.equal(report.safe, valid, JSON.stringify(report.blockers));
      assert.equal(report.recoverable.length, valid && !(terminal && ack === true) ? 1 : 0);
      const { inspectCatalogRuntimeRestart } = await import('../lib/catalogRuntimeRecovery.js');
      const preflight = inspectCatalogRuntimeRestart(db);
      assert.equal(preflight.ready, valid, JSON.stringify(preflight.blockers));
      assert.deepEqual(db.prepare('SELECT * FROM mystery_sessions').all(), before);
    });
  }
}
