import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { MessageFlags } from 'discord.js';
import { serverLeaderboard, resolveServerLeaderboard } from '../lib/serverLeaderboard.js';
import { serverLeaderboardComponents } from '../lib/serverLeaderboardView.js';
import { run } from '../commands/topserv.js';
import { run as alias } from '../commands/ts.js';

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

test('membership excludes departed users but propagates lookup failures', async () => {
  const guild = { members: { fetch: async ({ user, force }) => {
    assert.equal(force, true);
    if (user === 'gone') throw Object.assign(new Error('Unknown Member'), { code: 10007 });
    return member(user);
  } } };
  const rows = await resolveServerLeaderboard(guild, [{ ownerId: 'gone' }, { ownerId: 'present' }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].username, 'user_present');
  await assert.rejects(resolveServerLeaderboard({ members: { fetch: async () => { throw new Error('network'); } } }, [{ ownerId: 'a' }]), /network/);
});

test('view has ten rows, sequential positions, escaped usernames and overall leader avatar', () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ username: `user_${i}`, score: i + 55, avatarUrl: `https://example.com/${i}.png` }));
  const first = serverLeaderboardComponents(rows)[0].toJSON();
  assert.equal(first.components[0].components[0].content, '## 🏆SERVER TOP 10');
  assert.equal(first.components[0].components[1].content, 'Sum of the top 10 lowest ranked characters');
  assert.equal(first.components[2].content, 'Page 1 of 2');
  assert.equal(first.components[1].content.split('\n').length, 10);
  const second = serverLeaderboardComponents(rows, 1, true)[0].toJSON();
  assert.equal(second.components[0].accessory.media.url, rows[0].avatarUrl);
  assert.equal(second.components[1].content.split('\n').length, 2);
  assert.match(second.components[1].content, /^\*\*11\. user\\_10\*\* - 65/);
  assert.ok(second.components[3].components.every((button) => button.disabled));
  assert.match(serverLeaderboardComponents([])[0].toJSON().components[2].content, /No eligible members/);
});

test('command alias, initial pages, invoker-only navigation and expiration', async (t) => {
  assert.equal(alias, run);
  const db = fixture(t);
  for (let i = 0; i < 12; i += 1) own(db, String(i), ten(i * 10 + 1));
  const collector = new EventEmitter();
  let payload;
  const sent = { edit: async (value) => { payload = value; }, createMessageComponentCollector: () => collector };
  await run({ args: ['ts', '999'], yoshiko: { catalogDb: db }, message: {
    guildId: '1', author: { id: 'invoker' }, guild: { members: { fetch: async ({ user }) => member(user) } },
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
