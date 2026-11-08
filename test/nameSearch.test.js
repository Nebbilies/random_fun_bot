import test from 'node:test';
import assert from 'node:assert/strict';
import { matchNames, prepareNames } from '../lib/nameSearch.js';
import { findCharacters, searchCharacters } from '../lib/gameCharacterLookup.js';
import { findFranchises } from '../lib/franchiseLookup.js';
import { matchWishes } from '../lib/characterWishlist.js';

const entry = (name, aliases = []) => prepareNames(name, aliases);
const match = (names, query) => matchNames(names.map(name => typeof name === 'string' ? entry(name) : name), query);

test('exact primary precedence and alias collisions retain distinct entities', () => {
  assert.deepEqual(match([entry('Remy', ['Rem']), 'Rem'], 'rem').indices, [1]);
  assert.deepEqual(match([entry('First', ['Same', 'Same']), entry('Second', ['Same'])], 'same').indices, [0, 1]);
  assert.deepEqual(matchNames([entry('Remy', ['Rem']), entry('Rem')], 'rem', { combinedExact: true }).indices, [0, 1]);
});

test('meaningful surname matches are not suppressed by full-name prefixes', () => {
  assert.deepEqual(match(['Gojo Example', 'Satoru Gojo', 'Gojohn', 'Notgojo'], 'gojo').indices, [0, 1, 2]);
  assert.deepEqual(match(['Satoru Gojo'], 'toru'), { indices: [0], matchType: 'substring' });
});

test('typos work in whole labels and consecutive name words, including transpositions', () => {
  for (const query of ['gojp', 'gooj', 'goju', 'satoru gojp', 'satrou gojo']) {
    const result = match(['Satoru Gojo', 'Unrelated'], query);
    assert.deepEqual(result.indices, [0], query);
    assert.equal(result.matchType, 'fuzzy', query);
  }
  assert.deepEqual(match(['Gojo', 'Goja'], 'goju').indices, [0, 1]);
});

test('weak, blank, short, numeric-changing, and missing-token queries do not expand', () => {
  for (const query of ['', '!!!', 'g', 'zzzzzzzz', 'season 3', 'gojo gojo', 'thehero', 'a2', 'satoru gojo x']) {
    assert.deepEqual(match(['Gojo', 'Season 2', 'Satoru Gojo', 'The Hero', 'A20'], query).indices, [], query);
  }
});

test('normalization preserves native and full-width names; malformed aliases are ignored', () => {
  assert.deepEqual(match([entry('Other', [' ＡＬＩＣＥ   Smith ', null, {}, 12]), '五条悟'], 'alice smith').indices, [0]);
  assert.deepEqual(match(['五条悟'], '五条悟').indices, [0]);
  assert.deepEqual(match(['𠮷'], '𠮷').indices, [0]);
  assert.deepEqual(match(['!!!'], '!!!').indices, [0]);
  assert.deepEqual(match(['Season 20 Part 2'], 'season 2').indices, []);
  assert.deepEqual(match(['Model A20 Type A2'], 'model a2').indices, []);
});

test('adapters retain row identity, scopes, relevance before rank, and rank grammar', () => {
  const rows = [{ id: 'a', rank: 1, name_full: 'Gojohn' }, { id: 'b', rank: 99, name_full: 'Satoru Gojo' }];
  assert.deepEqual(findCharacters(rows, 'gojo'), [rows[1], rows[0]]);
  assert.equal(searchCharacters(rows, 'gojp').matchType, 'fuzzy');
  assert.deepEqual(findCharacters(rows, '#99'), [rows[1]]);
  assert.deepEqual(findCharacters(rows, '#99x'), []);
  const wishes = [{ characterId: 'b', name: 'Satoru Gojo', nameNative: null, nameAlternatives: '[]', rank: null }];
  assert.equal(matchWishes(wishes, 'gojp')[0], wishes[0]);
  const franchises = [{ id: 2, name: 'Other', aliases: ['Sword Art Online'] }];
  assert.equal(findFranchises(franchises, 'sword art onlien')[0], franchises[0]);
  const collisions = [{ id: 1, name: 'Other', aliases: ['Rem'] }, { id: 2, name: 'Rem', aliases: [] }];
  assert.deepEqual(findFranchises(collisions, 'rem'), collisions);
});
