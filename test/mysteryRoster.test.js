import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectMysteryEvent, validateMysteryRoster } from '../lib/mysteryRoster.js';

const roster = [
  { id: 'doors', enabled: true, weight: 1 },
  { id: 'treasure_hunt', enabled: true, weight: 3 },
  { id: 'clue_reveal', enabled: false, weight: 2 },
];

test('roster validates stable unique IDs and finite positive weights', () => {
  assert.doesNotThrow(() => validateMysteryRoster(roster));
  assert.throws(() => validateMysteryRoster([{ id: 'Bad Name', enabled: true, weight: 1 }]), /id/i);
  assert.throws(() => validateMysteryRoster([
    { id: 'doors', enabled: true, weight: 1 },
    { id: 'doors', enabled: false, weight: 2 },
  ]), /duplicate/i);
  assert.throws(() => validateMysteryRoster([{ id: 'doors', enabled: 'yes', weight: 1 }]), /enabled/i);
  for (const weight of [0, -1, NaN, Infinity]) {
    assert.throws(() => validateMysteryRoster([{ id: 'doors', enabled: true, weight }]), /weight/i);
  }
});

test('weighted selection filters disabled and unavailable events, then renormalizes', () => {
  assert.equal(selectMysteryEvent(roster, ['doors', 'treasure_hunt', 'clue_reveal'], () => 0).id, 'doors');
  assert.equal(selectMysteryEvent(roster, ['doors', 'treasure_hunt'], () => 0.2499).id, 'doors');
  assert.equal(selectMysteryEvent(roster, ['doors', 'treasure_hunt'], () => 0.25).id, 'treasure_hunt');
  assert.equal(selectMysteryEvent(roster, new Set(['treasure_hunt']), () => 0.9).id, 'treasure_hunt');
  assert.equal(selectMysteryEvent(roster, ['clue_reveal'], () => 0), null);
  assert.equal(selectMysteryEvent(roster, [], () => 0), null);
});

test('weighted selection validates its inputs and random draw', () => {
  assert.throws(() => selectMysteryEvent(roster, 'doors'), /available/i);
  assert.throws(() => selectMysteryEvent(roster, ['doors'], () => 1), /random/i);
  assert.throws(() => selectMysteryEvent(roster, ['doors'], () => NaN), /random/i);
  assert.equal(selectMysteryEvent(roster, undefined, () => 0.5).id, 'treasure_hunt');
});
