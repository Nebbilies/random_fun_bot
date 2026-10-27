import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateFinalCatalogSchema } from '../lib/catalogFinalSchema.js';
import { upgradeFortuneCatalog } from '../lib/vaultFortuneUpgrade.js';
import { openCatalog, openFinalCatalog, openFinalCatalogReadOnly } from '../lib/catalogDb.js';

// Frozen fixture independent of the evolving target DDL and runtime initializers.
function previous(db) {
  db.exec(readFileSync(new URL('./fixtures/preFortuneV12.sql', import.meta.url), 'utf8'));
}
test('offline Fortune upgrade rehearses, preserves old terms and commits an exact reopenable final schema', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fortune-upgrade-')), path = join(dir, 'fixture.sqlite');
  let db = new DatabaseSync(path);
  try {
    previous(db);
    const captured = JSON.stringify({ rules: {}, weights: {}, roster: [], rewardPools: { epic: [], legendary: [] } });
    db.prepare("INSERT INTO vault_sessions(vault_id,guild_id,user_id,channel_id,remaining,captured_json,deadline,created_at) VALUES('old','g','u','c',0,?,100,0)").run(captured);
    db.close(); db = null;
    for (const open of [openCatalog, openFinalCatalog, openFinalCatalogReadOnly]) assert.throws(() => open(path), /offline Fortune upgrade/);
    db = new DatabaseSync(path);
    assert.equal(upgradeFortuneCatalog(db).committed, false);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='fortune_schema'").get(), undefined);
    db.exec('BEGIN');
    assert.throws(() => upgradeFortuneCatalog(db), /transaction/);
    assert.equal(db.isTransaction, true); db.exec('ROLLBACK');
    assert.equal(upgradeFortuneCatalog(db, { dryRun: false }).committed, true);
    assert.equal(db.prepare("SELECT captured_json FROM vault_sessions WHERE vault_id='old'").get().captured_json, captured);
    assert.throws(() => upgradeFortuneCatalog(db, { dryRun: false }), /invalid final/);
    validateFinalCatalogSchema(db);
    db.close(); db = null;
    for (const open of [openCatalog, openFinalCatalog, openFinalCatalogReadOnly]) open(path).close();
  } finally { db?.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('late upgrade failure rolls back every new object and preserves the original database', () => {
  const db = new DatabaseSync(':memory:');
  try {
    previous(db);
    const connection = { exec(sql) {
      if (sql.includes('CREATE TABLE fortune_schema')) {
        db.exec(sql);
        throw new Error('injected after extension DDL');
      }
      return db.exec(sql);
    }, prepare: sql => db.prepare(sql) };
    assert.throws(() => upgradeFortuneCatalog(connection, { dryRun: false }), /injected/);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='fortune_schema'").get(), undefined);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 12);
    assert.equal(upgradeFortuneCatalog(db).committed, false);
  } finally { db.close(); }
});

test('weakened pre-Fortune schema is refused without partial installation', () => {
  const db = new DatabaseSync(':memory:');
  try {
    previous(db); db.exec('CREATE TABLE unknown_extension(id INTEGER)');
    assert.throws(() => upgradeFortuneCatalog(db, { dryRun: false }), /invalid final/);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='fortune_schema'").get(), undefined);
  } finally { db.close(); }
});
