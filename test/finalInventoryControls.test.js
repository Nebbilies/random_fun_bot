import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFinalCatalog } from '../lib/catalogDb.js';
import { onInventoryButton } from '../commands/inv.js';

test('pre-cutover inventory controls expire on final schema without touching costs', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'inventory-controls-'));
  const db = createFinalCatalog(join(dir, 'fixture.sqlite'));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const responses = [];
  assert.equal(await onInventoryButton(db, { isButton: () => true, customId: 'inv:use:123:1', user: { id: '123' }, reply: async payload => responses.push(payload) }), true);
  assert.match(responses[0].content, /expired/);
  db.exec("INSERT INTO catalog_meta VALUES('game_maintenance','drain')");
  await onInventoryButton(db, { isButton: () => true, customId: 'inv:use:123:1:v12', user: { id: '123' }, reply: async payload => responses.push(payload) });
  assert.match(responses[1].content, /No item was consumed/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM item_actions').get().n, 0);
});
