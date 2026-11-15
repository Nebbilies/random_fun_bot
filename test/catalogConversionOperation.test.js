import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync, backup } from 'node:sqlite';
import { openCatalog, openCatalogReadOnly } from './helpers/preRankingCatalog.js';
import { initializeLegacyCatalog } from '../lib/catalogDb.js';
import { inspectCatalogRuntimeRestart } from '../lib/catalogRuntimeRecovery.js';
import { recoverVaultRewards } from '../lib/vaultRuntime.js';
import { settleCharacterMigration } from '../lib/characterMigrationSettlement.js';
import { parseConversionArgs, runCatalogConversion } from '../lib/catalogConversionOperation.js';

function fixture(t, drain = true) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'conversion-operation-'));
  const path = join(dir, 'offline-working.sqlite');
  const db = new DatabaseSync(path);
  initializeLegacyCatalog(db);
  db.exec(`INSERT INTO characters(id,rank,favourites,name_full) VALUES(7,1,50,'Synthetic');
    INSERT INTO character_identities VALUES(7,'Synthetic',NULL),(99,'Retained',NULL);
    INSERT INTO marriages(id,guild_id,character_id,owner_id,married_at) VALUES(401,'g',99,'u','date');
    UPDATE sqlite_sequence SET seq=999 WHERE name='marriages';`);
  if (drain) db.exec("INSERT INTO catalog_meta VALUES('game_maintenance','drain')");
  db.close();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, path, options: { database: path, commit: true, 'offline-working-copy': true,
    'backup-restore-verified': true, 'writers-stopped': true, 'conversations-drained': true,
    'source-app-commit': 'abcdef1', 'source-runtime': 'node-22.23.2',
    'target-app-commit': 'abcdef2', 'target-runtime': 'node-22.23.2',
    'backup-ref': 'synthetic-backup-1', 'restore-ref': 'synthetic-restore-1', 'rehearsal-ref': 'synthetic-rehearsal-1',
    report: join(dir, 'operation.jsonl') } };
}
function snapshot(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return { version: db.prepare('PRAGMA user_version').get().user_version,
      schema: db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all(),
      tables: db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all()
        .map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}"`).all()]) };
  } finally { db.close(); }
}
const rewardOutcome = { tier: 'common', tierData: { name: 'Common', color: 0x808080, emoji: '' },
  item: { id: 'hourglass_of_haste', name: 'Hourglass', description: 'Synthetic reward', maxCharges: 1 } };
const argv = options => Object.entries(options).flatMap(([key, value]) => value === true ? [`--${key}`] : [`--${key}`, value]);
const records = f => fs.readFileSync(f.options.report, 'utf8').trim().split('\n').map(line => JSON.parse(line));

test('strict CLI modes and affirmative acknowledgements refuse before changing accidental path', t => {
  const f = fixture(t), before = snapshot(f.path), bytes = fs.readFileSync(f.path);
  const invalid = [[], ['--commit'], ['--database', f.path, '--commit', '--rehearse'],
    ['--database', f.path, '--rehearse', '--rehearse'], ['--database', f.path, '--writers-stopped'],
    ['--database', f.path, '--wat'], ['--database', f.path, '--database', f.path],
    [...argv(f.options), '--writers-stopped', 'false']];
  for (const key of Object.keys(f.options).filter(k => k !== 'database' && k !== 'commit')) {
    const options = { ...f.options }; delete options[key]; invalid.push(argv(options));
  }
  invalid.push(argv({ ...f.options, 'backup-ref': 'https://user:secret@example.invalid' }));
  for (const args of invalid) {
    const child = spawnSync(process.execPath, ['scripts/migrateCharacterIdentities.js', ...args], { encoding: 'utf8' });
    assert.notEqual(child.status, 0, args.join(' '));
    assert.deepEqual(snapshot(f.path), before);
    assert.deepEqual(fs.readFileSync(f.path), bytes);
  }
  assert.equal(fs.existsSync(f.options.report), false);
  assert.throws(() => parseConversionArgs(['--database', f.path, '--commit=false']), /Unknown/);
});

test('default inventory is read-only; rehearsal rolls back; default names and symlink aliases refused', t => {
  const f = fixture(t), before = snapshot(f.path);
  assert.deepEqual(runCatalogConversion({ database: f.path }).blockers, []);
  assert.equal(runCatalogConversion({ database: f.path, rehearse: true }).committed, false);
  assert.deepEqual(snapshot(f.path), before);
  const defaultPath = join(f.dir, 'bot.sqlite'); fs.copyFileSync(f.path, defaultPath);
  assert.throws(() => runCatalogConversion({ database: defaultPath }), /Refusing/);
  const alias = join(f.dir, 'alias.sqlite');
  try { fs.symlinkSync(defaultPath, alias); }
  catch (error) { if (error.code === 'EPERM') { t.diagnostic('Symlink test unavailable: OS denied symlink creation'); return; } throw error; }
  assert.throws(() => runCatalogConversion({ database: alias }), /Refusing/);
  assert.deepEqual(snapshot(f.path), before);
});

test('real-file authoritative commit closes writer, opens through normal writable and read-only final APIs, refuses rerun', t => {
  const f = fixture(t);
  const child = spawnSync(process.execPath, ['scripts/migrateCharacterIdentities.js', ...argv(f.options)], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const report = JSON.parse(child.stdout);
  assert.equal(report.outcome, 'committed');
  assert.equal(report.database, fs.realpathSync(f.path));
  assert.equal(report.result.identities, 2);
  assert.equal(report.result.retainedOnly, 1);
  const evidence = records(f);
  assert.deepEqual(evidence.map(r => r.phase), ['start', 'validated-before-commit', 'outcome']);
  assert.equal(evidence[1].countsBefore.marriages, 1);
  assert.equal(evidence[1].after.counts.marriages, 1);
  assert.equal(evidence[1].sequencesBefore.find(r => r.name === 'marriages').seq, 999);
  assert.equal(evidence[1].after.sequences.find(r => r.name === 'marriages').seq, 999);
  for (const open of [openCatalog, openCatalogReadOnly]) {
    const db = open(f.path);
    try {
      assert.equal(inspectCatalogRuntimeRestart(db).ready, true);
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 12);
      assert.equal(db.prepare("SELECT value FROM catalog_meta WHERE key='game_maintenance'").get().value, 'drain');
      assert.equal(db.prepare('SELECT character_id FROM marriages').get().character_id.length, 36);
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    } finally { db.close(); }
  }
  const before = snapshot(f.path);
  assert.throws(() => runCatalogConversion({ ...f.options, report: join(f.dir, 'rerun.jsonl') }), /Already v12.*readOnly/i);
  assert.deepEqual(snapshot(f.path), before);
});

test('commit requires persisted drain under transaction, not just acknowledgements', t => {
  const f = fixture(t, false), before = snapshot(f.path);
  assert.throws(() => runCatalogConversion(f.options), /Persisted.*drain/);
  assert.deepEqual(snapshot(f.path), before);
  assert.equal(records(f).at(-1).outcome, 'not-committed');
});

for (const corrupt of ['json', 'state']) test(`corrupt vault ${corrupt} blocks final runtime and rolls conversion back`, t => {
  const f = fixture(t);
  const db = new DatabaseSync(f.path);
  db.prepare(`INSERT INTO vault_rewards(vault_id,guild_id,user_id,channel_id,original_json,state,created_at)
    VALUES('settlement-vault','g','u','c',?,?,1)`)
    .run(corrupt === 'json' ? '{broken' : '{}', corrupt === 'state' ? 'unknown' : 'delivered');
  db.close();
  const before = snapshot(f.path);
  assert.throws(() => runCatalogConversion(f.options), corrupt === 'json'
    ? /vault_reconciliation_required:vault_rewards:settlement-vault/
    : /Live vault_rewards settlement-vault \(unknown\)/);
  assert.deepEqual(snapshot(f.path), before, 'no settlement, refund or acknowledgement clearing');
  assert.equal(records(f).at(-1).outcome, 'not-committed');
});

for (const state of ['delivered', 'lost', 'declined']) test(`terminal vault ${state} without delivery acknowledgement converts and normal runtime reconciles`, async t => {
  const f = fixture(t);
  const db = new DatabaseSync(f.path);
  db.prepare(`INSERT INTO vault_rewards(vault_id,guild_id,user_id,channel_id,original_json,state,created_at)
    VALUES('settlement-vault','g','u','c',?,?,1)`)
    .run(JSON.stringify(rewardOutcome), state);
  db.close();
  assert.equal(runCatalogConversion(f.options).outcome, 'committed');
  const final = openCatalog(f.path);
  try {
    assert.equal(inspectCatalogRuntimeRestart(final).ready, true);
    assert.equal(final.prepare('SELECT delivered_at FROM vault_rewards').get().delivered_at, null);
    let sends = 0;
    const client = { channels: { fetch: async () => ({ send: async payload => {
      sends++;
      const message = { id: '501', ...payload, edit: async change => Object.assign(message, change) };
      return message;
    } }) } };
    await recoverVaultRewards(final, client, { now: () => 456 });
    await recoverVaultRewards(final, client, { now: () => 456 });
    assert.equal(final.prepare('SELECT delivered_at FROM vault_rewards').get().delivered_at, 456);
    assert.equal(final.prepare('SELECT state FROM vault_rewards').get().state, state);
    assert.equal(final.prepare('SELECT count(*) n FROM user_inventory').get().n, 0);
    assert.equal(sends, 1);
  } finally { final.close(); }
});

test('actual offline settlement vault converts without replaying item or inventing acknowledgement; runtime reconciles', async t => {
  const f = fixture(t);
  const db = new DatabaseSync(f.path);
  db.prepare(`INSERT INTO vault_rewards(vault_id,guild_id,user_id,channel_id,original_json,state,created_at)
    VALUES('actual-settlement','g','u','c',?,'decision',1)`)
    .run(JSON.stringify(rewardOutcome));
  const settlement = settleCharacterMigration(db, { offline: true, backupVerified: true, now: 123 });
  assert.deepEqual(settlement.deliveredVaults, ['actual-settlement']);
  assert.equal(db.prepare('SELECT delivered_at FROM vault_rewards').get().delivered_at, null);
  assert.equal(db.prepare('SELECT count(*) n FROM user_inventory').get().n, 1);
  db.close();
  assert.equal(runCatalogConversion(f.options).outcome, 'committed');
  const final = openCatalog(f.path);
  try {
    assert.equal(final.prepare('SELECT delivered_at FROM vault_rewards').get().delivered_at, null);
    assert.equal(final.prepare('SELECT count(*) n FROM user_inventory').get().n, 1);
    let sends = 0;
    const client = { channels: { fetch: async () => ({ send: async payload => {
      sends++;
      const message = { id: '502', ...payload, edit: async change => Object.assign(message, change) };
      return message;
    } }) } };
    await recoverVaultRewards(final, client, { now: () => 456 });
    await recoverVaultRewards(final, client, { now: () => 456 });
    assert.equal(final.prepare('SELECT delivered_at FROM vault_rewards').get().delivered_at, 456);
    assert.equal(final.prepare('SELECT count(*) n FROM user_inventory').get().n, 1);
    assert.equal(sends, 1);
  } finally { final.close(); }
});

test('another process holding BEGIN IMMEDIATE refuses conversion without mutation', async t => {
  const f = fixture(t), before = snapshot(f.path);
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import {DatabaseSync} from 'node:sqlite';
    const db=new DatabaseSync(process.argv[1]); db.exec('BEGIN IMMEDIATE');
    process.stdout.write('locked\\n'); setInterval(()=>{},1000);
  `, f.path], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await once(child.stdout, 'data');
  assert.throws(() => runCatalogConversion(f.options), /locked|busy/);
  const exited = once(child, 'exit'); child.kill(); await exited;
  assert.deepEqual(snapshot(f.path), before);
  assert.equal(records(f).at(-1).outcome, 'not-committed');
});

test('report exclusive precreation refuses existing/missing resources before any DB writes', t => {
  const f = fixture(t), before = snapshot(f.path), bytes = fs.readFileSync(f.path);
  fs.writeFileSync(f.options.report, 'existing evidence');
  assert.throws(() => runCatalogConversion(f.options), /EEXIST/);
  assert.equal(fs.readFileSync(f.options.report, 'utf8'), 'existing evidence');
  assert.throws(() => runCatalogConversion({ ...f.options, report: join(f.dir, 'missing', 'evidence') }), /ENOENT/);
  assert.deepEqual(snapshot(f.path), before);
  assert.deepEqual(fs.readFileSync(f.path), bytes);
});

for (const failedSync of [1, 2, 3]) test(`evidence fsync failure at record ${failedSync} reports honest outcome`, t => {
  const f = fixture(t), before = snapshot(f.path);
  const original = fs.fsyncSync; let calls = 0;
  const mock = t.mock.method(fs, 'fsyncSync', fd => {
    if (++calls === failedSync) throw Error('synthetic evidence failure');
    return original(fd);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => runCatalogConversion(f.options), error => {
      if (failedSync === 3) assert.match(error.message, /outcome=committed.*NEVER assume rollback/);
      else assert.match(error.message, /synthetic evidence failure/);
      return true;
    });
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
  if (failedSync < 3) assert.deepEqual(snapshot(f.path), before);
  else assert.equal(snapshot(f.path).version, 12);
  assert.equal(records(f)[0].outcome, 'uncertain');
});

test('supported SQLite backup captures live WAL, independent restore retains authoritative v10 after working-copy commit', async t => {
  const f = fixture(t);
  const source = new DatabaseSync(f.path);
  source.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
    INSERT INTO character_wishes VALUES('g','w',99,123);`);
  assert.ok(fs.statSync(`${f.path}-wal`).size > 0);
  const backupPath = join(f.dir, 'untouched-recovery.sqlite');
  await backup(source, backupPath);
  const expected = snapshot(f.path); source.close();
  const recovery = new DatabaseSync(backupPath, { readOnly: true });
  const restorePath = join(f.dir, 'independent-restore.sqlite');
  try { await backup(recovery, restorePath); } finally { recovery.close(); }
  assert.deepEqual(snapshot(restorePath), expected);
  runCatalogConversion(f.options);
  assert.equal(snapshot(f.path).version, 12);
  assert.deepEqual(snapshot(backupPath), expected);
  assert.deepEqual(snapshot(restorePath), expected);
  const restored = new DatabaseSync(restorePath, { readOnly: true });
  try {
    assert.equal(restored.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(restored.prepare('SELECT character_id FROM character_wishes').get().character_id, 99);
    assert.equal(restored.prepare('SELECT owner_id FROM marriages').get().owner_id, 'u');
  } finally { restored.close(); }
});
