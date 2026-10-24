import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { getDiscoveredItemIds, syncItemDiscovery } from '../lib/itemDiscovery.js';
import { initItemStorage, addItemToInventory, removeItemFromInventory, decrementItemCharge } from '../lib/itemStorage.js';

function memoryDb(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  return db;
}

function legacyInventory(db) {
  db.exec(`CREATE TABLE user_inventory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL, user_id TEXT NOT NULL, item_id TEXT NOT NULL,
    charges INTEGER NOT NULL, acquired_at TEXT NOT NULL
  )`);
  const insert = db.prepare(`INSERT INTO user_inventory (guild_id, user_id, item_id, charges, acquired_at)
    VALUES (?, ?, ?, 1, '2020-01-01T00:00:00.000Z')`);
  insert.run('123', 'u1', 'love_letter');
  insert.run('123', 'u2', 'love_letter');
  insert.run('123', 'u2', 'golden_whistle');
  insert.run('456', 'u3', 'love_letter');
  insert.run('456', 'u3', 'hourglass_of_haste');
}

function snapshot(db) {
  return db.prepare('SELECT * FROM user_inventory ORDER BY id').all();
}

test('successful insert discovers permanently, deduplicates, and isolates guilds', t => {
  const db = memoryDb(t);
  initItemStorage(db);
  assert.deepEqual(getDiscoveredItemIds(db, '123'), new Set());
  const letter = addItemToInventory(db, '123', 'u1', 'love_letter', 1);
  assert.equal(letter.status, 'added');
  assert.deepEqual(getDiscoveredItemIds(db, '123'), new Set(['love_letter']));
  const first = db.prepare('SELECT * FROM guild_item_discoveries').get();
  assert.ok(first.discovered_at);
  assert.equal(removeItemFromInventory(db, letter.item.id), true);
  const duplicate = addItemToInventory(db, '123', 'u2', 'love_letter', 1);
  assert.deepEqual(db.prepare('SELECT * FROM guild_item_discoveries').all(), [first]);
  assert.equal(decrementItemCharge(db, duplicate.item.id).removed, true);
  const whistle = addItemToInventory(db, '456', 'u1', 'golden_whistle', 1);
  assert.equal(whistle.status, 'added');
  assert.deepEqual(getDiscoveredItemIds(db, '123'), new Set(['love_letter']));
  assert.deepEqual(getDiscoveredItemIds(db, '456'), new Set(['golden_whistle']));
  assert.deepEqual(getDiscoveredItemIds(db, '789'), new Set());
  initItemStorage(db);
  assert.deepEqual(getDiscoveredItemIds(db, '123'), new Set(['love_letter']));
});

test('full inventories and failed SQL inserts do not discover items', t => {
  const db = memoryDb(t);
  initItemStorage(db);
  for (let i = 0; i < 5; i++) addItemToInventory(db, '123', 'u1', 'love_letter', 1);
  assert.equal(addItemToInventory(db, '123', 'u1', 'golden_whistle', 1).status, 'full');
  assert.throws(() => addItemToInventory(db, '123', 'u2', null, 1));
  assert.deepEqual(getDiscoveredItemIds(db, '123'), new Set(['love_letter']));
});

test('trigger discovery is atomic with inventory inserts and transaction rollbacks', t => {
  const db = memoryDb(t);
  initItemStorage(db);
  db.exec('BEGIN');
  addItemToInventory(db, '123', 'u1', 'love_letter', 1);
  assert.ok(getDiscoveredItemIds(db, '123').has('love_letter'));
  db.exec('ROLLBACK');
  assert.deepEqual(getDiscoveredItemIds(db, '123'), new Set());
  assert.equal(snapshot(db).length, 0);
  db.exec(`CREATE TRIGGER reject_discovery BEFORE INSERT ON guild_item_discoveries
    BEGIN SELECT RAISE(ABORT, 'discovery failed'); END`);
  assert.throws(() => addItemToInventory(db, '123', 'u1', 'golden_whistle', 1), /discovery failed/);
  assert.equal(snapshot(db).length, 0);
});

test('initialization never backfills; explicit sync is scoped, idempotent, and preserves inventory', t => {
  const db = memoryDb(t);
  legacyInventory(db);
  const before = snapshot(db);
  initItemStorage(db);
  initItemStorage(db);
  assert.deepEqual(getDiscoveredItemIds(db, '123'), new Set());
  const dry = syncItemDiscovery(db, { guildId: '123', dryRun: true });
  assert.deepEqual(dry, {
    dryRun: true, scannedInventoryRows: 3, scannedGuilds: 1, candidateDiscoveries: 2,
    existingDiscoveries: 0, newDiscoveries: 2, insertedDiscoveries: 0,
  });
  assert.deepEqual(getDiscoveredItemIds(db, '123'), new Set());
  const scoped = syncItemDiscovery(db, { guildId: '123' });
  assert.equal(scoped.insertedDiscoveries, 2);
  assert.deepEqual(getDiscoveredItemIds(db, '123'), new Set(['love_letter', 'golden_whistle']));
  assert.deepEqual(getDiscoveredItemIds(db, '456'), new Set());
  const all = syncItemDiscovery(db);
  assert.equal(all.scannedInventoryRows, 5);
  assert.equal(all.scannedGuilds, 2);
  assert.equal(all.candidateDiscoveries, 4);
  assert.equal(all.existingDiscoveries, 2);
  assert.equal(all.insertedDiscoveries, 2);
  const repeat = syncItemDiscovery(db);
  assert.equal(repeat.newDiscoveries, 0);
  assert.equal(repeat.insertedDiscoveries, 0);
  assert.equal(repeat.existingDiscoveries, 4);
  assert.equal(syncItemDiscovery(db, { guildId: '789' }).candidateDiscoveries, 0);
  assert.deepEqual(snapshot(db), before);
  db.exec('DELETE FROM user_inventory');
  assert.equal(syncItemDiscovery(db).insertedDiscoveries, 0);
  assert.deepEqual(getDiscoveredItemIds(db, '456'), new Set(['love_letter', 'hourglass_of_haste']));
});

test('sync initializes discovery only, and dry run tolerates a missing discovery table', t => {
  const db = memoryDb(t);
  legacyInventory(db);
  assert.deepEqual(getDiscoveredItemIds(db, '123'), new Set());
  assert.equal(syncItemDiscovery(db, { dryRun: true }).newDiscoveries, 4);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'guild_item_discoveries'").get(), undefined);
  assert.equal(syncItemDiscovery(db).insertedDiscoveries, 4);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'user_inventory_limits'").get(), undefined);
  // A raw insertion takes the same atomic trigger path as the shared acquisition API.
  db.exec("INSERT INTO user_inventory (guild_id, user_id, item_id, charges, acquired_at) VALUES ('123', 'u4', 'new_item', 1, 'now')");
  assert.ok(getDiscoveredItemIds(db, '123').has('new_item'));
});

test('CLI dry run opens read-only without migration; real run supports guild and repeat runs', t => {
  const dir = mkdtempSync(join(tmpdir(), 'item-discovery-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'legacy.sqlite');
  let db = new DatabaseSync(path);
  legacyInventory(db);
  db.close();
  const before = readFileSync(path);
  const run = (...args) => {
    const result = spawnSync(process.execPath, ['scripts/syncItemDiscovery.js', '--db', path, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  assert.equal(run('--dry-run').newDiscoveries, 4);
  assert.deepEqual(readFileSync(path), before);
  db = new DatabaseSync(path, { readOnly: true });
  assert.equal(syncItemDiscovery(db, { dryRun: true }).insertedDiscoveries, 0);
  db.close();
  assert.equal(run('--guild', '123').insertedDiscoveries, 2);
  assert.equal(run('--dry-run').newDiscoveries, 2);
  assert.equal(run('--guild', '123').insertedDiscoveries, 0);
  assert.equal(run().insertedDiscoveries, 2);
  assert.equal(run().insertedDiscoveries, 0);
  db = new DatabaseSync(path);
  const inventoryBefore = snapshot(db);
  db.exec('DELETE FROM user_inventory');
  db.close();
  db = new DatabaseSync(path, { readOnly: true });
  assert.deepEqual(getDiscoveredItemIds(db, '123'), new Set(['love_letter', 'golden_whistle']));
  assert.equal(inventoryBefore.length, 5);
  assert.equal(snapshot(db).length, 0);
  db.close();
  const invalid = spawnSync(process.execPath, ['scripts/syncItemDiscovery.js', '--guild'], { encoding: 'utf8' });
  assert.notEqual(invalid.status, 0);
});
