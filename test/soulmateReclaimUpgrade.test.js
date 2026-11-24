import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Worker } from 'node:worker_threads';
import { createFinalCatalog, openFinalCatalog, openFinalCatalogReadOnly } from '../lib/catalogDb.js';
import { isPreSoulmateReclaimCatalogSchema } from '../lib/catalogFinalSchema.js';
import { upgradeFortuneCatalog } from '../lib/vaultFortuneUpgrade.js';

const previousAwards = readFileSync(new URL('./fixtures/preSoulmateReclaimAwards.sql', import.meta.url), 'utf8');
const character = '11111111-1111-4111-8111-111111111111';
function previousCatalog(t) {
  const dir = mkdtempSync(join(tmpdir(), 'soulmate-reclaim-upgrade-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'catalog.sqlite');
  const db = createFinalCatalog(path);
  db.exec('DROP INDEX characters_by_main_franchise; ALTER TABLE characters DROP COLUMN main_franchise_id; DROP TABLE affection_awards;');
  db.exec(previousAwards);
  assert.equal(isPreSoulmateReclaimCatalogSchema(db), true);
  db.prepare('INSERT INTO character_identities(id) VALUES(?)').run(character);
  db.prepare("INSERT INTO character_affection VALUES('1','101',?,100,0)").run(character);
  db.prepare("INSERT INTO affection_awards(rowid,source_key,guild_id,user_id,character_id,base,amount,total,milestones_json,created_at) VALUES(17,'old','1','101',?,100,100,100,'[]',0)").run(character);
  return { db, path };
}
function contents(db) {
  return Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(({name}) => [name, db.prepare(`SELECT rowid AS _rowid_, * FROM "${name}" ORDER BY rowid`).all()]));
}

test('previous award schema upgrades on writable open without changing any existing rows or receipt order', t => {
  const fixture = previousCatalog(t);
  const before = contents(fixture.db);
  fixture.db.close();
  const db = openFinalCatalog(fixture.path);
  try {
    assert.deepEqual(contents(db), before);
    // Historical base 8 and the nerfed base 5 must both remain valid receipts.
    assert.doesNotThrow(() => db.prepare("INSERT INTO affection_awards VALUES('new','1','101',?,8,8,108,'[]',1)").run(character));
    assert.doesNotThrow(() => db.prepare("INSERT INTO affection_awards VALUES('nerfed','1','101',?,5,5,113,'[]',2)").run(character));
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 12);
  } finally { db.close(); }
});

test('read-only access explains the upgrade and dry-run leaves schema and all rows unchanged', t => {
  const {db,path} = previousCatalog(t);
  try {
    const before = contents(db), sql = db.prepare("SELECT sql FROM sqlite_schema WHERE name='affection_awards'").get().sql;
    assert.throws(() => openFinalCatalogReadOnly(path), /Soulmate reclaim.*writable application/i);
    assert.equal(upgradeFortuneCatalog(db).committed, false);
    assert.deepEqual(contents(db), before);
    assert.equal(db.prepare("SELECT sql FROM sqlite_schema WHERE name='affection_awards'").get().sql, sql);
    upgradeFortuneCatalog(db, {dryRun:false});
    const migrated = contents(db);
    upgradeFortuneCatalog(db, {dryRun:false});
    assert.deepEqual(contents(db), migrated);
    openFinalCatalogReadOnly(path).close();
  } finally { db.close(); }
});

test('failure after copying receipts rolls the whole upgrade back', t => {
  const {db} = previousCatalog(t);
  try {
    const before = contents(db), schema = db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all();
    const connection = {
      get isTransaction() { return db.isTransaction; },
      prepare: sql => db.prepare(sql),
      exec(sql) {
        db.exec(sql);
        if (sql.includes('DROP TABLE affection_awards_reclaim_previous')) throw new Error('injected copy failure');
      },
    };
    assert.throws(() => upgradeFortuneCatalog(connection, {dryRun:false}), /injected copy failure/);
    assert.deepEqual(contents(db), before);
    assert.deepEqual(db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all(), schema);
    assert.equal(db.isTransaction, false);
    upgradeFortuneCatalog(db, {dryRun:false});
  } finally { db.close(); }
});

test('a weakened predecessor or corrupt prior receipt fails without migration', t => {
  const {db} = previousCatalog(t);
  try {
    db.exec('PRAGMA ignore_check_constraints=ON');
    db.prepare("UPDATE affection_awards SET base=3 WHERE source_key='old'").run();
    db.exec('PRAGMA ignore_check_constraints=OFF');
    const before = contents(db);
    assert.throws(() => upgradeFortuneCatalog(db, {dryRun:false}), /integrity|constraint/i);
    assert.deepEqual(contents(db), before);
    db.prepare("UPDATE affection_awards SET base=100 WHERE source_key='old'").run();
    db.exec('CREATE TABLE unexpected_extension(id INTEGER)');
    assert.throws(() => upgradeFortuneCatalog(db, {dryRun:false}), /invalid final catalog schema/);
    assert.match(db.prepare("SELECT sql FROM sqlite_schema WHERE name='affection_awards'").get().sql, /base IN \(1,5,10,12,20,100\)/);
  } finally { db.close(); }
});

test('concurrent writable opens serialize the award migration and preserve receipts', async t => {
  const {db,path} = previousCatalog(t), workers = [];
  const before = contents(db);
  db.exec('BEGIN IMMEDIATE');
  const run = () => {
    const worker = new Worker(`
      const {parentPort,workerData}=require('node:worker_threads');
      (async()=>{
        const {openFinalCatalog}=await import(workerData.module);
        parentPort.postMessage('ready');
        openFinalCatalog(workerData.path).close();
      })().catch(error=>{throw error});`, {eval:true,workerData:{path,module:new URL('../lib/catalogDb.js',import.meta.url).href}});
    workers.push(worker);
    return {
      ready: new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);}),
      done: new Promise((resolve,reject)=>{worker.once('error',reject);worker.once('exit',code=>code===0?resolve():reject(new Error(`Worker exit ${code}`)));}),
    };
  };
  try {
    const starts = [run(),run()];
    const done = Promise.all(starts.map(s=>s.done)); done.catch(()=>{});
    await Promise.all(starts.map(s=>s.ready));
    db.exec('ROLLBACK');
    await done;
    assert.deepEqual(contents(db), before);
    openFinalCatalogReadOnly(path).close();
  } finally {
    await Promise.all(workers.map(w=>w.terminate()));
    db.close();
  }
});
