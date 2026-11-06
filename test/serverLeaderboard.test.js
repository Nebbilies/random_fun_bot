import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { MessageFlags } from 'discord.js';
import { serverLeaderboard, resolveServerLeaderboard, totalMarriedLeaderboard } from '../lib/serverLeaderboard.js';
import { serverLeaderboardComponents } from '../lib/serverLeaderboardView.js';
import { run } from '../commands/topserv.js';
import { run as alias } from '../commands/ts.js';
import { initGameConfig, saveConfigSection } from '../lib/gameConfig.js';

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  // Text identities deliberately exercise UUID-compatible joins rather than rank-based IDs.
  db.exec(`CREATE TABLE characters (id TEXT PRIMARY KEY, rank INTEGER UNIQUE);
    CREATE TABLE marriages (guild_id TEXT, character_id TEXT, owner_id TEXT);`);
  return db;
}
function own(db, owner, ranks, guild = '1') {
  for (const rank of ranks) {
    const id = `character-uuid-${rank}`;
    db.prepare('INSERT OR IGNORE INTO characters VALUES (?, ?)').run(id, rank);
    db.prepare('INSERT INTO marriages VALUES (?, ?, ?)').run(guild, id, owner);
  }
}
const ten = (start) => Array.from({ length: 10 }, (_, i) => start + i);
const member = (id) => ({ user: { username: `user_${id}`, displayAvatarURL: () => `https://cdn.discordapp.com/avatars/${id}/avatar.png` } });
const fetchMembers = async ({ user }) => new Map(user.filter(id => id !== 'gone').map(id => [id, member(id)]));

test('scores use ten smallest current ranks, exclude short harems, and isolate guilds', (t) => {
  const db = fixture(t);
  own(db, 'a', [...ten(1), 100]);
  own(db, 'b', ten(11));
  own(db, 'short', ten(21).slice(0, 9));
  own(db, 'elsewhere', ten(1), '2');
  db.prepare('INSERT INTO marriages VALUES (?, ?, ?)').run('1', 'identity-only', 'short');
  assert.deepEqual(serverLeaderboard(db, '1').map(({ ownerId, score }) => [ownerId, score]), [['a', 55], ['b', 155]]);
  db.prepare('UPDATE characters SET rank = 101 WHERE rank = 1').run();
  assert.equal(serverLeaderboard(db, '1')[0].score, 154);
});

test('equal sums compare best ranks lexicographically', (t) => {
  const db = fixture(t);
  own(db, 'best', [1, 4, 10, 13, 16, 19, 22, 25, 28, 31]);
  own(db, 'other', [2, 3, 11, 12, 17, 18, 23, 24, 29, 30]);
  const rows = serverLeaderboard(db, '1');
  assert.equal(rows[0].score, rows[1].score);
  assert.equal(rows[0].ownerId, 'best');
});

test('total married counts all current ownership per server and orders ties by owner ID', (t) => {
  const db = fixture(t);
  assert.deepEqual(totalMarriedLeaderboard(db, '1'), []);
  own(db, 'most', [1, 2]);
  own(db, '2', [3, 4]);
  own(db, '10', [5, 6]);
  own(db, 'single', [0]);
  own(db, 'elsewhere', ten(20), '2');
  db.prepare('INSERT INTO marriages VALUES (?, ?, ?)').run('1', 'identity-only', 'most');
  const totals = () => totalMarriedLeaderboard(db, '1').map(({ ownerId, score }) => [ownerId, score]);
  assert.deepEqual(totals(), [['most', 3], ['10', 2], ['2', 2], ['single', 1]]);

  db.prepare('UPDATE marriages SET owner_id = ? WHERE guild_id = ? AND character_id = ?')
    .run('single', '1', 'identity-only');
  assert.deepEqual(totals(), [['10', 2], ['2', 2], ['most', 2], ['single', 2]]);
  db.prepare('DELETE FROM marriages WHERE guild_id = ? AND owner_id = ?').run('1', 'most');
  assert.deepEqual(totals(), [['10', 2], ['2', 2], ['single', 2]]);
});

test('membership excludes departed users but propagates lookup failures', async () => {
  const guild = { members: { fetch: fetchMembers } };
  const rows = await resolveServerLeaderboard(guild, [{ ownerId: 'gone' }, { ownerId: 'present' }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].username, 'user_present');
  await assert.rejects(resolveServerLeaderboard({ members: { fetch: async () => { throw new Error('network'); } } }, [{ ownerId: 'a' }]), { code: 'LEADERBOARD_MEMBERS_UNAVAILABLE' });
});

test('view has ten rows, sequential positions, escaped usernames and overall leader avatar', () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ username: `user_${i}`, score: i + 55, avatarUrl: `https://example.com/${i}.png` }));
  const first = serverLeaderboardComponents(rows)[0].toJSON();
  assert.equal(first.components[0].components[0].content, '## 🏆 SERVER TOP 10');
  assert.equal(first.components[0].components[1].content, 'Sum of the top 10 lowest ranked characters');
  assert.equal(first.components[2].content, 'Page 1 of 2');
  assert.equal(first.components[1].content.split('\n').length, 10);
  const second = serverLeaderboardComponents(rows, 1, true)[0].toJSON();
  assert.equal(second.components[0].accessory.media.url, rows[0].avatarUrl);
  assert.equal(second.components[1].content.split('\n').length, 2);
  assert.match(second.components[1].content, /^\*\*11\. user\\_10\*\*\u00a0-\u00a065/);
  assert.ok(second.components[3].components.every((button) => button.disabled));
  assert.match(serverLeaderboardComponents([])[0].toJSON().components[2].content, /No eligible members/);
});

test('total married view shows ownership counts, its title and empty state across pages', () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({
    username: `user_${i}`, score: 12 - i, avatarUrl: `https://example.com/${i}.png`,
  }));
  const options = { totalMarried: true };
  const first = serverLeaderboardComponents(rows, 0, false, options)[0].toJSON();
  assert.equal(first.components[0].components[0].content, '## TOTAL MARRIED');
  assert.equal(first.components[0].components[1].content, 'Total currently married characters');
  assert.equal(first.components[1].content.split('\n').length, 10);
  assert.match(first.components[1].content, /^\*\*1\. user\\_0\*\*\u00a0-\u00a012\n/);
  const second = serverLeaderboardComponents(rows, 1, true, options)[0].toJSON();
  assert.equal(second.components[0].accessory.media.url, rows[0].avatarUrl);
  assert.equal(second.components[1].content,
    '**11. user\\_10**\u00a0-\u00a02\n**12. user\\_11**\u00a0-\u00a01');
  assert.equal(second.components[2].content, 'Page 2 of 2');
  assert.ok(second.components[3].components.every((button) => button.disabled));
  const empty = serverLeaderboardComponents([], 0, false, options)[0].toJSON();
  assert.equal(empty.components[0].content, '## TOTAL MARRIED');
  assert.equal(empty.components[2].content, 'No eligible members. Own at least one character to appear.');
});

test('command alias, initial pages, invoker-only navigation and expiration', async (t) => {
  assert.equal(alias, run);
  const db = fixture(t);
  for (let i = 0; i < 12; i += 1) own(db, String(i), ten(i * 10 + 1));
  const collector = new EventEmitter();
  let payload;
  const sent = { edit: async (value) => { payload = value; }, createMessageComponentCollector: () => collector };
  await run({ args: ['ts', '999'], yoshiko: { catalogDb: db }, message: {
    guildId: '1', author: { id: 'invoker' }, guild: { members: { fetch: fetchMembers } },
    reply: async (value) => { payload = value; return sent; },
  } });
  assert.equal(payload.flags, MessageFlags.IsComponentsV2);
  assert.deepEqual(payload.allowedMentions, { parse: [], repliedUser: false });
  const card = () => payload.components[0].toJSON();
  assert.match(card().components[2].content, /Page 2 of 2/);
  let rejection;
  const collect = collector.listeners('collect')[0];
  await collect({ customId: 'topserv:prev', user: { id: 'other' }, reply: async (value) => { rejection = value; } });
  assert.equal(rejection.flags, MessageFlags.Ephemeral);
  assert.match(card().components[2].content, /Page 2 of 2/);
  await collect({ customId: 'topserv:prev', user: { id: 'invoker' }, deferUpdate: async () => {} });
  assert.match(card().components[2].content, /Page 1 of 2/);
  collector.emit('end');
  assert.ok(card().components[3].components.every((button) => button.disabled));
});

test('tsl captures current member totals for author-only pagination until expiry', async (t) => {
  const { run: totalRun } = await import('../commands/tsl.js');
  const db = fixture(t);
  for (let i = 0; i < 12; i += 1) own(db, String(i), [i + 1]);
  own(db, 'gone', [100, 101]);
  initGameConfig(db);
  saveConfigSection(db, { guildId: '1', section: 'controls',
    values: { 'controls.lifetimeMs': 1234 }, expectedRevision: 0 });
  const collector = new EventEmitter();
  let payload;
  let collectorOptions;
  const sent = {
    edit: async (value) => { payload = value; },
    createMessageComponentCollector: (options) => { collectorOptions = options; return collector; },
  };
  const ctx = { args: ['tsl', '999'], yoshiko: { catalogDb: db }, message: {
    guildId: '1', author: { id: 'invoker' }, guild: { members: { fetch: fetchMembers } }, reply: async (value) => { payload = value; return sent; },
  } };
  await totalRun(ctx);
  const card = () => payload.components[0].toJSON();
  assert.equal(payload.flags, MessageFlags.IsComponentsV2);
  assert.deepEqual(payload.allowedMentions, { parse: [], repliedUser: false });
  assert.equal(collectorOptions.time, 1234);
  assert.equal(card().components[0].components[0].content, '## TOTAL MARRIED');
  assert.equal(card().components[0].accessory.media.url, member('0').user.displayAvatarURL());
  assert.equal(card().components[1].content,
    '**11. user\\_8**\u00a0-\u00a01\n**12. user\\_9**\u00a0-\u00a01');
  assert.equal(card().components[2].content, 'Page 2 of 2');

  const collect = collector.listeners('collect')[0];
  let rejection;
  await collect({ customId: 'topserv:prev', user: { id: 'other' },
    reply: async (value) => { rejection = value; } });
  assert.equal(rejection.flags, MessageFlags.Ephemeral);
  assert.equal(card().components[2].content, 'Page 2 of 2');

  db.prepare('DELETE FROM marriages WHERE guild_id = ? AND owner_id = ?').run('1', '0');
  await collect({ customId: 'topserv:prev', user: { id: 'invoker' }, deferUpdate: async () => {} });
  assert.equal(card().components[2].content, 'Page 1 of 2');
  assert.match(card().components[1].content, /^\*\*1\. user\\_0\*\*\u00a0-\u00a01\n/);
  assert.doesNotMatch(card().components[1].content, /gone/);
  collector.emit('end');
  assert.ok(card().components[3].components.every((button) => button.disabled));
  await collect({ customId: 'topserv:next', user: { id: 'invoker' }, deferUpdate: async () => {} });
  assert.equal(card().components[2].content, 'Page 1 of 2');

  ctx.args = ['tsl'];
  ctx.message.reply = async (value) => { payload = value; };
  await totalRun(ctx);
  assert.equal(card().components[0].accessory.media.url, member('1').user.displayAvatarURL());
  assert.match(card().components[1].content, /^\*\*1\. user\\_1\*\*\u00a0-\u00a01\n/);
  assert.doesNotMatch(card().components[1].content, /user\\_0\*\*/);
});

test('tsl defaults invalid pages to the first page and handles empty ownership', async (t) => {
  const { run: totalRun } = await import('../commands/tsl.js');
  const db = fixture(t);
  for (let i = 0; i < 11; i += 1) own(db, String(i), [i + 1]);
  let payload;
  const ctx = { args: ['tsl'], yoshiko: { catalogDb: db }, message: {
    guildId: '1', author: { id: 'invoker' }, guild: { members: { fetch: fetchMembers } },
    reply: async (value) => { payload = value; },
  } };
  for (const page of [undefined, '0', '-1', '1.5', 'invalid', '9007199254740992']) {
    ctx.args = ['tsl', page];
    await totalRun(ctx);
    assert.equal(payload.components[0].toJSON().components[2].content, 'Page 1 of 2');
  }
  db.exec('DELETE FROM marriages');
  await totalRun(ctx);
  const card = payload.components[0].toJSON();
  assert.equal(card.components[2].content, 'No eligible members. Own at least one character to appear.');
  assert.equal(card.components[3].content, 'Page 1 of 1');
  assert.equal(card.components.length, 4);
});

test('tsl reports membership lookup errors instead of displaying incomplete totals', async (t) => {
  const { run: totalRun } = await import('../commands/tsl.js');
  const db = fixture(t);
  own(db, 'present', [1]);
  let payload;
  await totalRun({ args: ['tsl'], yoshiko: { catalogDb: db }, message: {
    guildId: '1', guild: { members: { fetch: async () => { throw new Error('network'); } } },
    reply: async value => { payload = value; },
  } });
  assert.match(payload.content, /try again/i);
  assert.equal(payload.components, undefined);
});
