import test from 'node:test';
import assert from 'node:assert/strict';
import { createCharacterId, isCharacterId, requireCharacterId, normalizeAniListCharacterId } from '../lib/characterIdentity.js';

test('character identities are generated UUIDv4 values, not external IDs', () => {
  const first = createCharacterId();
  assert.ok(isCharacterId(first));
  assert.notEqual(first, createCharacterId());
  assert.equal(requireCharacterId(first.toUpperCase()), first);
  for (const value of [123, '123', null, '', '00000000-0000-0000-0000-000000000000']) {
    assert.equal(isCharacterId(value), false);
    assert.throws(() => requireCharacterId(value), /UUID/);
  }
});

test('AniList source keys are canonical positive decimal strings', () => {
  assert.equal(normalizeAniListCharacterId(123), '123');
  assert.equal(normalizeAniListCharacterId('123'), '123');
  for (const value of [0, -1, 1.5, '01', ' 1', '1e3', Infinity, createCharacterId(), Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => normalizeAniListCharacterId(value), /AniList/);
  }
});
