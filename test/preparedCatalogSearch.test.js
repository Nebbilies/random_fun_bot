import test from 'node:test';
import assert from 'node:assert/strict';
import { findCharacters, prepareCharacterSearchIndex } from '../lib/gameCharacterLookup.js';
import { findFranchises, prepareFranchiseSearchIndex } from '../lib/franchiseLookup.js';

test('prepared character lookup preserves all match tiers, Unicode, ambiguous names and rank ordering', () => {
  const rows = [
    { id: 'a', rank: 3, name_full: 'Rem', name_native: 'レム', name_alternatives: '["Maid Rem"]' },
    { id: 'b', rank: 1, name_full: 'Rem', name_native: null, name_alternatives: '{}' },
    { id: 'c', rank: 2, name_full: 'Remy', name_alternatives: '["Rem", "  ＡＬＩＣＥ   Smith  "]' },
    { id: 'd', rank: 1234, name_full: 'Other', name_alternatives: '{bad' },
  ];
  const original = JSON.stringify(rows), plain = structuredClone(rows);
  assert.equal(prepareCharacterSearchIndex(rows), rows);
  for (const query of ['rem', 'maid rem', 'レム', 'remy', 'alice smith', 'alice', 'smith', 'emy', 'missing', '#1', '#1,234', 'r']) {
    assert.deepEqual(findCharacters(rows, query).map(r => r.id), findCharacters(plain, query).map(r => r.id), query);
  }
  assert.deepEqual(findCharacters(rows, 'rem').map(r => r.id), ['b', 'a']);
  assert.deepEqual(findCharacters(rows, 'alice smith').map(r => r.id), ['c']);
  assert.equal(JSON.stringify(rows), original);
});

test('prepared lookups reuse parsed metadata while ad-hoc lists remain fresh', () => {
  let reads = 0;
  const rows = [{ id: 'a', rank: 1, name_full: 'Alice', get name_alternatives() { reads++;return '["Ally"]'; } }];
  prepareCharacterSearchIndex(rows);
  const preparedReads = reads;
  assert.equal(findCharacters(rows, 'ally')[0].id, 'a');
  assert.equal(findCharacters(rows, 'alice')[0].id, 'a');
  assert.equal(reads, preparedReads);
  const live = [{ id: 'a', rank: 1, name_full: 'Old' }];
  assert.equal(findCharacters(live, 'old').length, 1);
  live[0].name_full = 'New';
  assert.equal(findCharacters(live, 'old').length, 0);
  assert.equal(findCharacters(live, 'new').length, 1);
});

test('prepared franchise searches retain exact, prefix, substring and ambiguous alias ordering', () => {
  const rows = [{ id: 9, name: 'Sword Art Online', aliases: ['ＳＡＯ'] }, { id: 2, name: 'Alternative', aliases: ['SAO', 'Gun Gale'] }];
  const original = JSON.stringify(rows), plain = structuredClone(rows);
  assert.equal(prepareFranchiseSearchIndex(rows), rows);
  for (const query of ['sao', 'sword', 'online', 'gun gale', 'gun', 'gale', 'missing', 's']) {
    assert.deepEqual(findFranchises(rows, query).map(r => r.id), findFranchises(plain, query).map(r => r.id));
  }
  assert.deepEqual(findFranchises(rows, 'sao').map(r => r.id), [2, 9]);
  assert.equal(JSON.stringify(rows), original);
});
