import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { installEmptyFinalCatalog, validateFinalCatalogSchema } from '../lib/catalogFinalSchema.js';
import { transferCharacter } from '../lib/characterTrade.js';
import { getItemDefinition } from '../lib/itemRoster.js';
import { marryCharacter, divorceCharacter } from '../lib/characterMarriage.js';
import { withOwnershipOperationClock, getLatestOwnershipLoss, listRecentOwnershipLosses } from '../lib/characterOwnershipHistory.js';

const id = '11111111-1111-4111-8111-111111111111';
function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  installEmptyFinalCatalog(db);
  db.prepare('INSERT INTO character_identities(id) VALUES(?)').run(id);
  db.prepare("INSERT INTO characters(id,rank,favourites,tie_order,likes_source) VALUES(?,1,1,1,'generated')").run(id);
  return db;
}
test('divorce records the operation time without backfilling existing ownership', t => {
  const db = fixture(t);
  const marriage = marryCharacter(db, '1', id, '2', 100).marriage;
  assert.equal(getLatestOwnershipLoss(db, '1', '2', id), null);
  assert.equal(divorceCharacter(db, '1', id, '2', marriage.id, 200), true);
  assert.deepEqual({ ...getLatestOwnershipLoss(db, '1', '2', id) }, { guildId: '1', formerOwnerId: '2', characterId: id, lostAt: 200 });
  assert.equal(listRecentOwnershipLosses(db, { guildId: '1', formerOwnerId: '2', now: 300, historyWindowMs: 100 }).length, 1);
  assert.equal(listRecentOwnershipLosses(db, { guildId: '1', formerOwnerId: '2', now: 301, historyWindowMs: 100 }).length, 0);
  assert.equal(validateFinalCatalogSchema(db), true);
});

test('SQL boundary tracks old identity only, ignores metadata updates and preserves latest loss', t => {
  const db = fixture(t);
  marryCharacter(db, '1', id, '2', 0);
  withOwnershipOperationClock(db, 500, () => db.exec("UPDATE marriages SET married_at='changed'"));
  assert.equal(getLatestOwnershipLoss(db, '1', '2', id), null);
  withOwnershipOperationClock(db, 500, () => db.exec("UPDATE marriages SET owner_id='3',guild_id='4'"));
  assert.equal(getLatestOwnershipLoss(db, '1', '2', id).lostAt, 500);
  assert.equal(getLatestOwnershipLoss(db, '4', '2', id), null);
  withOwnershipOperationClock(db, 600, () => db.exec('DELETE FROM marriages'));
  assert.equal(getLatestOwnershipLoss(db, '4', '3', id).lostAt, 600);
  marryCharacter(db, '1', id, '2', 0);
  withOwnershipOperationClock(db, 100, () => db.exec('DELETE FROM marriages'));
  assert.equal(getLatestOwnershipLoss(db, '1', '2', id).lostAt, 500);
  assert.equal(listRecentOwnershipLosses(db, { guildId: '1', formerOwnerId: '2', now: 499, historyWindowMs: 1000 }).length, 0);
});
test('nested operation clocks restore context, and failed ownership writes roll back together', t => {
  const db = fixture(t);
  marryCharacter(db, '1', id, '2', 0);
  assert.throws(() => withOwnershipOperationClock(db, 100, () => {
    withOwnershipOperationClock(db, 200, () => db.exec("UPDATE marriages SET owner_id='3'"));
    assert.equal(db.prepare('SELECT now_ms FROM ownership_operation_clock').get().now_ms, 100);
    db.exec('DELETE FROM marriages');
    throw new Error('fail');
  }), /fail/);
  assert.equal(getLatestOwnershipLoss(db, '1', '2', id), null);
  assert.equal(db.prepare('SELECT owner_id FROM marriages').get().owner_id, '2');
  db.exec('BEGIN IMMEDIATE');
  withOwnershipOperationClock(db, 300, () => {
    assert.throws(() => withOwnershipOperationClock(db, 400, () => { throw new Error('inner'); }), /inner/);
    db.exec('DELETE FROM marriages');
  });
  assert.equal(db.isTransaction, true);
  assert.equal(getLatestOwnershipLoss(db, '1', '2', id).lostAt, 300);
  db.exec('ROLLBACK');
  assert.equal(getLatestOwnershipLoss(db, '1', '2', id), null);
  assert.equal(db.prepare('SELECT now_ms FROM ownership_operation_clock').get().now_ms, null);
  assert.throws(() => withOwnershipOperationClock(db, -1, () => {}), /time/);
  assert.throws(() => withOwnershipOperationClock(db, 1, async () => {}), /synchronous/);
});
test('caught failure in a joined scope cannot commit partial ownership or history', t => {
  const db = fixture(t);
  marryCharacter(db, '1', id, '2', 0);
  db.exec('BEGIN IMMEDIATE');
  assert.throws(() => withOwnershipOperationClock(db, 123, () => {
    db.exec("UPDATE marriages SET owner_id='3'");
    throw new Error('after mutation');
  }), /after mutation/);
  db.exec('COMMIT');
  assert.equal(db.prepare('SELECT owner_id FROM marriages').get().owner_id, '2');
  assert.equal(getLatestOwnershipLoss(db, '1', '2', id), null);
  assert.equal(db.prepare('SELECT now_ms FROM ownership_operation_clock').get().now_ms, null);
});

test('raw SQL uses portable wall time and retained identity history survives unpublication', t => {
  const db = fixture(t);
  marryCharacter(db, '1', id, '2', 0);
  const before = Date.now();
  db.exec('DELETE FROM marriages');
  const loss = getLatestOwnershipLoss(db, '1', '2', id);
  assert.ok(loss.lostAt >= before && loss.lostAt <= Date.now());
  db.exec('DELETE FROM characters');
  assert.equal(getLatestOwnershipLoss(db, '1', '2', id).lostAt, loss.lostAt);
  assert.equal(validateFinalCatalogSchema(db), true);
});

test('gift service records injected ownership loss time', t => {
  const db = fixture(t);
  marryCharacter(db, '1', id, '2', 0);
  assert.equal(transferCharacter(db, { guildId: '1', characterId: id, fromOwnerId: '2', toOwnerId: '3', now: 1234 }).status, 'transferred');
  assert.equal(getLatestOwnershipLoss(db, '1', '2', id).lostAt, 1234);
});
for (const itemId of ['master_key', 'pickpockets_hook']) {
  test(`${itemId} direct effect records injected loss time`, t => {
    const item = getItemDefinition(itemId);
    const db = fixture(t);
    db.exec("UPDATE characters SET name_full='Example'");
    marryCharacter(db, '1', id, '2', 0);
    const result = item.execute({ db, guildId: '1', userId: '3', args: ['<@2>', 'Example'], now: 4321, random: () => 0 });
    assert.equal(result.success, true);
    assert.equal(getLatestOwnershipLoss(db, '1', '2', id).lostAt, 4321);
  });
}
