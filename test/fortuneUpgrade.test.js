import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { validateFinalCatalogSchema } from '../lib/catalogPreRankingSchema.js';
import { upgradeFortuneCatalog } from '../lib/catalogPreRankingUpgrade.js';
import { openCatalog, openCatalogReadOnly, openFinalCatalog, openFinalCatalogReadOnly } from './helpers/preRankingCatalog.js';

// Frozen fixture independent of the evolving target DDL and runtime initializers.
function previous(db) {
  db.exec(readFileSync(new URL('./fixtures/preFortuneV12.sql', import.meta.url), 'utf8'));
}
test('optional Fortune upgrade rehearses and commits an exact reopenable final schema', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fortune-upgrade-')), path = join(dir, 'fixture.sqlite');
  let db = new DatabaseSync(path);
  try {
    previous(db);
    const captured = JSON.stringify({ rules: {}, weights: {}, roster: [], rewardPools: { epic: [], legendary: [] } });
    db.prepare("INSERT INTO vault_sessions(vault_id,guild_id,user_id,channel_id,remaining,captured_json,deadline,created_at) VALUES('old','g','u','c',0,?,100,0)").run(captured);
    db.close(); db = null;
    const beforeReadOnly = readFileSync(path);
    for (const open of [openCatalogReadOnly, openFinalCatalogReadOnly]) {
      assert.throws(() => open(path), /start.*writable application/i);
      assert.deepEqual(readFileSync(path), beforeReadOnly);
    }
    db = new DatabaseSync(path);
    assert.equal(upgradeFortuneCatalog(db).committed, false);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='fortune_schema'").get(), undefined);
    db.exec("BEGIN; INSERT INTO catalog_meta VALUES('caller-owned','keep')");
    assert.throws(() => upgradeFortuneCatalog(db), /transaction/);
    assert.equal(db.isTransaction, true);
    assert.equal(db.prepare("SELECT value FROM catalog_meta WHERE key='caller-owned'").get().value, 'keep');
    db.exec('ROLLBACK');
    assert.equal(upgradeFortuneCatalog(db, { dryRun: false }).committed, true);
    assert.equal(db.prepare("SELECT captured_json FROM vault_sessions WHERE vault_id='old'").get().captured_json, captured);
    assert.equal(upgradeFortuneCatalog(db, { dryRun: false }).committed, true);
    validateFinalCatalogSchema(db);
    db.close(); db = null;
    for (const open of [openCatalog, openFinalCatalog, openFinalCatalogReadOnly]) open(path).close();
  } finally { db?.close(); rmSync(dir, { recursive: true, force: true }); }
});
for (const firstOpen of [openCatalog, openFinalCatalog]) {
  test(`${firstOpen.name} automatically extends frozen v12 once without changing existing data or snapshots`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'fortune-startup-')), path = join(dir, 'fixture.sqlite');
    let db = new DatabaseSync(path);
    try {
      previous(db);
      db.exec(`INSERT INTO user_inventory VALUES(42,'g','u','hourglass_of_haste',3,'old-date');
        INSERT INTO catalog_meta VALUES('keep','original');`);
      const captured = '{"rules":{"old":true},"rewardPools":{"epic":["old-item"]}}';
      db.prepare(`INSERT INTO vault_sessions(vault_id,guild_id,user_id,channel_id,remaining,captured_json,deadline,created_at)
        VALUES('old','g','u','c',0,?,100,0)`).run(captured);
      const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all();
      const rows = connection => tables.map(({ name }) => connection.prepare(`SELECT * FROM "${name}"`).all().map(row => {
        if (name !== 'user_inventory') return row;
        const { expires_at, ...legacy } = row;
        return legacy;
      }));
      const original = rows(db);
      db.close(); db = firstOpen(path);
      assert.equal(validateFinalCatalogSchema(db), true);
      assert.deepEqual(rows(db), original);
      assert.equal(db.prepare("SELECT captured_json FROM vault_sessions WHERE vault_id='old'").get().captured_json, captured);
      db.close(); db = null;
      const bytes = readFileSync(path);
      for (const open of [openCatalog, openFinalCatalog, openCatalogReadOnly, openFinalCatalogReadOnly, firstOpen]) {
        db = open(path);
        assert.deepEqual(rows(db), original);
        db.close(); db = null;
        assert.deepEqual(readFileSync(path), bytes);
      }
    } finally { db?.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}

for (const busyTimeout of [0, 5000, 90000]) {
  test(`upgrade preserves caller busy timeout ${busyTimeout} after rehearsal, commit, and failure`, () => {
    const db = new DatabaseSync(':memory:');
    try {
      previous(db);
      db.exec(`PRAGMA busy_timeout=${busyTimeout}`);
      upgradeFortuneCatalog(db);
      assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout, busyTimeout);
      upgradeFortuneCatalog(db, { dryRun: false });
      assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout, busyTimeout);
      db.exec('CREATE TABLE unknown_extension(id INTEGER)');
      assert.throws(() => upgradeFortuneCatalog(db, { dryRun: false }), /invalid final/);
      assert.equal(db.isTransaction, false);
      assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout, busyTimeout);
    } finally { db.close(); }
  });
}

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

test('concurrent first starts serialize and recheck after acquiring the migration lock', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fortune-concurrent-')), path = join(dir, 'fixture.sqlite');
  const db = new DatabaseSync(path);
  const workers = [];
  try {
    previous(db);
    db.exec('BEGIN IMMEDIATE');
    const run = () => new Promise((resolve, reject) => {
      const worker = new Worker(`
        const { parentPort, workerData } = require('node:worker_threads');
        (async () => {
          const { DatabaseSync } = await import('node:sqlite');
          const { upgradeFortuneCatalog } = await import(workerData.module);
          const connection = new DatabaseSync(workerData.path);
          parentPort.postMessage('ready');
          upgradeFortuneCatalog(connection, { dryRun: false });
          connection.close();
        })().catch(error => { throw error; });
      `, { eval: true, workerData: { path, module: new URL('../lib/catalogPreRankingUpgrade.js', import.meta.url).href } });
      workers.push(worker);
      worker.on('error', reject);
      worker.on('exit', code => code === 0 ? resolve() : reject(new Error(`Worker exit ${code}`)));
    });
    const completed = Promise.all([run(), run()]);
    // Attach immediately so a worker failure cannot become an unhandled rejection.
    completed.catch(() => {});
    await Promise.all(workers.map(worker => new Promise(resolve => worker.once('message', resolve))));
    // Both contenders have reached the helper while this connection holds the lock.
    await new Promise(resolve => setTimeout(resolve, 50));
    db.exec('ROLLBACK');
    await completed;
    assert.equal(validateFinalCatalogSchema(db), true);
  } finally {
    await Promise.all(workers.map(worker => worker.terminate()));
    db.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test('startup upgrade waits beyond five seconds for another migration and restores caller timeouts', { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fortune-slow-startup-')), path = join(dir, 'fixture.sqlite');
  const db = new DatabaseSync(path);
  const workers = [];
  const release = new Int32Array(new SharedArrayBuffer(4));
  const run = (holder, busyTimeout) => {
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      (async () => {
        const { DatabaseSync } = await import('node:sqlite');
        const { upgradeFortuneCatalog } = await import(workerData.module);
        const db = new DatabaseSync(workerData.path);
        db.exec('PRAGMA busy_timeout=' + workerData.busyTimeout);
        const connection = workerData.holder ? {
          get isTransaction() { return db.isTransaction; },
          prepare: sql => db.prepare(sql),
          exec(sql) {
            db.exec(sql);
            if (sql === 'BEGIN IMMEDIATE') {
              parentPort.postMessage('ready');
              // Model slow production validation while holding the actual upgrade lock.
              Atomics.wait(new Int32Array(workerData.release), 0, 0, 15000);
            }
          }
        } : db;
        if (!workerData.holder) parentPort.postMessage('ready');
        try {
          upgradeFortuneCatalog(connection, { dryRun: false });
          parentPort.postMessage({ timeout: db.prepare('PRAGMA busy_timeout').get().timeout });
        } finally { db.close(); }
      })().catch(error => { throw error; });
    `, { eval: true, workerData: { path, holder, busyTimeout, release: release.buffer,
      module: new URL('../lib/catalogPreRankingUpgrade.js', import.meta.url).href } });
    workers.push(worker);
    const ready = new Promise((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
      worker.once('exit', code => { if (code !== 0) reject(new Error(`Worker exit ${code}`)); });
    });
    const completed = new Promise((resolve, reject) => {
      let result;
      worker.on('message', message => { if (typeof message === 'object') result = message; });
      worker.once('error', reject);
      worker.once('exit', code => code === 0 ? resolve(result) : reject(new Error(`Worker exit ${code}`)));
    });
    // A contender can fail while the parent is deliberately holding the lock.
    completed.catch(() => {});
    return { ready, completed };
  };
  try {
    previous(db);
    const holder = run(true, 0);
    await holder.ready;
    const contenders = [run(false, 0), run(false, 5000)];
    await Promise.all(contenders.map(worker => worker.ready));
    await new Promise(resolve => setTimeout(resolve, 5500));
    Atomics.store(release, 0, 1);
    Atomics.notify(release, 0);
    const results = await Promise.all([holder, ...contenders].map(worker => worker.completed));
    assert.deepEqual(results, [{ timeout: 0 }, { timeout: 0 }, { timeout: 5000 }]);
    assert.equal(validateFinalCatalogSchema(db), true);
  } finally {
    Atomics.store(release, 0, 1);
    Atomics.notify(release, 0);
    await Promise.all(workers.map(worker => worker.terminate()));
    db.close(); rmSync(dir, { recursive: true, force: true });
  }
});

for (const alteration of ['CREATE TABLE unknown_extension(id INTEGER)',
  'CREATE TABLE fortune_schema(version INTEGER)', 'DROP INDEX stage_character_rank']) {
  test(`startup refuses unknown or partial frozen schemas without mutation: ${alteration}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'fortune-invalid-')), path = join(dir, 'fixture.sqlite');
    const db = new DatabaseSync(path);
    try { previous(db); db.exec(alteration); } finally { db.close(); }
    try {
      const before = readFileSync(path);
      for (const open of [openCatalog, openFinalCatalog, openCatalogReadOnly, openFinalCatalogReadOnly]) {
        assert.throws(() => open(path), /invalid final catalog schema/);
        assert.deepEqual(readFileSync(path), before);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test('weakened pre-Fortune schema is refused without partial installation', () => {
  const db = new DatabaseSync(':memory:');
  try {
    previous(db); db.exec('CREATE TABLE unknown_extension(id INTEGER)');
    assert.throws(() => upgradeFortuneCatalog(db, { dryRun: false }), /invalid final/);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='fortune_schema'").get(), undefined);
  } finally { db.close(); }
});
