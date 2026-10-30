import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reserveBinocularsUse, recoverBinocularsUses } from '../lib/binocularsUse.js';
import { openCatalog } from '../lib/catalogDb.js';
import { addItemToInventory, getInventory } from '../lib/itemStorage.js';
import { getMysterySession } from '../lib/characterRolls.js';
import { reserveMysteryAwareRoll } from '../lib/mysteryCoordinator.js';
import { cancelMysteryRuntime, onMysteryButton, recoverMysteryRuntime, startMysteryRoll } from '../lib/mysteryRuntime.js';

// Same public behavior-audit seam: real catalog/runtime, fake Discord and clock.
async function fixture(t) {
  const db = openCatalog(':memory:');
  t.after(() => { cancelMysteryRuntime(db, { cancelPaidSessions: false }); db.close(); });
  db.exec(`INSERT INTO characters(id,rank,favourites,name_full,gender,anime_titles)
    VALUES(1,1,100,'Prize','Female','["Example Anime"]')`);
  let now = 1000;
  const timers = [], messages = new Map(), dms = [];
  const channel = { id: '10', messages: { fetch: async (id) => messages.get(id) },
    async send(payload) {
      const message = { id: String(messages.size + 1), payload, edit: async () => message };
      messages.set(message.id, message);
      return message;
    } };
  const client = { channels: { fetch: async () => channel }, users: { fetch: async () => ({
    send: async (payload) => { dms.push(payload); return {}; },
  }) } };
  const draws = [0, 0, 0][Symbol.iterator]();
  const reservation = reserveMysteryAwareRoll(db, { guildId: '1', channelId: '10',
    commandMessageId: '100', userId: '101', pool: 'w', now, mysteryEnabled: true,
    random: () => draws.next().value });
  assert.equal(reservation.status, 'mystery');
  const item = addItemToInventory(db, '1', '101', 'binoculars', 2, { now }).item;
  db.prepare('UPDATE user_inventory SET expires_at=? WHERE id=?').run(7000, item.id);
  const options = { db, client, now: () => now, setTimer: (fn) => { timers.push(fn); return timers.length; },
    clearTimer: () => {}, random: () => 0 };
  await startMysteryRoll({ ...options, message: { channelId: '10', channel }, reservation });
  now = 6000;
  await timers[0]();
  const prompt = [...messages.values()].find((message) => JSON.stringify(message.payload).includes(':binoculars'));
  assert.ok(prompt);
  return { db, options, dms, messages, setNow: (value) => { now = value; },
    async click() {
      let reply;
      await onMysteryButton(db, { isButton: () => true,
        customId: `mystery:${reservation.sessionId}:binoculars`, message: prompt,
        guildId: '1', channelId: '10', user: { id: '101' },
        deferReply: async () => {}, editReply: async (content) => { reply = content; } });
      return reply;
    } };
}

test('Binoculars button uses the runtime clock rather than wall time for availability', async (t) => {
  const f = await fixture(t);
  assert.match(await f.click(), /One charge was spent/);
  assert.equal(f.dms.length, 1);
  assert.equal(getInventory(f.db, '1', '101', 6000)[0].charges, 1);
});

test('interrupted DM recovery suppresses another Binoculars use in the recovered mystery', async (t) => {
  const f = await fixture(t);
  const source = getInventory(f.db, '1', '101', 6000)[0];
  assert.ok(reserveBinocularsUse(f.db, { guildId: '1', userId: '101', channelId: '10',
    inventoryId: source.id, sessionId: 1, now: 6000 }));
  cancelMysteryRuntime(f.db, { cancelPaidSessions: false });
  assert.equal(recoverBinocularsUses(f.db), 1);
  assert.equal(JSON.parse(getMysterySession(f.db, 1).stateJson).runtime.binocularsUsed, true);
  await recoverMysteryRuntime(f.options);
  assert.match(await f.click(), /no longer available/);
  assert.equal(f.dms.length, 0);
  assert.equal(getInventory(f.db, '1', '101', 6000)[0].charges, 1);
});

test('Binoculars cannot start at the exact inventory deadline', async (t) => {
  const f = await fixture(t);
  f.setNow(7000);
  assert.match(await f.click(), /no Binoculars available/i);
  assert.equal(f.dms.length, 0);
});

test('recovery recreates an unused missing offer using the runtime clock', async (t) => {
  const f = await fixture(t);
  cancelMysteryRuntime(f.db, { cancelPaidSessions: false });
  const state = JSON.parse(getMysterySession(f.db, 1).stateJson);
  f.messages.delete(state.runtime.binocularsMessageId);
  const result = await recoverMysteryRuntime(f.options);
  assert.equal(result.safe, true);
  assert.ok([...f.messages.values()].some((message) => JSON.stringify(message.payload).includes(':binoculars')));
  assert.equal(f.dms.length, 0);
});
