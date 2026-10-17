import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MYSTERY_ODDS_ANCHORS,
  mysteryChanceForRank,
  passesMysteryGate,
  validateMysteryOddsAnchors,
} from '../lib/mysteryOdds.js';

test('mystery odds meet the agreed rank anchors', () => {
  assert.equal(mysteryChanceForRank(1), 1);
  for (let rank = 1; rank <= 20; rank++) assert.equal(mysteryChanceForRank(rank), 1);
  for (const { rank, chance } of MYSTERY_ODDS_ANCHORS) {
    assert.equal(mysteryChanceForRank(rank), chance);
  }
});

test('mystery odds interpolate in log probability and keep declining past the current catalog', () => {
  const halfway = mysteryChanceForRank(75);
  assert.ok(Math.abs(halfway - Math.sqrt(0.5 * 0.25)) < 1e-12);
  for (let rank = 21; rank <= 15_000; rank++) {
    assert.ok(mysteryChanceForRank(rank) <= mysteryChanceForRank(rank - 1));
  }
  assert.ok(mysteryChanceForRank(15_001) < 0.0005);
  assert.ok(mysteryChanceForRank(20_000) > 0);
  assert.ok(mysteryChanceForRank(20_000) < mysteryChanceForRank(15_001));
});

test('mystery odds reject invalid ranks, tables, and random draws', () => {
  for (const rank of [0, -1, 1.1, NaN, Infinity, '100']) {
    assert.throws(() => mysteryChanceForRank(rank), /rank/i);
  }
  assert.throws(() => validateMysteryOddsAnchors([]), /anchor/i);
  assert.throws(() => validateMysteryOddsAnchors([
    { rank: 20, chance: 1 }, { rank: 20, chance: 0.5 },
  ]), /rank/i);
  assert.throws(() => validateMysteryOddsAnchors([
    { rank: 20, chance: 1 }, { rank: 50, chance: 1.1 },
  ]), /chance/i);
  assert.throws(() => validateMysteryOddsAnchors([
    { rank: 20, chance: 0.5 }, { rank: 50, chance: 0.6 },
  ]), /decreas/i);
  assert.equal(passesMysteryGate(50, () => 0.49), true);
  assert.equal(passesMysteryGate(50, () => 0.5), false);
  for (const draw of [-0.01, 1, NaN]) {
    assert.throws(() => passesMysteryGate(50, () => draw), /random/i);
  }
});
