import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { initializeLegacyCatalog } from '../lib/catalogDb.js';
import { runVaultAbandonment } from '../lib/legacyVaultAbandonmentOperation.js';
function fixture(t) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'vault-abandon-safety-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const database = join(dir, 'source.sqlite');
  const db = new DatabaseSync(database); initializeLegacyCatalog(db);
  db.exec(`INSERT INTO character_rolls(id,guild_id,channel_id,command_message_id,character_id,character_name,state,published_at)
    VALUES(16994,'1','10','100001',0,'vault','vault',100);`); db.close();
  return { dir, database, output: join(dir, 'clone.sqlite'), report: join(dir, 'evidence.jsonl'), 'roll-ids': '16994',
    reason: 'Explicit abandonment without compensation', operator: 'synthetic',
    'abandon-without-refund-or-replacement': true, 'offline-working-copy': true,
    'writers-stopped': true, 'backup-restore-verified': true };
}
const options = f => Object.fromEntries(Object.entries(f).filter(([k]) => k !== 'dir'));
for (const record of [1, 2, 3, 4]) test(`fsync failure ${record} preserves source and honest publication outcome`, async t => {
  const f = fixture(t), bytes = fs.readFileSync(f.database);
  const original = fs.fsyncSync; let calls = 0;
  const mock = t.mock.method(fs, 'fsyncSync', fd => {
    if (++calls === record) throw Error('synthetic fsync failure');
    return original(fd);
  }); syncBuiltinESMExports();
  try {
    await assert.rejects(runVaultAbandonment(options(f)), error => {
      assert.equal(error.operationReport.outcome, record === 4 ? 'published' : 'not-published');
      if (record === 4) assert.match(error.message, /NEVER assume rollback/);
      return true;
    });
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
  assert.deepEqual(fs.readFileSync(f.database), bytes);
  assert.equal(fs.existsSync(f.output), record === 4);
});
for (const kind of ['reward', 'schema', 'wrong-state', 'mystery']) test(`${kind} provenance blocks before publication`, async t => {
  const f = fixture(t), db = new DatabaseSync(f.database);
  if (kind === 'reward') db.exec(`INSERT INTO vault_rewards(vault_id,guild_id,user_id,channel_id,source_message_id,original_json,state,created_at)
    VALUES('r','1','101','10','100001','{}','delivered',1)`);
  if (kind === 'schema') db.exec('CREATE INDEX unsupported_vault_index ON character_rolls(state)');
  if (kind === 'wrong-state') db.exec("UPDATE character_rolls SET state='closed'");
  if (kind === 'mystery') db.exec(`INSERT INTO mystery_sessions(guild_id,origin_roll_id,event_id,character_id,rank_snapshot,roller_id,event_channel_id,state,started_at,deadline_at)
    VALUES('1',16994,'x',1,1,'101','10','completed',1,2)`);
  db.close(); const bytes = fs.readFileSync(f.database);
  await assert.rejects(runVaultAbandonment(options(f)), /reward|schema|authorized|mystery/);
  assert.equal(fs.existsSync(f.output), false);
  assert.deepEqual(fs.readFileSync(f.database), bytes);
});
test('CLI requires explicit irreversible acknowledgement and produces a clone only', t => {
  const f = fixture(t), args = Object.entries(options(f)).flatMap(([k, v]) => v === true ? [`--${k}`] : [`--${k}`, v]);
  const missing = args.filter(v => v !== '--abandon-without-refund-or-replacement');
  assert.notEqual(spawnSync(process.execPath, ['scripts/abandonLegacyVaultRolls.js', ...missing]).status, 0);
  assert.equal(fs.existsSync(f.output), false);
  const child = spawnSync(process.execPath, ['scripts/abandonLegacyVaultRolls.js', ...args], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).outcome, 'published');
});
