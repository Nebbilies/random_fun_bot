import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveUserTarget, resolveTargetUsername } from '../lib/userTarget.js';

test('resolveUserTarget returns defaultId when token is absent', () => {
  const result = resolveUserTarget(undefined, '1001');
  assert.equal(result.targetId, '1001');
  assert.equal(result.isSelf, true);
  assert.equal(result.valid, true);
});

test('resolveUserTarget parses <@id> and <@!id> mentions correctly', () => {
  const res1 = resolveUserTarget('<@2002>', '1001');
  assert.equal(res1.targetId, '2002');
  assert.equal(res1.isSelf, false);
  assert.equal(res1.valid, true);

  const res2 = resolveUserTarget('<@!3003>', '1001');
  assert.equal(res2.targetId, '3003');
  assert.equal(res2.isSelf, false);
  assert.equal(res2.valid, true);

  const resSelf = resolveUserTarget('<@1001>', '1001');
  assert.equal(resSelf.targetId, '1001');
  assert.equal(resSelf.isSelf, true);
  assert.equal(resSelf.valid, true);
});

test('resolveUserTarget parses raw user IDs', () => {
  const result = resolveUserTarget('987654321012345678', '1001');
  assert.equal(result.targetId, '987654321012345678');
  assert.equal(result.isSelf, false);
  assert.equal(result.valid, true);
});

test('resolveUserTarget marks invalid tokens as valid: false', () => {
  const result = resolveUserTarget('not_a_user', '1001');
  assert.equal(result.valid, false);
  assert.equal(result.targetId, '1001');
});

test('resolveTargetUsername resolves author, mentions, or fallback correctly', async () => {
  const message = {
    author: { id: '1001', username: 'Alice' },
    mentions: {
      users: new Map([['2002', { id: '2002', username: 'Bob' }]]),
    },
  };

  const selfName = await resolveTargetUsername(message, '1001');
  assert.equal(selfName, 'Alice');

  const bobName = await resolveTargetUsername(message, '2002');
  assert.equal(bobName, 'Bob');

  const unknownName = await resolveTargetUsername(message, '9999');
  assert.equal(unknownName, 'User 9999');
});
