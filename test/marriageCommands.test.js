import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { escapeMarkdown, PermissionFlagsBits } from 'discord.js';
import { openCatalog } from '../lib/catalogDb.js';
import { divorceCharacter, getMarriage, marryCharacter } from '../lib/characterMarriage.js';
import { run as divorce } from '../commands/divorce.js';
import { run as mm } from '../commands/mm.js';
import { run as mymarry } from '../commands/mymarry.js';
import { run as mmr } from '../commands/mmr.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'marriage-commands-'));
  const db = openCatalog(join(directory, 'catalog.sqlite'));
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  db.prepare(`INSERT INTO characters (id, rank, favourites, name_full) VALUES
    (11, 1, 100, 'Eleven'), (12, 2, 90, 'Twelve'),
    (13, 3, 80, 'Shared'), (14, 4, 70, 'Shared')`).run();
  return db;
}

function context(db, args, { authorId = '101', admin = false } = {}) {
  const collector = Object.assign(new EventEmitter(), { stop: () => {} });
  collector.stop = () => collector.emit('end');
  let payload;
  const sent = {
    edit: async (value) => { payload = value; },
    createMessageComponentCollector: () => collector,
  };
  const ctx = {
    args, prefix: '!', yoshiko: { catalogDb: db },
    message: {
      guildId: '1', author: { id: authorId },
      member: { permissions: { has: (permission) => admin && permission === PermissionFlagsBits.Administrator } },
      reply: async (value) => { payload = value; return sent; },
    },
  };
  return { ctx, collector, payload: () => payload };
}

function content(payload) {
  return payload.components?.[0]?.toJSON().components
    .flatMap((component) => component.components ?? [component])
    .filter((component) => typeof component.content === 'string')
    .map((component) => component.content).join('\n') ?? String(payload);
}

test('mm and mymarry show newest marriages first; mmr uses current rank', async (t) => {
  const db = fixture(t);
  db.prepare("UPDATE characters SET image_url = 'https://example.com/top.png' WHERE id = 11").run();
  marryCharacter(db, '1', 11, '101');
  marryCharacter(db, '1', 12, '101');
  db.prepare('UPDATE characters SET rank = 1234 WHERE id = 12').run();
  db.prepare("UPDATE marriages SET married_at = '2026-01-01T00:00:00.000Z' WHERE character_id = 11").run();
  db.prepare("UPDATE marriages SET married_at = '2026-01-02T00:00:00.000Z' WHERE character_id = 12").run();
  /** @type {Array<[(ctx: any) => Promise<void>, string, RegExp]>} */
  const cases = [[mm, 'mm', /Twelve[\s\S]*Eleven/],
    [mymarry, 'mymarry', /Twelve[\s\S]*Eleven/],
    [mmr, 'mmr', /\*\*#1\*\* - Eleven[\s\S]*\*\*#1,234\*\* - Twelve/]];
  for (const [run, name, expected] of cases) {
    const mock = context(db, [name]);
    await run(mock.ctx);
    assert.match(content(mock.payload()), expected);
    assert.match(content(mock.payload()), /Eleven 💞/);
    assert.match(content(mock.payload()), /Twelve 💞/);
    assert.match(content(mock.payload()), /<@101>'s harem/);
    assert.equal(mock.payload().components[0].toJSON().components[0].accessory.media.url,
      'https://example.com/top.png');
  }
});

test('owner confirms divorce; another user cannot use that confirmation', async (t) => {
  const db = fixture(t);
  db.prepare('UPDATE characters SET rank = 1234 WHERE id = 11').run();
  marryCharacter(db, '1', 11, '101');
  const mock = context(db, ['divorce', 'Eleven']);
  await divorce(mock.ctx);
  assert.match(content(mock.payload()), /Divorce \*\*Eleven\*\*/i);
  assert.match(content(mock.payload()), /#1,234/);
  const replies = [];
  const act = (userId) => ({
    customId: 'divorce:confirm', user: { id: userId }, guildId: '1',
    memberPermissions: { has: () => false },
    deferUpdate: async () => {}, reply: async (value) => { replies.push(value); },
  });
  await mock.collector.listeners('collect')[0](act('102'));
  assert.equal(getMarriage(db, '1', 11)?.ownerId, '101');
  await mock.collector.listeners('collect')[0](act('101'));
  assert.equal(getMarriage(db, '1', 11), null);
  assert.match(content(mock.payload()), /Divorced \*\*Eleven\*\*/);
});

test('administrator can target another owner by mention; non-admin cannot', async (t) => {
  const db = fixture(t);
  marryCharacter(db, '1', 11, '102');
  const denied = context(db, ['divorce', '<@102>', 'Eleven']);
  await divorce(denied.ctx);
  assert.match(String(denied.payload()), /Administrator/);
  const allowed = context(db, ['divorce', '<@102>', 'Eleven'], { admin: true });
  await divorce(allowed.ctx);
  assert.match(content(allowed.payload()), /Eleven/);
  const rawId = context(db, ['divorce', '102', 'Eleven'], { admin: true });
  await divorce(rawId.ctx);
  assert.match(content(rawId.payload()), /Eleven/);
  await rawId.collector.listeners('collect')[0]({
    customId: 'divorce:confirm', user: { id: '101' }, guildId: '1',
    memberPermissions: { has: (permission) => permission === PermissionFlagsBits.Administrator },
    deferUpdate: async () => {},
  });
  assert.equal(getMarriage(db, '1', 11), null);
});

test('administrator permission is rechecked on confirmation', async (t) => {
  const db = fixture(t);
  marryCharacter(db, '1', 11, '102');
  const mock = context(db, ['divorce', '102', 'Eleven'], { admin: true });
  await divorce(mock.ctx);
  await mock.collector.listeners('collect')[0]({
    customId: 'divorce:confirm', user: { id: '101' }, guildId: '1',
    memberPermissions: { has: () => false }, deferUpdate: async () => {},
  });
  assert.equal(getMarriage(db, '1', 11)?.ownerId, '102');
});

test('any member can view another member’s marriages by mention or raw ID', async (t) => {
  const db = fixture(t);
  marryCharacter(db, '1', 11, '102');
  const mockMention = context(db, ['mm', '<@102>']);
  await mm(mockMention.ctx);
  assert.match(content(mockMention.payload()), /Eleven/);
  assert.match(content(mockMention.payload()), /<@102>'s harem/);

  const mockRawId = context(db, ['mmr', '102']);
  await mmr(mockRawId.ctx);
  assert.match(content(mockRawId.payload()), /Eleven/);
  assert.match(content(mockRawId.payload()), /<@102>'s harem/);

  const mockInvalid = context(db, ['mm', 'invalid_token']);
  await mm(mockInvalid.ctx);
  assert.equal(mockInvalid.payload(), 'Usage: !mm [@user]');

  const mockTooMany = context(db, ['mmr', '<@102>', 'extra']);
  await mmr(mockTooMany.ctx);
  assert.equal(mockTooMany.payload(), 'Usage: !mmr [@user]');
});

test('long marriage lists have working pages', async (t) => {
  const db = fixture(t);
  const insert = db.prepare('INSERT INTO characters (id, rank, favourites, name_full) VALUES (?, ?, ?, ?)');
  for (let id = 15; id <= 35; id++) insert.run(id, id - 10, 100 - id, `Character ${id}`);
  for (let id = 11; id <= 35; id++) marryCharacter(db, '1', id, '101');
  const mock = context(db, ['mmr']);
  await mmr(mock.ctx);
  assert.match(content(mock.payload()), /Page 1 of 2/);
  await mock.collector.listeners('collect')[0]({
    customId: 'mm:next', user: { id: '101' }, guildId: '1', deferUpdate: async () => {},
  });
  assert.match(content(mock.payload()), /Page 2 of 2/);
  assert.match(content(mock.payload()), /Character 35/);
});

for (const command of ['mm', 'mmr', 'mma', 'mmar']) {
  test(`${command} refreshes ownership markers on stale pages in the current guild`, async (t) => {
    const db = fixture(t);
    const insert = db.prepare('INSERT INTO characters (id, rank, favourites, name_full) VALUES (?, ?, ?, ?)');
    for (let id = 15; id <= 35; id++) insert.run(id, id - 10, 100 - id, `Character *${id}*`);
    for (let id = 11; id <= 35; id++) marryCharacter(db, '1', id, '101');
    // Keep time and rank ordering identical for all four command variants.
    for (let id = 11; id <= 35; id++) {
      db.prepare('UPDATE marriages SET married_at = ? WHERE character_id = ?')
        .run(`2026-01-${String(36 - id).padStart(2, '0')}T00:00:00.000Z`, id);
    }
    const mock = context(db, [command]);
    await mm(mock.ctx);
    assert.match(content(mock.payload()), /Eleven 💞/);
    for (const id of [31, 32, 33]) {
      const marriage = getMarriage(db, '1', id);
      assert.ok(marriage, `Expected character ${id} to be married before divorce`);
      assert.equal(divorceCharacter(db, '1', id, '101', marriage.id), true);
    }
    marryCharacter(db, '1', 32, '102');
    marryCharacter(db, '2', 33, '101');
    const navigate = async (customId) => mock.collector.listeners('collect')[0]({
      customId, user: { id: '101' }, guildId: '1', deferUpdate: async () => {},
    });
    await navigate('mm:next');
    let lines = content(mock.payload()).split('\n');
    for (const [id, married] of [[31, false], [32, true], [33, false]]) {
      const name = escapeMarkdown(`Character *${id}*`);
      assert.ok(lines.some((line) => line.endsWith(`${name}${married ? ' 💞' : ''}`)), `live marker for ${id}`);
      if (!married) assert.ok(!content(mock.payload()).includes(`${name} 💞`));
    }
    marryCharacter(db, '1', 31, '103');
    await navigate('mm:prev');
    await navigate('mm:next');
    assert.ok(content(mock.payload()).includes(`${escapeMarkdown('Character *31*')} 💞`));
  });
}

test('ambiguous married names use a picker, and stale confirmation cannot remove a new marriage', async (t) => {
  const db = fixture(t);
  marryCharacter(db, '1', 13, '101');
  marryCharacter(db, '1', 14, '101');
  const mock = context(db, ['divorce', 'Shared']);
  await divorce(mock.ctx);
  const options = mock.payload().components[0].toJSON().components
    .flatMap((component) => component.components ?? [])
    .flatMap((component) => component.options ?? []);
  assert.equal(options.length, 2);
  await mock.collector.listeners('collect')[0]({
    customId: 'divorce:choose', values: ['13'], user: { id: '101' }, guildId: '1',
    deferUpdate: async () => {},
  });
  assert.match(content(mock.payload()), /Divorce.*Shared/i);
  const old = getMarriage(db, '1', 13);
  assert.ok(old);
  divorceCharacter(db, '1', 13, '101', old.id);
  marryCharacter(db, '1', 13, '102');
  await mock.collector.listeners('collect')[0]({
    customId: 'divorce:confirm', user: { id: '101' }, guildId: '1',
    memberPermissions: { has: () => false }, deferUpdate: async () => {},
  });
  assert.equal(getMarriage(db, '1', 13)?.ownerId, '102');
});
