import test from 'node:test';
import assert from 'node:assert/strict';
import { formatItemLifetime } from '../lib/itemDuration.js';

test('remaining item lifetime uses at most two nonzero units and positive subminute seconds', () => {
  for (const [ms, expected] of [
    [230_400_000, '(2d 16h)'], [15_120_000, '(4h 12m)'],
    [90_061_000, '(1d 1h)'], [86_460_000, '(1d 1m)'],
    [60_000, '(1m)'], [59_999, '(59s)'], [35_000, '(35s)'], [999, '(1s)'], [1, '(1s)'],
    [0, ''], [-1, ''], [NaN, ''], [undefined, ''],
  ]) assert.equal(formatItemLifetime(ms), expected, String(ms));
});
