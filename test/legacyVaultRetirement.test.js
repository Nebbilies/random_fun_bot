import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { syncBuiltinESMExports } from 'node:module';
import { installEmptyFinalCatalog } from '../lib/catalogFinalSchema.js';
import { createVaultAbandonmentEntry, LEGACY_VAULT_ABANDONMENT_KEY as key } from '../lib/legacyVaultAbandonment.js';
import { inspectCatalogRuntimeRestart } from '../lib/catalogRuntimeRecovery.js';
import { cleanupRolls } from '../lib/characterRolls.js';
import { runVaultRetirement, parseVaultRetirementArgs } from '../lib/legacyVaultRetirement.js';

function fixture(t) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'vault-retirement-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const database = join(directory, 'catalog.sqlite');
  const db = new DatabaseSync(database);
  installEmptyFinalCatalog(db);
  const entries = [17317, 17358].map(id => {
    db.prepare(`INSERT INTO character_rolls(id,guild_id,channel_id,command_message_id,character_id,character_name,state,published_at)
      VALUES(?,'1','10',?,'0','vault','vault',100)`).run(id, String(id + 100000));
    db.prepare('INSERT INTO roll_notices VALUES(?,?)').run(id, '101');
    db.prepare("INSERT INTO affection_legacy_sources VALUES('roll',?,0)").run(String(id + 100000));
    return createVaultAbandonmentEntry(db, db.prepare('SELECT * FROM character_rolls WHERE id=?').get(id), {
      reason: 'Reviewed abandonment', operator: 'synthetic', operationId: '12345678-1234-4123-8123-123456789abc',
      sourceSha256: 'a'.repeat(64), acknowledgedAt: 1000,
    });
  });
  db.prepare('INSERT INTO catalog_meta VALUES(?,?)').run(key, JSON.stringify({ version: 1, entries }));
  db.prepare("INSERT INTO catalog_meta VALUES('unrelated','preserved')").run();
  db.prepare("INSERT INTO user_inventory(guild_id,user_id,item_id,charges,acquired_at,expires_at) VALUES('1','101','hourglass_of_haste',1,'now',?)").run(Date.now() + 86400000);
  db.close();
  return { database, backup: join(directory, 'backup.sqlite'), archive: join(directory, 'archive.jsonl'),
    'roll-ids': '17317,17358', operator: 'synthetic', reason: 'Retire reviewed historical exceptions', 'writers-stopped': true, apply: true };
}
function contents(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all()
    .map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all().map(row => ({ ...row }))])); }
  finally { db.close(); }
}

test('retirement archives and removes only reviewed legacy records, retaining restart and cleanup readiness', async t => {
  const options = fixture(t), before = contents(options.database);
  const result = await runVaultRetirement(options);
  assert.equal(result.outcome, 'committed');
  assert.deepEqual(result.rollIds, [17317, 17358]);
  assert.deepEqual(contents(options.backup), before);
  const expected = structuredClone(before);
  expected.character_rolls = [];
  expected.roll_notices = [];
  expected.catalog_meta = expected.catalog_meta.filter(row => row.key !== key);
  assert.deepEqual(contents(options.database), expected);
  const archive = fs.readFileSync(options.archive, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(archive[0].rolls.length, 2);
  assert.equal(archive[0].notices.length, 2);
  assert.equal(archive[0].contract, before.catalog_meta.find(row => row.key === key).value);
  assert.match(archive[0].backupSha256, /^[a-f0-9]{64}$/);
  assert.equal(archive.at(-1).outcome, 'committed');
  const db = new DatabaseSync(options.database);
  assert.equal(inspectCatalogRuntimeRestart(db).ready, true);
  assert.equal(cleanupRolls(db), 0);
  db.close();
  assert.equal((await runVaultRetirement(options)).outcome, 'not-applicable');
});

test('default dry-run is read-only and applying requires explicit operational acknowledgements', async t => {
  const options = fixture(t), before = contents(options.database);
  const report = await runVaultRetirement({ database: options.database, 'roll-ids': options['roll-ids'] });
  assert.equal(report.outcome, 'dry-run');
  assert.deepEqual(contents(options.database), before);
  assert.equal(fs.existsSync(options.backup), false);
  assert.equal(fs.existsSync(options.archive), false);
  assert.throws(() => parseVaultRetirementArgs(['--database', options.database, '--roll-ids', '17317,17358', '--apply']), /writers-stopped/);
  for (const ids of ['17317', '17317,17317', '16994,17317', '17317,17358,16994']) {
    assert.throws(() => parseVaultRetirementArgs(['--database', options.database, '--roll-ids', ids]), /reviewed/);
  }
});

for (const damage of ['malformed', 'fingerprint', 'missing-row', 'unexpected-entry', 'session', 'reward', 'delivery', 'no-contract']) {
  test(`${damage} evidence or bindings refuse retirement without changing the database`, async t => {
    const options = fixture(t), db = new DatabaseSync(options.database);
    const contract = JSON.parse(db.prepare('SELECT value FROM catalog_meta WHERE key=?').get(key).value);
    if (damage === 'malformed') db.prepare('UPDATE catalog_meta SET value=? WHERE key=?').run('{', key);
    if (damage === 'fingerprint') { contract.entries[0].fingerprint = '0'.repeat(64); db.prepare('UPDATE catalog_meta SET value=? WHERE key=?').run(JSON.stringify(contract), key); }
    if (damage === 'missing-row') db.prepare('DELETE FROM character_rolls WHERE id=17317').run();
    if (damage === 'unexpected-entry') { contract.entries.pop(); db.prepare('UPDATE catalog_meta SET value=? WHERE key=?').run(JSON.stringify(contract), key); }
    if (damage === 'session') {
      // A binding is evidence even if it cannot be interpreted as a valid modern session.
      db.exec('PRAGMA ignore_check_constraints=ON');
      db.prepare(`INSERT INTO vault_sessions(vault_id,command_message_id,paid_roll_id,guild_id,user_id,channel_id,state,created_at,deadline,captured_json,remaining)
        VALUES('bound','117317','117317','1','101','10','unopened',0,1,'{}',1)`).run();
    }
    if (damage === 'reward') db.prepare(`INSERT INTO vault_rewards(vault_id,guild_id,user_id,channel_id,source_message_id,original_json,state,created_at)
      VALUES('bound','1','101','10','117317','{}','delivered',0)`).run();
    if (damage === 'delivery') db.prepare("UPDATE character_rolls SET message_id='500' WHERE id=17317").run();
    if (damage === 'no-contract') db.prepare('DELETE FROM catalog_meta WHERE key=?').run(key);
    db.close();
    const before = contents(options.database);
    await assert.rejects(runVaultRetirement(options), /evidence|binding|entries|Inconsistent|schema|constraint/i);
    assert.deepEqual(contents(options.database), before);
    assert.equal(fs.existsSync(options.backup), false);
    assert.equal(fs.existsSync(options.archive), false);
  });
}

test('existing files and database/sidecar aliases cannot be overwritten', async t => {
  const options = fixture(t), before = contents(options.database);
  fs.writeFileSync(options.backup, 'preserve');
  await assert.rejects(runVaultRetirement(options), /separate new paths/);
  assert.equal(fs.readFileSync(options.backup, 'utf8'), 'preserve');
  await assert.rejects(runVaultRetirement({ ...options, backup: options.database }), /separate new paths/);
  await assert.rejects(runVaultRetirement({ ...options, backup: options.database + '-wal' }), /separate new paths/);
  assert.deepEqual(contents(options.database), before);
});

for (const phase of ['backup', 'before-retirement', 'validated-before-commit', 'committed']) {
  test(`${phase} filesystem failure has an honest outcome and preserves recoverable evidence`, async t => {
    const options = fixture(t), before = contents(options.database);
    const write = fs.writeSync, link = fs.linkSync;
    let failed = false;
    const mock = phase === 'backup'
      ? t.mock.method(fs, 'linkSync', (...args) => { if (args[1] === options.backup) throw Error('synthetic backup failure'); return link(...args); })
      : t.mock.method(fs, 'writeSync', (...args) => {
        const text = Buffer.isBuffer(args[1]) ? args[1].toString() : String(args[1]);
        if (!failed && (phase === 'committed' ? text.includes('"outcome":"committed"') : text.includes(`"phase":"${phase}"`))) {
          failed = true; throw Error('synthetic archive failure');
        }
        return write(...args);
      });
    syncBuiltinESMExports();
    try {
      await assert.rejects(runVaultRetirement(options), error => {
        assert.equal(error.operationReport.outcome, phase === 'committed' ? 'uncertain' : 'rolled-back');
        if (phase === 'committed') assert.match(error.message, /NEVER assume rollback/);
        return true;
      });
    } finally { mock.mock.restore(); syncBuiltinESMExports(); }
    if (phase === 'committed') {
      assert.deepEqual(contents(options.database).character_rolls, []);
      assert.deepEqual(contents(options.backup), before);
      const archive = fs.readFileSync(options.archive, 'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(archive[0].rolls.length, 2);
      assert.equal(archive.at(-1).outcome, 'uncertain');
    } else assert.deepEqual(contents(options.database), before);
  });
}

test('archive fsync failure prevents commit', async t => {
  const options = fixture(t), before = contents(options.database);
  const write = fs.writeSync, sync = fs.fsyncSync;
  let armed = false;
  const writing = t.mock.method(fs, 'writeSync', (...args) => {
    if (Buffer.isBuffer(args[1]) && args[1].toString().includes('"phase":"validated-before-commit"')) armed = true;
    return write(...args);
  });
  const syncing = t.mock.method(fs, 'fsyncSync', (...args) => {
    if (armed) { armed = false; throw Error('synthetic fsync failure'); }
    return sync(...args);
  });
  syncBuiltinESMExports();
  try { await assert.rejects(runVaultRetirement(options), /outcome=rolled-back/); }
  finally { writing.mock.restore(); syncing.mock.restore(); syncBuiltinESMExports(); }
  assert.deepEqual(contents(options.database), before);
});
