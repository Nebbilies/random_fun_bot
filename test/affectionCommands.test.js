import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureAppearanceInTransaction, completeAppearanceInTransaction, getAffectionDetail } from '../lib/characterAffection.js';
import { transaction } from '../lib/catalogDb.js';
import { createFinalCatalog } from '../lib/catalogDb.js';
import { loadCharacterIndex } from '../lib/gameCharacterLookup.js';
import { run } from '../commands/affection.js';

const ids = Array.from({ length: 7 }, (_, i) => `${String(i + 1).repeat(8)}-1111-4111-8111-111111111111`);
/** @returns {any} */
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'affection-command-'));
  const db = createFinalCatalog(join(dir, 'synthetic.sqlite'));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  ids.forEach((id, i) => {
    const name = i < 2 ? `Shared ${i}` : `Character ${i}`;
    db.prepare("INSERT INTO character_identities(id,name_full,creation_method) VALUES(?,?,'manual')").run(id, name);
    db.prepare("INSERT INTO characters(id,rank,favourites,tie_order,likes_source,name_full) VALUES(?,?,0,?,'generated',?)").run(id, i + 1, i + 1, name);
    db.prepare("INSERT INTO marriages(guild_id,character_id,owner_id,married_at) VALUES('1',?,'101','date')").run(id);
  });
  return db;
}
function transport(db, args) {
  const collector = Object.assign(new EventEmitter(), { stop: () => collector.emit('end') });
  let payload;
  const reply = { id: '900', edit: async value => { payload = value; return reply; }, createMessageComponentCollector: () => collector };
  const ctx = { args, prefix: '?', yoshiko: { catalogDb: db, characterIndex: loadCharacterIndex(db) },
    message: { id: '100', guildId: '1', channelId: '10', author: { id: '101', username: 'Neb' },
      reply: async value => { payload = value; return reply; } } };
  return { ctx, collector, payload: () => payload, reply };
}
function text(value) { return JSON.stringify(value); }
async function click(mock, customId, extras = {}) {
  const errors = [];
  const interaction = { customId, user: { id: '101' }, guildId: '1', channelId: '10', message: { id: '900' },
    deferUpdate: async () => {}, followUp: async value => errors.push(value), reply: async value => errors.push(value), ...extras };
  const listeners = mock.collector.listeners('collect');
  for (const listener of listeners) await listener(interaction);
  return errors;
}

test('own overview includes zero progress, bounded pages and dynamic-prefix detail hint', async t => {
  const db = fixture(t), mock = transport(db, ['aff']);
  await run(mock.ctx);
  assert.match(text(mock.payload()), /Page 1 of 2 · 7 owned · \?aff/);
  assert.equal(mock.payload().embeds[0].toJSON().fields.filter(row => /♥ 0/.test(row.name)).length, 5);
  const before = db.prepare('SELECT total_changes() n').get().n;
  await click(mock, 'affection:next');
  assert.match(text(mock.payload()), /Page 2 of 2/);
  assert.equal(db.prepare('SELECT total_changes() n').get().n, before);
});

test('trailing player mention is removed before rank lookup; public views remain pure', async t => {
  const db = fixture(t), mock = transport(db, ['affection', '#1', '<@202>']);
  mock.ctx.message.mentions = { users: new Map([['202', { username: 'Other' }]]) };
  const before = db.prepare('SELECT total_changes() n').get().n;
  await run(mock.ctx);
  assert.match(text(mock.payload()), /Other's affection/);
  assert.match(text(mock.payload()), /Shared 0/);
  assert.match(text(mock.payload()), /Not in your harem/);
  assert.doesNotMatch(text(mock.payload()), /to select/);
  assert.equal(db.prepare('SELECT total_changes() n').get().n, before);
});

test('ambiguity picker freezes UUID and rejects wrong actor, guild, channel and message', async t => {
  const db = fixture(t), mock = transport(db, ['aff', 'Shared']);
  await run(mock.ctx);
  assert.match(text(mock.payload()), /affection:choose/);
  for (const extras of [{ user: { id: '999' } }, { guildId: '2' }, { channelId: '20' }, { message: { id: '901' } }]) {
    const errors = await click(mock, 'affection:choose', { values: [ids[0]], ...extras });
    assert.match(text(errors), /Only the command author/);
    assert.match(text(mock.payload()), /affection:choose/);
  }
  db.prepare('UPDATE characters SET rank=50 WHERE id=?').run(ids[0]);
  await click(mock, 'affection:choose', { values: [ids[0]] });
  assert.match(text(mock.payload()), /Shared 0/);
  assert.equal(mock.payload().components.length, 0);
});

test('former filter and expired controls are read-only and disabled', async t => {
  const db = fixture(t);
  db.prepare('DELETE FROM marriages WHERE character_id=?').run(ids[0]);
  const mock = transport(db, ['affection']);
  await run(mock.ctx);
  assert.match(text(mock.payload()), /Former characters/);
  const before = db.prepare('SELECT total_changes() n').get().n;
  await click(mock, 'affection:filter');
  assert.match(text(mock.payload()), /Saved progress · inactive for benefits/);
  assert.match(text(mock.payload()), /Shared 0/);
  mock.collector.emit('end');
  await Promise.resolve();
  assert.ok(mock.payload().components[0].toJSON().components.every(button => button.disabled));
  await click(mock, 'affection:filter');
  assert.match(text(mock.payload()), /Former characters/);
  assert.equal(db.prepare('SELECT total_changes() n').get().n, before);
});

test('public views cannot select owed items; only the initial own profile retries existing delivery', async t => {
  const db = fixture(t);
  transaction(db, () => {
    captureAppearanceInTransaction(db, { sourceKey: 'appearance', guildId: '1', userId: '101', channelId: '10', characterId: ids[0], now: 100 });
    completeAppearanceInTransaction(db, { sourceKey: 'appearance', now: 101, rewardRoster: [] });
  });
  const detail = () => {
    const result = getAffectionDetail(db, { guildId: '1', userId: '101', characterId: ids[0] });
    assert.ok(result);
    return result;
  };
  assert.equal(detail().pending.filter(row => row.state === 'owed').length, 3);
  const visitor = transport(db, ['aff', '<@101>']);
  visitor.ctx.message.author = { id: '202', username: 'Other' };
  const before = db.prepare('SELECT total_changes() n').get().n;
  await run(visitor.ctx);
  assert.match(text(visitor.payload()), /3 owed/);
  assert.equal(db.prepare('SELECT total_changes() n').get().n, before);
  const own = transport(db, ['aff']);
  await run(own.ctx);
  assert.equal(detail().pending.filter(row => row.state === 'owed').length, 0);
  const after = db.prepare('SELECT total_changes() n').get().n;
  await click(own, 'affection:next');
  await click(own, 'affection:prev');
  assert.equal(db.prepare('SELECT total_changes() n').get().n, after);
  assert.equal(own.payload().components.length, 1, 'only read-only navigation, no new claim control');
});

test('unknown names get lookup guidance without retrying owed items', async t => {
  const db = fixture(t), mock = transport(db, ['aff', 'Nobody']);
  const before = db.prepare('SELECT total_changes() n').get().n;
  await run(mock.ctx);
  assert.match(text(mock.payload()), /No character found/);
  assert.equal(db.prepare('SELECT total_changes() n').get().n, before);
});
