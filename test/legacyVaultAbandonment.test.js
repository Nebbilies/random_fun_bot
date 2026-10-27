import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { initializeLegacyCatalog, openCatalogReadOnly } from '../lib/catalogDb.js';
import { runVaultAbandonment, parseVaultAbandonmentArgs } from '../lib/legacyVaultAbandonmentOperation.js';
import { runCatalogConversion } from '../lib/catalogConversionOperation.js';
import { inspectCatalogRuntimeRestart } from '../lib/catalogRuntimeRecovery.js';
import { inventoryCharacterIdentities } from '../lib/characterIdentityMigration.js';
import { LEGACY_VAULT_ABANDONMENT_KEY as key, ABANDONABLE_VAULT_ROLL_IDS as ids } from '../lib/legacyVaultAbandonment.js';
import { settleCharacterMigration } from '../lib/characterMigrationSettlement.js';
import { addItemToInventory, getInventory, getInventoryCapacity } from '../lib/itemStorage.js';
import { getResolvedItemDefinition, ITEM_TIERS } from '../lib/itemRoster.js';
import { revealVaultReward } from '../lib/vaultRewards.js';
function fixture(t) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'vault-abandonment-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, 'source.sqlite'), output = join(dir, 'clone.sqlite');
  const db = new DatabaseSync(source); initializeLegacyCatalog(db);
  db.exec(`INSERT INTO catalog_meta VALUES('game_maintenance','drain');
    INSERT INTO characters(id,rank,favourites,name_full) VALUES(7,1,50,'Synthetic');
    INSERT INTO character_identities VALUES(7,'Synthetic',NULL);
    INSERT INTO marriages(guild_id,character_id,owner_id,married_at) VALUES('1',7,'101','date');
    INSERT INTO roll_allowances(guild_id,user_id,period,used) VALUES('1','101','synthetic-period',6);`);
  for (const id of ids) db.prepare(`INSERT INTO character_rolls(id,guild_id,channel_id,command_message_id,message_id,character_id,character_name,state)
    VALUES(?,'1','10',?,?,0,'Vault','vault')`).run(id, String(id + 100000), id % 2 ? null : String(id + 200000));
  db.exec(`INSERT INTO character_rolls(guild_id,channel_id,command_message_id,message_id,character_id,character_name,state,published_at,expires_at)
    VALUES('1','10','999001','999002',7,'Synthetic','open',1,2)`);
  while (getInventory(db, '1', '101').length < getInventoryCapacity(db, '1', '101')) addItemToInventory(db, '1', '101', 'hourglass_of_haste');
  revealVaultReward(db, { vaultId: 'overflow', guildId: '1', userId: '101', channelId: '20', sourceMessageId: '999003',
    outcome: { tier: 'common', tierData: ITEM_TIERS.common, item: getResolvedItemDefinition(db, '1', 'hourglass_of_haste') }, now: 100 });
  settleCharacterMigration(db, { offline: true, backupVerified: true, retainOverflow: true, now: 1000 });
  const rows = db.prepare("SELECT * FROM character_rolls WHERE state='vault' ORDER BY id").all();
  const inventory = db.prepare('SELECT * FROM user_inventory').all(), rewards = db.prepare('SELECT * FROM vault_rewards').all();
  const allowances = db.prepare('SELECT * FROM roll_allowances').all();
  db.close();
  return { dir, source, output, rows, inventory, rewards, allowances, options: { database: source, output, 'roll-ids': ids.join(','),
    'abandon-without-refund-or-replacement': true, 'offline-working-copy': true, 'writers-stopped': true,
    'backup-restore-verified': true, reason: 'Explicitly abandon ambiguous legacy vaults, no compensation', operator: 'synthetic-operator', report: join(dir, 'abandon.jsonl') } };
}
function convert(f) {
  return runCatalogConversion({ database: f.output, commit: true, 'offline-working-copy': true,
    'backup-restore-verified': true, 'writers-stopped': true, 'conversations-drained': true,
    'source-app-commit': 'abcdef1', 'target-app-commit': 'abcdef2', 'source-runtime': 'node22', 'target-runtime': 'node22',
    'backup-ref': 'synthetic', 'restore-ref': 'synthetic', 'rehearsal-ref': 'synthetic', report: join(f.dir, 'conversion.jsonl') });
}

test('latest-snapshot approval is limited to vaults 17317 and 17358', t => {
  const f = fixture(t);
  const args = ids => Object.entries({ ...f.options, 'roll-ids': ids }).flatMap(([key, value]) =>
    value === true ? [`--${key}`] : [`--${key}`, String(value)]);
  assert.doesNotThrow(() => parseVaultAbandonmentArgs(args('17317,17358')));
  for (const id of [17316, 17318, 17357, 17359]) {
    assert.throws(() => parseVaultAbandonmentArgs(args(String(id))), /explicitly authorized/);
  }
});
test('file-backed abandonment -> guarded conversion -> readonly restart, original state and durable assets retained', async t => {
  const f = fixture(t), bytes = fs.readFileSync(f.source);
  assert.equal((await runVaultAbandonment(f.options)).outcome, 'published');
  assert.deepEqual(fs.readFileSync(f.source), bytes);
  assert.equal(convert(f).outcome, 'committed');
  const db = openCatalogReadOnly(f.output);
  try {
    assert.equal(inspectCatalogRuntimeRestart(db).ready, true);
    assert.deepEqual(db.prepare('SELECT * FROM user_inventory').all(), f.inventory);
    assert.deepEqual(db.prepare('SELECT * FROM roll_allowances').all(), f.allowances);
    assert.deepEqual(db.prepare('SELECT * FROM vault_rewards').all(), f.rewards);
    for (const row of db.prepare("SELECT * FROM character_rolls WHERE state='vault' ORDER BY id").all()) {
      const { character_snapshot_json, ...legacy } = row;
      assert.deepEqual({ ...legacy, character_id: Number(legacy.character_id) }, { ...f.rows.find(r => r.id === row.id) });
    }
    assert.equal(db.prepare('SELECT owner_id FROM marriages').get().owner_id, '101');
    assert.equal(db.prepare("SELECT count(*) n FROM character_rolls WHERE state='closed'").get().n, 1);
  } finally { db.close(); }
});
for (const variant of ['malformed', 'stale', 'forged', 'provenance', 'unselected']) test(`${variant} evidence cannot bypass guarded conversion`, async t => {
  const f = fixture(t);
  if (variant === 'unselected') f.options['roll-ids'] = String(ids[0]);
  await runVaultAbandonment(f.options);
  const db = new DatabaseSync(f.output);
  if (variant === 'malformed') db.prepare('UPDATE catalog_meta SET value=? WHERE key=?').run('{}', key);
  if (variant === 'stale') db.prepare('UPDATE character_rolls SET message_id=? WHERE id=?').run('123456789', ids[0]);
  if (variant === 'forged' || variant === 'provenance') {
    const contract = JSON.parse(db.prepare('SELECT value FROM catalog_meta WHERE key=?').get(key).value);
    if (variant === 'forged') contract.entries[0].acknowledgement = 'refund';
    else contract.entries[0].sourceSha256 = '0'.repeat(64);
    db.prepare('UPDATE catalog_meta SET value=? WHERE key=?').run(JSON.stringify(contract), key);
  }
  if (variant !== 'unselected') assert.ok(inventoryCharacterIdentities(db).blockers.some(s => s.includes('abandonment')));
  db.close();
  assert.throws(() => convert(f), /abandonment|vault_session_missing/);
  const ro = new DatabaseSync(f.output, { readOnly: true });
  assert.equal(ro.prepare('PRAGMA user_version').get().user_version, 10); ro.close();
});
test('runtime rechecks stale evidence and refuses bound session even after conversion', async t => {
  const f = fixture(t); await runVaultAbandonment(f.options); convert(f);
  const db = new DatabaseSync(f.output);
  db.prepare(`INSERT INTO vault_sessions(vault_id,command_message_id,guild_id,user_id,channel_id,remaining,captured_json,deadline,created_at,state)
    VALUES('bound',?,'1','101','10',0,'{}',100,1,'revealed')`).run(f.rows[0].command_message_id);
  assert.equal(inspectCatalogRuntimeRestart(db).ready, false);
  db.close();
});
test('strict acknowledgements, IDs, aliases, hardlinks and exclusive output/report', async t => {
  assert.throws(() => parseVaultAbandonmentArgs(['--database', 'x']), /Required/);
  const f = fixture(t), before = fs.readFileSync(f.source);
  for (const change of [{ output: f.source }, { report: f.source }, { 'roll-ids': '1' }, { 'roll-ids': `${ids[0]},${ids[0]}` }]) {
    await assert.rejects(runVaultAbandonment({ ...f.options, ...change }));
  }
  const alias = join(f.dir, 'hardlink.sqlite'); fs.linkSync(f.source, alias);
  await assert.rejects(runVaultAbandonment({ ...f.options, database: alias }), /hardlink/);
  fs.unlinkSync(alias);
  fs.writeFileSync(f.output, 'existing');
  await assert.rejects(runVaultAbandonment(f.options));
  assert.deepEqual(fs.readFileSync(f.source), before);
});
