import test from 'node:test';
import assert from 'node:assert/strict';
import { generateInsertionLikes, previewRankInsertion, insertAtRank } from '../lib/catalogRanking.js';

const rows = (...values) => values.map((favourites, index) => ({ id: `character-${index}`, favourites }));

test('generated likes use the rounded-down midpoint without overflow', () => {
  assert.equal(generateInsertionLikes(5100, 5000), 5050);
  assert.equal(generateInsertionLikes(101, 100), 100);
  assert.equal(generateInsertionLikes(100, 100), 100);
  assert.equal(generateInsertionLikes(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER - 2), Number.MAX_SAFE_INTEGER - 1);
});

test('generated likes handle boundaries and reject unsafe counts', () => {
  assert.equal(generateInsertionLikes(), 0);
  assert.equal(generateInsertionLikes(null, 100), 101);
  assert.equal(generateInsertionLikes(100, null), 99);
  assert.equal(generateInsertionLikes(0, null), 0);
  assert.throws(() => generateInsertionLikes(null, Number.MAX_SAFE_INTEGER), /overflow/);
  for (const invalid of [-1, 1.5, NaN, Infinity, '100', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => generateInsertionLikes(invalid, null), /safe integers/);
    assert.throws(() => generateInsertionLikes(null, invalid), /safe integers/);
  }
  assert.throws(() => generateInsertionLikes(10, 11), /descending/);
});

test('preview computes neighbors after excluding moved character', () => {
  const catalog = rows(500, 400, 300, 200);
  assert.deepEqual(previewRankInsertion(catalog, 3, 'character-0'), {
    rank: 3, favourites: 250, upperId: 'character-2', lowerId: 'character-3',
  });
  assert.deepEqual(previewRankInsertion(catalog, 2, 'character-3'), {
    rank: 2, favourites: 450, upperId: 'character-0', lowerId: 'character-1',
  });
  assert.equal(previewRankInsertion(rows(50), 1, 'character-0').favourites, 0);
  assert.equal(previewRankInsertion([], 1).favourites, 0);
});

test('equal-count insertion preserves exact position and existing relative order', () => {
  const original = rows(100, 100, 100);
  const next = insertAtRank(original, { id: 'new-uuid', rank: 2 });
  assert.deepEqual(next.map((row) => row.id), ['character-0', 'new-uuid', 'character-1', 'character-2']);
  assert.deepEqual(next.map((row) => row.favourites), [100, 100, 100, 100]);
  assert.deepEqual(next.map((row) => row.tieOrder), [1, 2, 3, 4]);
  assert.deepEqual(original, rows(100, 100, 100));
});

test('repeated insertion exhausts a gap safely with deterministic ties', () => {
  let catalog = rows(102, 100);
  for (let i = 0; i < 12; i++) {
    const id = `new-${i}`;
    catalog = insertAtRank(catalog, { id, rank: 2 });
    assert.equal(catalog[1].id, id);
    assert.ok(catalog.every((row, index) => index === 0 || catalog[index - 1].favourites >= row.favourites));
  }
  assert.equal(catalog[0].favourites, 102);
  assert.equal(catalog.at(-1).favourites, 100);
});

test('invalid previews reject malformed catalogs and out-of-range ranks', () => {
  for (const rank of [0, -1, 1.5, 3, NaN]) assert.throws(() => previewRankInsertion(rows(100), rank), /rank/);
  assert.throws(() => previewRankInsertion(rows(100), 1, 'missing'), /not in/);
  assert.throws(() => previewRankInsertion(rows(10, 20), 1), /descending/);
  assert.throws(() => previewRankInsertion([{ id: 'same', favourites: 2 }, { id: 'same', favourites: 1 }], 1), /unique/);
});
