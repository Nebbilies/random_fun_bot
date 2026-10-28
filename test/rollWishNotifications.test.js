import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFinalCatalog } from '../lib/catalogDb.js';
import { addWish, findWishMatchers } from '../lib/characterWishlist.js';
import { runRoll, recoverOpenEscapes } from '../lib/characterRollRuntime.js';
import { reserveRoll } from '../lib/characterRolls.js';
import { marryCharacter } from '../lib/characterMarriage.js';
import { recoverPendingRollDeliveries } from '../lib/rollDelivery.js';

const id = '12345678-1234-4123-8123-123456789abc';
const now = 1_800_000_000_000;
function fixture(t, method = 'manual', escape = false) {
  const dir = mkdtempSync(join(tmpdir(), 'roll-wish-'));
  const db = createFinalCatalog(join(dir, 'catalog.sqlite'));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  db.prepare('INSERT INTO character_identities(id,creation_method) VALUES (?,?)').run(id, method);
  if (method === 'imported') db.prepare("INSERT INTO character_sources(source,external_id,character_id) VALUES ('anilist','123',?)").run(id);
  db.prepare(`INSERT INTO characters(id,rank,favourites,tie_order,likes_source,name_full,gender,image_url)
    VALUES (?,1,2000,1,?,'nam','Male','https://example.test/nam.png')`)
    .run(id, method === 'manual' ? 'generated' : 'anilist');
  for (const [guildId, userId, time] of [['1', '102', 20], ['1', '101', 10], ['2', '103', 30]]) {
    assert.equal(addWish(db, { guildId, userId, characterId: id, now: time }).status, 'added');
  }
  if (escape) marryCharacter(db, '1', id, '999');
  const sent = [], edited = [];
  const card = { id: '500', guildId: '1', channelId: '10', react: async () => {},
    edit: async payload => { edited.push(payload); } };
  const channel = { id: '10', guildId: '1', messages: { fetch: async () => card },
    send: async payload => { sent.push(payload); return card; } };
  const client = { channels: { fetch: async () => channel } };
  const message = { id: '100', guildId: '1', channelId: '10', author: { id: '101' }, channel,
    reply: async () => assert.fail('final schema must use durable delivery') };
  const yoshiko = { catalogDb: db, client, mysteryEnabled: false,
    imagePicker: { pick: async () => ({ url: 'https://example.test/nam.png' }) } };
  const clock = { now: () => now, setTimer: () => ({ unref() {} }), clearTimer: () => {} };
  return { db, sent, edited, client, message, yoshiko, clock };
}
function assertWishCard(payload, users = ['101', '102']) {
  const content = JSON.stringify(payload.components.map(c => c.toJSON()));
  assert.match(content, /⭐ <@101>, <@102>'s Wish/);
  assert.equal(payload.components.find(c => c.toJSON().type === 17).toJSON().accent_color, 0x57f287);
  assert.deepEqual(payload.allowedMentions.users, users);
  assert.deepEqual(payload.allowedMentions.parse, []);
}

for (const method of ['manual', 'imported']) {
  test(`live ${method} roll pings every server wisher through durable delivery`, async t => {
    const f = fixture(t, method);
    assert.deepEqual(findWishMatchers(f.db, { guildId: '1', characterId: id }), ['101', '102']);
    await runRoll({ message: f.message, yoshiko: f.yoshiko }, 'h', () => 0.5, f.clock);
    assert.equal(f.sent.length, 1);
    assertWishCard(f.sent[0]);
  });
}

test('pending manual roll recovery pings wishers once and does not resend bound cards', async t => {
  const f = fixture(t);
  assert.equal(reserveRoll(f.db, { guildId: '1', channelId: '10', commandMessageId: '100',
    userId: '101', pool: 'h', random: () => 0, now }).status, 'reserved');
  assert.equal((await recoverPendingRollDeliveries(f.db, f.client, f.clock))[0].status, 'published');
  assert.equal(f.sent.length, 1);
  assertWishCard(f.sent[0]);
  await recoverPendingRollDeliveries(f.db, f.client, f.clock);
  assert.equal(f.sent.length, 1);
});

test('manual escape roll pings owner and every server wisher', async t => {
  const f = fixture(t, 'manual', true);
  await runRoll({ message: f.message, yoshiko: f.yoshiko }, 'h', () => 0.5, f.clock);
  assertWishCard(f.sent[0], ['999', '101', '102']);
});

test('recovered manual escape preserves the wish line without re-pinging', async t => {
  const f = fixture(t, 'manual', true);
  reserveRoll(f.db, { guildId: '1', channelId: '10', commandMessageId: '100',
    userId: '101', pool: 'h', random: () => 0, now });
  await recoverPendingRollDeliveries(f.db, f.client, f.clock);
  await recoverOpenEscapes(f.db, f.client, f.clock);
  assert.equal(f.edited.length, 1);
  assertWishCard(f.edited[0], []);
});
