import test from 'node:test';
import assert from 'node:assert/strict';
import { formatCharacterLikes } from '../lib/characterLikes.js';

test('generated counts carry their provenance independent of creation method', () => {
  assert.equal(formatCharacterLikes({ favourites: 5050, likes_source: 'generated' }), '5,050 [generated]');
  assert.equal(formatCharacterLikes({ favourites: 0, likes_source: 'generated' }), '0 [generated]');
  assert.equal(formatCharacterLikes({ favourites: 5050, likes_source: 'anilist', creation_method: 'manual' }), '5,050');
});

test('legacy imported displays retain their original presentation', () => {
  assert.equal(formatCharacterLikes({ favourites: 5050 }), '5,050');
  assert.equal(formatCharacterLikes({}), '0');
});
