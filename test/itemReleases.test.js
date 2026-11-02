import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatItemRelease, latestItemRelease, guildItemChangelog } from '../lib/itemReleases.js';
import { openCatalog } from '../lib/catalogDb.js';
import { addItemToInventory, decrementItemCharge } from '../lib/itemStorage.js';

const definitions = [
  { id: 'lens', name: "Fortune's Lens", tier: 'rare' },
  { id: 'recast', name: "Fortune's Recast", tier: 'rare' },
  { id: 'clock', name: 'Clock *Prime*', tier: 'common' },
];
const release = { date: '2026-10-28', itemIds: ['lens', 'recast'] };

test('release names follow permanent guild discovery independently', () => {
  assert.equal(formatItemRelease(release, definitions, new Set()),
    '### Changelog — 28/10/2026\nAdded **two** new *Rare* items: **???** and **???**.');
  assert.match(formatItemRelease(release, definitions, new Set(['lens'])),
    /\*\*Fortune's Lens\*\* and \*\*\?\?\?\*\*/);
  assert.match(formatItemRelease(release, definitions, new Set(['lens', 'recast'])),
    /\*\*Fortune's Lens\*\* and \*\*Fortune's Recast\*\*/);
});

test('future releases support singular, mixed rarities, escaped names and actual latest date', () => {
  const newer = { date: '2026-11-01', itemIds: ['clock', 'lens', 'recast'] };
  assert.equal(latestItemRelease([newer, release]), newer);
  const text = formatItemRelease(newer, definitions, new Set(['clock']));
  assert.match(text, /^### Changelog — 01\/11\/2026\nAdded /);
  assert.ok(text.includes('**one** new *Common* item: **Clock \\*Prime\\***'));
  assert.ok(text.includes('**two** new *Rare* items: **???** and **???**'));
  assert.equal(latestItemRelease([]), null);
});

test('release records reject invalid dates, unknown items and repeated IDs', () => {
  for (const invalid of [
    { date: '2026-02-30', itemIds: ['lens'] },
    { date: 'today', itemIds: ['lens'] },
    { date: '2026-10-28', itemIds: ['missing'] },
    { date: '2026-10-28', itemIds: ['lens', 'lens'] },
    { date: '2026-10-28', itemIds: [] },
  ]) assert.throws(() => formatItemRelease(invalid, definitions, new Set()));
});

test('guild announcement reveals acquisitions permanently without leaking across guilds', t => {
  const db = openCatalog(':memory:');
  t.after(() => db.close());
  const hidden = guildItemChangelog(db, 'guild');
  assert.match(hidden, /new \*Legendary\* item: \*\*\?\?\?\*\*/);
  assert.match(hidden, /new \*Rare\* item: \*\*\?\?\?\*\*/);
  const acquired = addItemToInventory(db, 'guild', 'player', 'shackles_of_liberation');
  decrementItemCharge(db, acquired.item.id);
  assert.match(guildItemChangelog(db, 'guild'), /\*\*Shackles of Liberation\*\*/);
  assert.doesNotMatch(guildItemChangelog(db, 'other'), /Shackles of Liberation/);
});

test('large future release stays within a text-display budget without losing counts', () => {
  const many = Array.from({ length: 200 }, (_, i) => ({ id: `item${i}`, name: 'Long item '.repeat(50) + i, tier: 'rare' }));
  const text = formatItemRelease({ date: '2026-11-01', itemIds: many.map(item => item.id) }, many, new Set(many.map(item => item.id)));
  assert.ok(text.length <= 3000);
  assert.match(text, /\*\*200\*\* new \*Rare\* items/);
  assert.match(text, /more/);
});
