import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCatalog } from '../lib/catalogDb.js';
import { convertLegacyCatalogToFinal } from '../lib/characterIdentityMigration.js';
import { DatabaseSync } from 'node:sqlite';
import { PRE_AFFECTION_CATALOG_DDL, installEmptyFinalCatalog, validateFinalCatalogSchema } from '../lib/catalogFinalSchema.js';
import { CHARACTER_GENDER_DDL } from '../lib/characterGenderSchema.js';
import { OWNERSHIP_HISTORY_DDL } from '../lib/ownershipHistorySchema.js';
import { ITEM_REWARD_SOURCE_DDL } from '../lib/itemRewardSourceSchema.js';
import { upgradeFortuneCatalog } from '../lib/vaultFortuneUpgrade.js';

function previous(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(PRE_AFFECTION_CATALOG_DDL.replace(CHARACTER_GENDER_DDL, '').replace(OWNERSHIP_HISTORY_DDL, '').replace(ITEM_REWARD_SOURCE_DDL, ''));
  db.exec("INSERT INTO item_expiry_schema VALUES(1,0); INSERT INTO catalog_state VALUES(1,0,0,0); INSERT INTO game_config_state VALUES(1,0); PRAGMA user_version=12");
  return db;
}
test('pre-Phase-2 exact schema upgrades atomically, with no backfilled ownership losses', t => {
  const db = previous(t);
  const id = '11111111-1111-4111-8111-111111111111';
  db.prepare('INSERT INTO character_identities(id) VALUES(?)').run(id);
  db.prepare("INSERT INTO marriages(guild_id,character_id,owner_id,married_at) VALUES('1',?,'2','old')").run(id);
  assert.throws(() => validateFinalCatalogSchema(db), /start.*writable application/i);
  upgradeFortuneCatalog(db);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='reward_sources'").get(), undefined);
  upgradeFortuneCatalog(db, { dryRun: false });
  assert.equal(validateFinalCatalogSchema(db), true);
  assert.equal(db.prepare('SELECT count(*) AS n FROM character_ownership_losses').get().n, 0);
  assert.equal(db.prepare('SELECT married_at FROM marriages').get().married_at, 'old');
  upgradeFortuneCatalog(db, { dryRun: false });
  db.exec('DELETE FROM marriages');
  assert.equal(db.prepare('SELECT count(*) AS n FROM character_ownership_losses').get().n, 1);
});
test('partial Phase-2 layout is refused without repairing or changing the schema', t => {
  const db = previous(t);
  db.exec(ITEM_REWARD_SOURCE_DDL);
  assert.throws(() => upgradeFortuneCatalog(db, { dryRun: false }), /invalid final catalog schema/i);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='ownership_operation_clock'").get(), undefined);
});
test('fresh schema refuses a committed operation clock override at startup', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  installEmptyFinalCatalog(db);
  db.exec('UPDATE ownership_operation_clock SET now_ms=42');
  assert.throws(() => validateFinalCatalogSchema(db), /clock context/);
});

test('offline conversion retains unpublished marriages without fabricating loss history', t => {
  const dir = mkdtempSync(join(tmpdir(), 'phase2-conversion-'));
  const db = openCatalog(join(dir, 'fixture.sqlite'));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  db.exec("INSERT INTO character_identities VALUES(99,'Retained',NULL); INSERT INTO marriages(guild_id,character_id,owner_id,married_at) VALUES('1',99,'2','old')");
  assert.equal(convertLegacyCatalogToFinal(db, { dryRun: false }).committed, true);
  assert.equal(db.prepare('SELECT count(*) AS n FROM character_ownership_losses').get().n, 0);
  assert.equal(db.prepare('SELECT married_at FROM marriages').get().married_at, 'old');
  db.exec('DELETE FROM marriages');
  assert.equal(db.prepare('SELECT count(*) AS n FROM character_ownership_losses').get().n, 1);
  assert.equal(validateFinalCatalogSchema(db), true);
});

test('reward source linkage enforces reward foreign key and unique event identity', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec('PRAGMA foreign_keys=ON');
  installEmptyFinalCatalog(db);
  const source = db.prepare('INSERT INTO reward_sources VALUES(?,?,?,?)');
  assert.throws(() => source.run('missing','mystery_consolation','event','{}'), /FOREIGN KEY/);
  assert.throws(() => source.run(null,'mystery_consolation','null-event','{}'), /NOT NULL/);
  const reward = db.prepare("INSERT INTO vault_rewards(vault_id,guild_id,user_id,channel_id,original_json,state,created_at) VALUES(?,'1','2','3','{}','delivered',0)");
  reward.run('reward1'); reward.run('reward2');
  source.run('reward1','mystery_consolation','event','{}');
  assert.throws(() => source.run('reward2','mystery_consolation','event','{}'), /UNIQUE/);
  assert.equal(validateFinalCatalogSchema(db), true);
});
