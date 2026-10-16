import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findCharacters } from '../lib/gameCharacterLookup.js';
import { createCharacterImagePicker } from '../lib/characterImages.js';

const characters = [
  { id: 1, rank: 1, name_full: 'Satoru Gojou', name_native: '五条悟', name_alternatives: '["Satoru Gojo"]', anime_titles: '["JUJUTSU KAISEN"]' },
  { id: 2, rank: 2, name_full: 'Rem', name_native: 'レム', name_alternatives: '["Maid Rem"]', anime_titles: '["Re:ZERO"]' },
  { id: 3, rank: 3, name_full: 'Remy', name_native: 'レミー', name_alternatives: '["Rem"]', anime_titles: '["Other"]' },
];

test('lookup chooses rank, then full-name exact, alias exact, prefix, and substring', () => {
  assert.deepEqual(findCharacters(characters, '#3').map((row) => row.id), [3]);
  assert.deepEqual(findCharacters([{ ...characters[0], rank: 1234 }], '#1,234').map((row) => row.id), [1]);
  assert.deepEqual(findCharacters(characters, ' SATORU   GOJOU ').map((row) => row.id), [1]);
  assert.deepEqual(findCharacters(characters, 'Satoru Gojo').map((row) => row.id), [1]);
  assert.deepEqual(findCharacters(characters, 'rem').map((row) => row.id), [2]);
  assert.deepEqual(findCharacters(characters, 'remy').map((row) => row.id), [3]);
  assert.deepEqual(findCharacters(characters, 'toru').map((row) => row.id), [1]);
  assert.deepEqual(findCharacters(characters, 'r').map((row) => row.id), []);
});

test('ambiguous matches remain ambiguous and are ordered by rank', () => {
  const rows = [
    { ...characters[1], id: 8, rank: 8, name_full: 'Sora' },
    { ...characters[1], id: 4, rank: 4, name_full: 'Sora' },
  ];
  assert.deepEqual(findCharacters(rows, 'sora').map((row) => row.rank), [4, 8]);
});

test('image picker rotates within score-ranked general-rated pool and handles small pools', async () => {
  const calls = [];
  const posts = [
    { id: 1, rating: 'g', score: 100, md5: 'one', large_file_url: 'https://cdn.donmai.us/one.jpg' },
    { id: 2, rating: 'g', score: 90, md5: 'two', large_file_url: 'https://cdn.donmai.us/two.jpg' },
    { id: 3, rating: 's', score: 999, large_file_url: 'https://cdn.donmai.us/unsafe.jpg' },
    { id: 4, rating: 'g', score: 80, md5: 'one', large_file_url: 'https://cdn.donmai.us/duplicate.jpg' },
  ];
  const picker = createCharacterImagePicker({
    fetchImpl: async (url) => { calls.push(String(url)); return { ok: true, json: async () => posts }; },
    random: () => 0,
  });
  const first = await picker.pick('guild', 1, 'tag', 'https://anilist.co/portrait.jpg');
  const second = await picker.pick('guild', 1, 'tag', 'https://anilist.co/portrait.jpg');
  assert.notEqual(first.url, second.url);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /order%3Ascore/);
  assert.equal(first.source, 'danbooru');
  assert.equal((await picker.pick('guild', 2, null, 'https://anilist.co/portrait.jpg')).source, 'anilist');
});

test('image picker reuses a single valid post and falls back when fetch fails', async () => {
  const picker = createCharacterImagePicker({
    fetchImpl: async () => ({ ok: true, json: async () => [{ id: 9, rating: 'g', score: 2, large_file_url: 'https://cdn.donmai.us/only.jpg' }] }),
  });
  const a = await picker.pick('guild', 1, 'tag', 'https://anilist.co/portrait.jpg');
  const b = await picker.pick('guild', 1, 'tag', 'https://anilist.co/portrait.jpg');
  assert.equal(a.url, b.url);
  const failed = createCharacterImagePicker({ fetchImpl: async () => ({ ok: false, status: 403 }) });
  assert.equal((await failed.pick('guild', 1, 'tag', 'https://anilist.co/portrait.jpg')).source, 'anilist');
});
