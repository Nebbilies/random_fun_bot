import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFinalCatalog } from '../lib/catalogDb.js';
import { onInventoryButton } from '../commands/inv.js';
import { addItemToInventory, getInventory } from '../lib/itemStorage.js';
import { getItemActionSource } from '../lib/itemActionStorage.js';

test('stale exact inventory controls never fall back to a live duplicate', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'inventory-expiry-controls-'));
  const db = createFinalCatalog(join(dir, 'fixture.sqlite'));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const now = Date.now();
  const old = addItemToInventory(db, '111', '123', 'hourglass_of_haste', 1, { now }).item;
  const copy = addItemToInventory(db, '111', '123', 'hourglass_of_haste', 1, { now: now + 1000 }).item;
  const responses = [];
  for (const id of [old.id, 999999]) {
    await onInventoryButton(db, { isButton: () => true, customId: `inv:use:123:${id}:v12`,
      guildId: '111', user: { id: '123' }, reply: async payload => responses.push(payload),
    }, old.expires_at);
  }
  assert.ok(responses.every(response => /expired or is no longer available/.test(response.content)));
  assert.equal(responses.length, 2);
  assert.equal(getInventory(db, '111', '123', old.expires_at)[0].id, copy.id);
  assert.equal(getInventory(db, '111', '123', old.expires_at)[0].charges, 1);
});

test('inventory use is reserved before asynchronous interaction acknowledgement', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'inventory-start-boundary-'));
  const db = createFinalCatalog(join(dir, 'fixture.sqlite'));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const source = addItemToInventory(db, '111', '123', 'kaimetsu').item;
  let sawReservation = false;
  await onInventoryButton(db, { id: '900', isButton: () => true, customId: `inv:use:123:${source.id}:v12`,
    guildId: '111', channelId: '10', channel: { id: '10' }, user: { id: '123' },
    deferUpdate: async () => {
      const action = db.prepare("SELECT * FROM item_actions WHERE state='confirming'").get();
      sawReservation = Boolean(action && getItemActionSource(db, action));
    },
    followUp: async () => ({ id: '901' }),
  }, source.expires_at - 1);
  assert.equal(sawReservation, true);
});

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
