import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { resolveServerLeaderboard } from '../lib/serverLeaderboard.js';
import { run } from '../commands/topserv.js';
import { DatabaseSync } from 'node:sqlite';

const member = id => ({ user: { username: 'Player ' + id, displayAvatarURL: () => 'https://example.com/' + id + '.png' } });
test('bulk membership preserves ranking, deduplicates requests and refreshes every invocation', async () => {
  const requests = [];
  let left = false;
  const guild = { members: { fetch: async options => {
    requests.push(options);
    return new Map(options.user.filter(id => id !== 'gone' && !(left && id === 'b')).reverse().map(id => [id, member(id)]));
  } } };
  const rows = [{ ownerId: 'b', score: 1 }, { ownerId: 'gone', score: 2 }, { ownerId: 'a', score: 3 }, { ownerId: 'b', score: 4 }];
  assert.deepEqual((await resolveServerLeaderboard(guild, rows)).map(row => [row.ownerId, row.score]), [['b', 1], ['a', 3], ['b', 4]]);
  assert.deepEqual(requests[0].user, ['b', 'gone', 'a']);
  assert.equal(requests[0].withPresences, false);
  assert.ok(requests[0].time > 0 && requests[0].time <= 5000);
  left = true;
  assert.deepEqual((await resolveServerLeaderboard(guild, rows)).map(row => row.ownerId), ['a']);
  assert.equal(requests.length, 2);
});
test('empty ownership does not send a member request', async () => {
  assert.deepEqual(await resolveServerLeaderboard({ members: { fetch: () => { throw Error('unexpected'); } } }, []), []);
});
test('batches contain at most 100 IDs and a later failure never returns partial rankings', async () => {
  const sizes = [];
  const rows = Array.from({ length: 201 }, (_, i) => ({ ownerId: String(i) }));
  const guild = { members: { fetch: async ({ user }) => {
    sizes.push(user.length);return new Map(user.map(id => [id, member(id)]));
  } } };
  assert.equal((await resolveServerLeaderboard(guild, rows)).length, 201);
  assert.deepEqual(sizes, [100, 100, 1]);
  let calls = 0;
  guild.members.fetch = async ({ user }) => { if (++calls === 2) throw Error('rate limited');return new Map(user.map(id => [id, member(id)])); };
  await assert.rejects(resolveServerLeaderboard(guild, rows), { code: 'LEADERBOARD_MEMBERS_UNAVAILABLE' });
});
test('five-second budget applies across batches rather than restarting for each request', async t => {
  let clock = 0, calls = 0;
  t.mock.method(performance, 'now', () => clock);
  const guild = { members: { fetch: async ({ user, time }) => {
    calls++;
    if (calls === 2) assert.ok(time <= 500);
    clock += calls === 1 ? 4500 : 600;
    return new Map(user.map(id => [id, member(id)]));
  } } };
  await assert.rejects(resolveServerLeaderboard(guild, Array.from({ length: 201 }, (_, i) => ({ ownerId: String(i) }))), { code: 'LEADERBOARD_MEMBERS_UNAVAILABLE' });
  assert.equal(calls, 2);
});
test('a stalled lookup times out and the command sends a retryable response', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const db = new DatabaseSync(':memory:');t.after(() => db.close());
  db.exec("CREATE TABLE marriages(guild_id TEXT,owner_id TEXT); INSERT INTO marriages VALUES('1','a')");
  let payload;
  const task = run({ args: ['tsl'], yoshiko: { catalogDb: db }, message: { guildId: '1',author: { id: 'a' },
    guild: { members: { fetch: () => new Promise(() => {}) } }, reply: async value => { payload = value; } } });
  t.mock.timers.tick(5001);
  await task;
  assert.match(payload.content, /try again/i);
  assert.equal(payload.components, undefined);
});
