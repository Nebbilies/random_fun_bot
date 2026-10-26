import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFinalCatalog, openCatalog, openCatalogReadOnly } from '../lib/catalogDb.js';
import { runRoll, onRollReaction, recoverRollRuntime, recoverForcedEscapes,
  startForcedEscape } from '../lib/characterRollRuntime.js';
import { reserveRoll, getRollStatus, getMysterySession, loadRollCharacterSnapshot } from '../lib/characterRolls.js';
import { reserveMysteryAwareRoll, MYSTERY_ROSTER } from '../lib/mysteryCoordinator.js';
import { startMysteryRoll, onMysteryButton, onMysteryAnswer, cancelMysteryRuntime } from '../lib/mysteryRuntime.js';
import { startItemAction, onItemActionInteraction, recoverItemActionRuntime } from '../lib/itemActionRuntime.js';
import { getItemAction } from '../lib/itemActionStorage.js';
import { activateItemAction, updateItemSelection } from '../lib/itemActions.js';
import { addItemToInventory, getInventory } from '../lib/itemStorage.js';
import { executeItemUseById } from '../commands/use.js';
import { revealVaultReward } from '../lib/vaultRewards.js';
import { startTrade, onTradeAnswer, cancelTransfer } from '../lib/tradeRuntime.js';
import { inspectCatalogRuntimeRestart, assertCatalogRuntimeRestartReady } from '../lib/catalogRuntimeRecovery.js';

// Actual authoritative final schema, never defaultDB, legacy release-v12 DDL, or
// a raw DatabaseSync reopen. New connection identities discard WeakMap runtimes.
// Explicitly discard fake timers at crash; do NOT run graceful cancellation first.
const IDS = [1, 2, 3, 4].map(n => `12345678-1234-4123-8123-${String(n).padStart(12, '0')}`);
function clock(start = 1_800_000_000_000) {
  let current = start;
  const timers = new Map();
  let serial = 0;
  return {
    now: () => current,
    setTimer(fn, delay) { const id = ++serial; timers.set(id, { fn, at: current + delay }); return id; },
    clearTimer(id) { timers.delete(id); },
    crash() { timers.clear(); },
    pending: () => timers.size,
    async advance(at) {
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= at).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]); current = due[1].at; await due[1].fn();
      }
      current = at;
    },
  };
}
function discord() {
  const sent = [], messages = new Map();
  const channel = { id: '10', guildId: '1', sent, messages: {
    async fetch(id) { if (!messages.has(id)) throw Object.assign(Error('missing'), { code: 10008 }); return messages.get(id); },
  }, async send(payload) {
    const card = { id: String(500 + sent.length), guildId: '1', channelId: '10', channel,
      payload, embeds: payload.embeds ?? [], components: payload.components ?? [], edits: [],
      async react() {}, async edit(change) {
        this.edits.push(change); this.payload = change;
        this.embeds = change.embeds ?? this.embeds; this.components = change.components ?? this.components;
        return this;
      } };
    sent.push(card); messages.set(card.id, card); return card;
  } };
  const client = { channels: { async fetch(id) { assert.equal(id, '10'); return channel; } } };
  const message = (id = '100', userId = '101', content = '') => ({ id, guildId: '1', channelId: '10',
    author: { id: userId }, channel, client, content, reply: payload => channel.send(payload),
    guild: { members: { cache: new Map([['202', { id: '202' }]]) } } });
  function click(customId, card, userId = '101') {
    const replies = [];
    const interaction = { customId, message: card, guildId: '1', channelId: '10', user: { id: userId }, client,
      replies, isButton: () => true, async deferReply() {}, async editReply(text) { replies.push(text); },
      async deferUpdate() { this.deferred = true; }, async reply(data) { replies.push(data); },
      async followUp(data) { replies.push(data); } };
    return interaction;
  }
  return { channel, client, message, click, sent };
}
function fixture(t, count = 1) {
  const directory = mkdtempSync(join(tmpdir(), 'catalog-runtime-restart-'));
  const path = join(directory, 'synthetic.sqlite');
  let db = createFinalCatalog(path);
  for (let i = 0; i < count; i++) {
    db.prepare("INSERT INTO character_identities(id,creation_method) VALUES (?,'manual')").run(IDS[i]);
    db.prepare(`INSERT INTO characters(id,rank,favourites,tie_order,likes_source,name_full,gender,anime_titles,image_url)
      VALUES (?,?,?,?,'generated',?,'Female','["Original show"]','https://example.invalid/original.png')`)
      .run(IDS[i], i + 1, 1234 - i, i + 1, `Original ${i + 1}`);
  }
  const time = clock();
  t.mock.method(Date, 'now', time.now);
  // Item runtime has no clock injection; fake only its background sweeper, never
  // let a closed pre-crash DB be touched. Recovery is explicitly invoked below.
  t.mock.method(globalThis, 'setInterval', () => ({ unref() {} }));
  t.after(() => { time.crash(); if (db.isOpen) db.close(); rmSync(directory, { recursive: true, force: true }); });
  return { get db() { return db; }, path, time, ...discord(),
    reopen(readOnly = false) { time.crash(); db.close(); db = (readOnly ? openCatalogReadOnly : openCatalog)(path); return db; },
  };
}
function terms(f, rollId) { return loadRollCharacterSnapshot(f.db, rollId); }
function rows(db) {
  return db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all()
    .map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}"`).all()]);
}
function marry(f, index, owner = '202') {
  const result = f.db.prepare("INSERT INTO marriages(guild_id,character_id,owner_id,married_at) VALUES ('1',?,?,?)")
    .run(IDS[index], owner, new Date(f.time.now()).toISOString());
  return { characterId: IDS[index], marriageId: Number(result.lastInsertRowid), ownerId: owner };
}
async function heart(f, card, userId = '202') {
  await onRollReaction({ catalogDb: f.db }, { emoji: { name: '❤️' }, message: card }, { id: userId });
}
const codes = f => inspectCatalogRuntimeRestart(f.db).blockers.map(b => b.code);

// These are behavioral acceptance tests, not claims that all restart cases work.
// Negative assertions pin existing destructive/degraded behavior so integration
// cannot mistake a successful SQLite open for resumed timers or compensated costs.
test('normal final-v12 startup/readOnly is non-mutating; published ordinary reaction settles once with captured UUID terms', async t => {
  const f = fixture(t);
  await runRoll({ message: f.message(), yoshiko: { catalogDb: f.db, mysteryEnabled: false,
    imagePicker: { pick: async () => ({ url: 'https://example.invalid/original.png' }) } } }, 'w', () => 0.5, f.time);
  const roll = f.db.prepare('SELECT * FROM character_rolls').get();
  const snapshot = terms(f, roll.id);
  assert.equal(roll.state, 'open'); assert.equal(snapshot.id, IDS[0]);
  f.db.exec("UPDATE characters SET name_full='Edited',favourites=99");
  f.reopen(true);
  const bytes = readFileSync(f.path), before = rows(f.db);
  assert.equal(f.db.prepare('PRAGMA user_version').get().user_version, 12);
  assert.equal(f.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.equal(assertCatalogRuntimeRestartReady(f.db).ready, true);
  assert.deepEqual(terms(f, roll.id), snapshot);
  assert.throws(() => f.db.exec('DELETE FROM character_rolls'), /readonly/);
  assert.deepEqual(rows(f.db), before);
  f.reopen(); assert.deepEqual(readFileSync(f.path), bytes);
  assert.equal(recoverRollRuntime(f.db), 1);
  await heart(f, f.sent[0]); await heart(f, f.sent[0], '303');
  const marriages = f.db.prepare('SELECT character_id,owner_id FROM marriages').all();
  assert.deepEqual(marriages.map(r => [r.character_id, r.owner_id]), [[IDS[0], '202']]);
  assert.match(f.sent[1].payload.content, /Original 1/);
  assert.deepEqual(terms(f, roll.id), snapshot);
  f.reopen(); assert.equal(recoverRollRuntime(f.db), 0);
  await heart(f, f.sent[0]);
  assert.equal(f.db.prepare('SELECT count(*) n FROM marriages').get().n, 1);
});

test('ordinary pending crash: preflight refuses without refund guesses; current startup fails reservation and retains spent allowance', t => {
  const f = fixture(t);
  const r = reserveRoll(f.db, { guildId: '1', channelId: '10', commandMessageId: '100', userId: '101', pool: 'w', now: f.time.now(), random: () => 0.5 });
  assert.equal(r.status, 'reserved'); const snapshot = terms(f, r.rollId);
  const remaining = getRollStatus(f.db, '1', '101', f.time.now()).remaining;
  f.reopen(true); const before = rows(f.db), bytes = readFileSync(f.path);
  assert.throws(() => assertCatalogRuntimeRestartReady(f.db), { code: 'CATALOG_RUNTIME_RECOVERY_REQUIRED' });
  assert.deepEqual(codes(f), ['ordinary_delivery_pending']); assert.deepEqual(rows(f.db), before);
  f.reopen(); assert.deepEqual(readFileSync(f.path), bytes);
  assert.equal(recoverRollRuntime(f.db), 0);
  assert.equal(f.db.prepare('SELECT state FROM character_rolls').get().state, 'failed');
  assert.equal(getRollStatus(f.db, '1', '101', f.time.now()).remaining, remaining);
  assert.deepEqual(terms(f, r.rollId), snapshot);
});

for (const phase of ['reserved', 'running', 'countdown', 'claim_open']) {
  test(`mystery ${phase} crash: no runtime is restored; current cancellation retains terms/cost and blocks stale interactions`, async t => {
    const f = fixture(t);
    const eventDraw = (MYSTERY_ROSTER.findIndex(e => e.id === 'doors') + 0.1) / MYSTERY_ROSTER.length;
    const draws = [0, 0, eventDraw][Symbol.iterator]();
    const r = reserveMysteryAwareRoll(f.db, { guildId: '1', channelId: '10', commandMessageId: '100', userId: '101', pool: 'w',
      now: f.time.now(), mysteryEnabled: true, random: () => draws.next().value });
    assert.equal(r.status, 'mystery');
    await startMysteryRoll({ db: f.db, client: f.client, message: f.message(), reservation: r, ...f.time, random: () => 0 });
    if (phase !== 'reserved') await f.time.advance(getMysterySession(f.db, r.sessionId).nextAt);
    if (['countdown', 'claim_open'].includes(phase)) {
      await onMysteryButton(f.db, f.click(`mystery:${r.sessionId}:door:1`, f.sent.at(-1)));
      if (phase === 'claim_open') await f.time.advance(getMysterySession(f.db, r.sessionId).nextAt);
    }
    assert.equal(getMysterySession(f.db, r.sessionId).state, phase);
    assert.ok(f.time.pending());
    const snapshot = terms(f, r.rollId), remaining = getRollStatus(f.db, '1', '101', f.time.now()).remaining;
    const last = f.sent.at(-1), sent = f.sent.length;
    f.reopen(); assert.equal(f.time.pending(), 0);
    assert.ok(codes(f).includes('mystery_runtime_missing'));
    const before = rows(f.db);
    const stale = f.click(`mystery:${r.sessionId}:${phase === 'claim_open' ? 'decline' : 'door:1'}`, last);
    assert.equal(await onMysteryButton(f.db, stale), true);
    assert.match(stale.replies[0], /expired|no longer available/);
    assert.equal(await onMysteryAnswer(f.db, f.message('101', '101', 'answer')), false);
    assert.deepEqual(rows(f.db), before);
    // Exact pre-ready sequence currently in index.js (not a proposed refund policy).
    assert.equal(cancelMysteryRuntime(f.db), 1); recoverRollRuntime(f.db);
    assert.equal(getMysterySession(f.db, r.sessionId).state, 'canceled');
    await heart(f, last);
    assert.equal(f.db.prepare('SELECT count(*) n FROM marriages').get().n, 0);
    assert.equal(getRollStatus(f.db, '1', '101', f.time.now()).remaining, remaining);
    assert.deepEqual(terms(f, r.rollId), snapshot);
    assert.equal(f.sent.length, sent); // No repaired UI or restart notice.
    assert.equal(cancelMysteryRuntime(f.db), 0);
  });
}

function siren(f) {
  const target = marry(f, 0);
  const inventoryId = addItemToInventory(f.db, '1', '101', 'sirens_call').item.id;
  const result = executeItemUseById(f.db, '1', '101', inventoryId, ['202'], { channelId: '10', now: f.time.now(), random: () => 0 });
  assert.equal(result.success, true); assert.equal(getInventory(f.db, '1', '101').length, 0);
  return { target, result, id: result.escapeAttempt.pendingRollId };
}

test('Siren pending: real dispatcher spent cost/UUID survive; failed recovery retries; missing windows remain an explicit guard blocker', async t => {
  const f = fixture(t); const { id, target } = siren(f); const snapshot = terms(f, id);
  assert.equal(f.db.prepare('SELECT rules_json FROM character_rolls').get().rules_json, null);
  f.db.exec("UPDATE characters SET name_full='Edited',favourites=1");
  f.reopen(); const before = rows(f.db);
  assert.deepEqual(codes(f), ['forced_delivery_pending', 'forced_rules_unavailable']);
  assert.throws(() => assertCatalogRuntimeRestartReady(f.db), /forced_rules_unavailable/);
  assert.deepEqual(rows(f.db), before);
  recoverRollRuntime(f.db); // Pending Siren exception must preserve its spent item.
  await recoverForcedEscapes(f.db, { channels: { fetch: async () => { throw Error('offline'); } } });
  assert.equal(f.db.prepare('SELECT state FROM character_rolls').get().state, 'pending');
  assert.deepEqual(terms(f, id), snapshot);
  // Characterize existing fallback only: NOT endorsed as faithful recovery of
  // published windows. Guard above intentionally refuses this current behavior.
  t.mock.method(globalThis, 'setTimeout', f.time.setTimer);
  t.mock.method(globalThis, 'clearTimeout', f.time.clearTimer);
  await recoverForcedEscapes(f.db, f.client);
  assert.equal(f.db.prepare('SELECT state FROM character_rolls').get().state, 'open');
  assert.match(JSON.stringify(f.sent[0].payload), /Original 1/);
  assert.doesNotMatch(JSON.stringify(f.sent[0].payload), /Edited/);
  await recoverForcedEscapes(f.db, f.client); assert.equal(f.sent.length, 1);
  await heart(f, f.sent[0]); await heart(f, f.sent[0]);
  assert.equal(f.db.prepare('SELECT escape_outcome FROM character_rolls').get().escape_outcome, 'reclaimed');
  assert.equal(f.db.prepare('SELECT id FROM marriages').get().id, target.marriageId);
  assert.equal(getInventory(f.db, '1', '101').length, 0);
});

test('Siren corrupt terms stay pending and spent across retry, never fall back to live character', async t => {
  const f = fixture(t); siren(f);
  f.db.exec("UPDATE character_rolls SET character_snapshot_json='{}'"); f.reopen();
  const before = rows(f.db);
  assert.ok(codes(f).includes('invalid_terms'));
  await recoverForcedEscapes(f.db, f.client);
  assert.deepEqual(rows(f.db), before); assert.equal(f.sent.length, 0);
  assert.equal(getInventory(f.db, '1', '101').length, 0);
});

test('published forced escape is canceled by existing startup, not resumed or refunded', async t => {
  const f = fixture(t); const { result, target } = siren(f);
  await startForcedEscape({ db: f.db, channel: f.channel, guildId: '1', channelId: '10', ...result.escapeAttempt, ...f.time });
  assert.ok(f.time.pending()); f.reopen();
  assert.deepEqual(codes(f), ['escape_runtime_missing']);
  recoverRollRuntime(f.db); await recoverForcedEscapes(f.db, f.client);
  await heart(f, f.sent[0], '303');
  assert.equal(f.db.prepare('SELECT owner_id FROM marriages WHERE id=?').get(target.marriageId).owner_id, '202');
  assert.equal(f.db.prepare('SELECT state,escape_outcome FROM character_rolls').get().escape_outcome, 'canceled');
  assert.equal(getInventory(f.db, '1', '101').length, 0); assert.equal(f.sent.length, 1);
});

test('item confirming restarts through bound runtime controls; committed effect announcement retry never reactivates or consumes twice', async t => {
  const f = fixture(t, 2); marry(f, 0, '101'); marry(f, 1, '101');
  const inv = addItemToInventory(f.db, '1', '101', 'kaimetsu').item.id;
  const action = await startItemAction({ db: f.db, message: f.message(), inventoryId: inv });
  const prompt = f.sent[0]; f.reopen();
  assert.deepEqual(codes(f), ['item_reconciliation_required']);
  let runtime = await recoverItemActionRuntime(f.db, f.client);
  assert.equal(getItemAction(f.db, action.id).state, 'confirming');
  assert.equal(getInventory(f.db, '1', '101').length, 1);
  // Commit through the real interaction router, but lose the result edit.
  const edit = prompt.edit;
  prompt.edit = async () => { throw Error('delivery interrupted'); };
  await onItemActionInteraction(f.db, f.click(`item:${action.id}:confirm`, prompt));
  assert.equal(getItemAction(f.db, action.id).state, 'resolved');
  assert.equal(getItemAction(f.db, action.id).delivery_pending, 1);
  const committed = rows(f.db); runtime.stop(); f.reopen(); prompt.edit = edit;
  runtime = await recoverItemActionRuntime(f.db, f.client); t.after(runtime.stop);
  await onItemActionInteraction(f.db, f.click(`item:${action.id}:confirm`, prompt));
  await runtime.reconcile();
  assert.equal(getItemAction(f.db, action.id).delivery_pending, 0);
  assert.equal(getInventory(f.db, '1', '101').length, 0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM marriages').get().n, 1);
  assert.deepEqual(rows(f.db).filter(([name]) => name !== 'item_actions'), committed.filter(([name]) => name !== 'item_actions'));
  assert.equal(assertCatalogRuntimeRestartReady(f.db).ready, true);
});

for (const delivered of [false, true]) test(`Hostage ${delivered ? 'active' : 'unconfirmed delivery'} restart uses existing escrow semantics, not guessed cost`, async t => {
  const f = fixture(t, 2); const own = marry(f, 0, '101'), target = marry(f, 1);
  const inv = addItemToInventory(f.db, '1', '101', 'hostage_note').item.id;
  const action = await startItemAction({ db: f.db, message: f.message(), inventoryId: inv });
  assert.equal(updateItemSelection(f.db, action.id, '1', '101', { own, targets: [target] }), true);
  if (delivered) await onItemActionInteraction(f.db, f.click(`item:${action.id}:confirm`, f.sent[0]));
  else assert.equal(activateItemAction(f.db, { actionId: action.id, guildId: '1', actorId: '101' }).status, 'awaiting_delivery');
  f.reopen();
  const runtime = await recoverItemActionRuntime(f.db, f.client); t.after(runtime.stop);
  const recovered = getItemAction(f.db, action.id);
  assert.equal(recovered.state, delivered ? 'active' : 'canceled');
  assert.equal(getInventory(f.db, '1', '101').length, delivered ? 0 : 1);
  if (delivered) {
    const prompt = await f.channel.messages.fetch(recovered.message_id);
    await onItemActionInteraction(f.db, f.click(`item:${action.id}:exchange`, prompt, '202'));
    await onItemActionInteraction(f.db, f.click(`item:${action.id}:exchange`, prompt, '202'));
    assert.equal(getItemAction(f.db, action.id).state, 'resolved');
    assert.equal(f.db.prepare('SELECT owner_id FROM marriages WHERE character_id=?').get(IDS[0]).owner_id, '202');
    assert.equal(f.db.prepare('SELECT owner_id FROM marriages WHERE character_id=?').get(IDS[1]).owner_id, '101');
  }
  assert.equal(f.db.prepare('SELECT count(*) n FROM marriages').get().n, 2);
});

test('vault pending delivery is not falsely reported as startup-ready or discarded by the guard', t => {
  const f = fixture(t);
  revealVaultReward(f.db, { vaultId: 'synthetic-vault', guildId: '1', userId: '101', channelId: '10',
    outcome: { item: { id: 'hourglass_of_haste', maxCharges: 1 } }, now: f.time.now() });
  f.reopen(true); const before = rows(f.db);
  assert.ok(codes(f).includes('vault_reconciliation_required'));
  assert.throws(() => assertCatalogRuntimeRestartReady(f.db), /vault_reconciliation_required/);
  assert.deepEqual(rows(f.db), before);
});

test('ordinary published escape also loses its timer on startup, without changing ownership or returning its roll cost', async t => {
  const f = fixture(t); const marriage = marry(f, 0);
  await runRoll({ message: f.message(), yoshiko: { catalogDb: f.db, mysteryEnabled: false,
    imagePicker: { pick: async () => ({}) } } }, 'w', () => 0.5, f.time);
  assert.ok(f.time.pending());
  const remaining = getRollStatus(f.db, '1', '101', f.time.now()).remaining;
  f.reopen(); assert.deepEqual(codes(f), ['escape_runtime_missing']);
  recoverRollRuntime(f.db); await heart(f, f.sent[0], '303');
  assert.equal(f.db.prepare('SELECT owner_id FROM marriages WHERE id=?').get(marriage.marriageId).owner_id, '202');
  assert.equal(f.db.prepare('SELECT escape_outcome FROM character_rolls').get().escape_outcome, 'canceled');
  assert.equal(getRollStatus(f.db, '1', '101', f.time.now()).remaining, remaining);
  assert.equal(f.sent[0].edits.length, 0);
});

test('trade awaiting confirmation is memory-only: new runtime ignores yes and preserves exact ownership UUIDs', async t => {
  const f = fixture(t, 2); marry(f, 0, '101'); marry(f, 1);
  t.mock.method(globalThis, 'setTimeout', f.time.setTimer);
  t.mock.method(globalThis, 'clearTimeout', f.time.clearTimer);
  const oldDb = f.db;
  await startTrade({ yoshiko: { catalogDb: oldDb }, message: f.message(), args: ['trade', '202'] });
  assert.equal(await onTradeAnswer(oldDb, f.message('101', '101', 'Original 1')), true);
  assert.equal(await onTradeAnswer(oldDb, f.message('102', '202', 'Original 2')), true);
  const before = rows(oldDb); f.reopen();
  assert.equal(await onTradeAnswer(f.db, f.message('103', '202', 'yes')), false);
  assert.deepEqual(rows(f.db), before);
  assert.equal(assertCatalogRuntimeRestartReady(f.db).ready, true); // Cannot detect the lost conversation.
  assert.match(inspectCatalogRuntimeRestart(f.db).limitations[0], /memory-only/);
  // Dispose the old test-process-only session; not startup recovery on the new DB.
  await cancelTransfer({ yoshiko: { catalogDb: oldDb }, message: f.message() });
});
