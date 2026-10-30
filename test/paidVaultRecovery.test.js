import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFinalCatalog, openCatalog } from '../lib/catalogDb.js';
import { reserveRoll, getRollStatus } from '../lib/characterRolls.js';
import { executeItemUseById } from '../commands/use.js';
import { addItemToInventory, getInventory } from '../lib/itemStorage.js';
import { getVaultSession, getVaultSessionByCommand } from '../lib/vaultSessions.js';
import { getVaultReward } from '../lib/vaultRewards.js';
import { recoverVaultSessions, onVaultInteraction } from '../lib/vaultRuntime.js';
import { setGuildRates } from '../lib/guildRates.js';

const NOW = 1_800_000_000_000;
const rollRequest = (commandMessageId = '100') => ({ guildId: '1', channelId: '10',
  commandMessageId, userId: '101', pool: 'w', now: NOW, vaultEnabled: true, random: () => 0 });

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'paid-vault-recovery-'));
  const path = join(dir, 'synthetic.sqlite');
  let db = createFinalCatalog(path);
  // No network or production/default catalog. A crash discards timers and opens
  // a new authoritative connection, never a raw SQLite schema bypass.
  t.mock.method(globalThis, 'setTimeout', () => ({ unref() {} }));
  t.mock.method(globalThis, 'clearTimeout', () => {});
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  setGuildRates(db, '1', { vaultRate: 1, prankRate: 0 }, NOW);
  const messages = new Map();
  let sent = 0;
  const channel = { id: '10', messages: { async fetch(request) {
    const id = typeof request === 'string' ? request : request.message;
    if (!messages.has(id)) throw Object.assign(Error('deleted'), { code: 10008 });
    return messages.get(id);
  } }, async send(payload) {
    const message = { id: String(500 + sent++), channelId: '10', channel, payload,
      async edit(change) { this.payload = { ...this.payload, ...change }; return this; } };
    messages.set(message.id, message); return message;
  } };
  return { get db() { return db; }, get sent() { return sent; }, channel, messages,
    client: { channels: { async fetch(id) { assert.equal(id, '10'); return channel; } } },
    reopen() { db.close(); db = openCatalog(path);
      assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1); },
  };
}
function choose(f, session, action = 'A') {
  const message = f.messages.get(getVaultSession(f.db, session.vaultId).messageId);
  return { customId: `vault:${session.vaultId}:${action}`, guildId: '1', channelId: '10',
    user: { id: '101' }, message, channel: f.channel, isButton: () => true, isStringSelectMenu: () => false,
    deferUpdate: async () => {}, reply: async () => {}, update: payload => message.edit(payload) };
}
function allowances(db) {
  return db.prepare('SELECT * FROM roll_allowances ORDER BY guild_id,user_id').all();
}
function failReservation(db) {
  // TEMP fault injection does not modify the authoritative persistent schema.
  db.exec(`CREATE TEMP TRIGGER fail_vault_reservation BEFORE INSERT ON main.vault_sessions
    BEGIN SELECT RAISE(ABORT, 'synthetic reservation failure'); END;`);
}

test('actual paid roll crashes before startVault: reopen recovers captured reservation and charges only once', async t => {
  const f = fixture(t);
  const before = getRollStatus(f.db, '1', '101', NOW).remaining;
  const result = reserveRoll(f.db, rollRequest());
  assert.equal(result.status, 'vault');
  assert.equal(result.remaining, before - 1);
  const session = getVaultSessionByCommand(f.db, '100');
  assert.ok(session);
  assert.equal(session.messageId, null);
  assert.equal(session.remaining, result.remaining);
  assert.equal(session.paidRollId, '100');
  assert.equal(session.createdAt, NOW);
  assert.ok(session.deadline > NOW);
  const paid = allowances(f.db);
  // Live configuration changes after payment must not alter the captured terms.
  setGuildRates(f.db, '1', { vaultRate: 0 }, NOW + 1);
  f.reopen();
  assert.deepEqual(getVaultSession(f.db, session.vaultId), session);
  assert.equal(f.sent, 0);
  await recoverVaultSessions(f.db, f.client, { now: () => NOW + 1000 });
  await recoverVaultSessions(f.db, f.client, { now: () => NOW + 2000 });
  assert.equal(f.sent, 1);
  const recovered = getVaultSession(f.db, session.vaultId);
  assert.equal(recovered.deadline, session.deadline);
  assert.deepEqual(recovered.captured, session.captured);
  assert.equal(f.messages.get(recovered.messageId).payload.reply.messageReference, '100');
  assert.match(JSON.stringify(f.messages.get(recovered.messageId).payload), new RegExp(`${result.remaining} rolls left`));
  assert.equal(reserveRoll(f.db, rollRequest()).status, 'duplicate');
  await onVaultInteraction(f.db, choose(f, session), { now: () => NOW + 3000, random: () => 0 });
  const reward = getVaultReward(f.db, session.vaultId);
  assert.ok(reward);
  assert.equal(getInventory(f.db, '1', '101', NOW + 3000).length, 1);
  f.reopen();
  await onVaultInteraction(f.db, choose(f, session, 'C'), { now: () => NOW + 4000,
    random: () => { throw Error('duplicate choice must not redraw'); } });
  await recoverVaultSessions(f.db, f.client, { now: () => NOW + 5000 });
  assert.deepEqual(getVaultReward(f.db, session.vaultId).original, reward.original);
  assert.equal(f.db.prepare('SELECT count(*) n FROM vault_rewards').get().n, 1);
  assert.equal(getInventory(f.db, '1', '101', NOW + 5000).length, 1);
  assert.equal(f.sent, 2, 'one source card and one distinct reward card, even after recovery');
  assert.notEqual(reward.messageId, recovered.messageId);
  assert.equal(reward.sourceMessageId, recovered.messageId);
  assert.deepEqual(allowances(f.db), paid);
});

test('Golden Hour actual use commits cost/reset/reservation together and recovery never repeats the reset', async t => {
  const f = fixture(t);
  f.db.prepare('INSERT INTO roll_allowances(guild_id,user_id,period,used) VALUES (?,?,?,?)')
    .run('1', '101', 0, 3);
  // Another guild and another user make the reset scope observable.
  f.db.prepare('INSERT INTO roll_allowances(guild_id,user_id,period,used) SELECT ?,?,period,? FROM roll_allowances LIMIT 1')
    .run('1', '202', 4);
  f.db.prepare('INSERT INTO roll_allowances(guild_id,user_id,period,used) SELECT ?,?,period,? FROM roll_allowances LIMIT 1')
    .run('2', '101', 5);
  const inventoryId = addItemToInventory(f.db, '1', '101', 'golden_hour', undefined, { now: NOW }).item.id;
  const result = executeItemUseById(f.db, '1', '101', inventoryId, [], {
    channelId: '10', commandMessageId: '100', now: NOW + 1,
  });
  assert.equal(result.success, true);
  assert.equal(result.startVault, true);
  assert.equal(result.vaultCommandMessageId, '100');
  assert.equal(getInventory(f.db, '1', '101', NOW + 1).length, 0);
  assert.deepEqual(allowances(f.db).map(r => [r.guild_id, r.user_id, r.used]),
    [['1', '101', 0], ['1', '202', 0], ['2', '101', 5]]);
  const session = getVaultSessionByCommand(f.db, '100');
  assert.equal(session.messageId, null);
  assert.equal(session.remaining, getRollStatus(f.db, '1', '101', NOW + 1).remaining);
  // Spend more rolls after the reset: recovery must not invoke Golden Hour again.
  f.db.prepare("UPDATE roll_allowances SET used=2 WHERE guild_id='1'").run();
  const paid = allowances(f.db), sent = f.sent;
  f.reopen();
  assert.deepEqual(getVaultSession(f.db, session.vaultId), session);
  await recoverVaultSessions(f.db, f.client, { now: () => NOW + 1000 });
  f.reopen();
  await recoverVaultSessions(f.db, f.client, { now: () => NOW + 2000 });
  assert.equal(f.sent, sent + 1);
  assert.deepEqual(allowances(f.db), paid);
  assert.equal(getInventory(f.db, '1', '101', NOW + 2000).length, 0);
  assert.equal(executeItemUseById(f.db, '1', '101', inventoryId, [], {
    channelId: '10', commandMessageId: '100', now: NOW + 2000,
  }).success, false);
  await onVaultInteraction(f.db, choose(f, session), { now: () => NOW + 3000, random: () => 0 });
  await onVaultInteraction(f.db, choose(f, session, 'B'), { now: () => NOW + 4000,
    random: () => { throw Error('must not redraw'); } });
  assert.equal(getInventory(f.db, '1', '101', NOW + 4000).length, 1);
  assert.deepEqual(allowances(f.db), paid);
  assert.equal(getVaultSession(f.db, session.vaultId).deadline, session.deadline);
});

test('paid roll reservation failure rolls back allowance and paid roll row', t => {
  const f = fixture(t);
  failReservation(f.db);
  assert.throws(() => reserveRoll(f.db, rollRequest()), /synthetic reservation failure/);
  assert.deepEqual(allowances(f.db), []);
  assert.equal(f.db.prepare('SELECT count(*) n FROM character_rolls').get().n, 0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM vault_sessions').get().n, 0);
});

test('Golden Hour reservation failure rolls back both spent charge and guild roll reset', t => {
  const f = fixture(t);
  f.db.prepare('INSERT INTO roll_allowances(guild_id,user_id,period,used) VALUES (?,?,?,?)').run('1', '101', 0, 4);
  const inventoryId = addItemToInventory(f.db, '1', '101', 'golden_hour', undefined, { now: NOW }).item.id;
  const before = allowances(f.db), inventory = getInventory(f.db, '1', '101', NOW);
  failReservation(f.db);
  assert.throws(() => executeItemUseById(f.db, '1', '101', inventoryId, [], {
    channelId: '10', commandMessageId: '100', now: NOW,
  }), /synthetic reservation failure/);
  assert.deepEqual(allowances(f.db), before);
  assert.deepEqual(getInventory(f.db, '1', '101', NOW), inventory);
  assert.equal(f.db.prepare('SELECT count(*) n FROM vault_sessions').get().n, 0);
});
