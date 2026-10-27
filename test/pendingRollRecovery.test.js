import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFinalCatalog, openCatalog } from '../lib/catalogDb.js';
import { reserveRoll, recoverRolls } from '../lib/characterRolls.js';
import { addActiveBuff } from '../lib/itemStorage.js';
import { deliverReservedRoll, recoverPendingRollDeliveries } from '../lib/rollDelivery.js';

const id = '12345678-1234-4123-8123-123456789abc';
const now = 1_800_000_000_000;
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pending-roll-'));
  const path = join(dir, 'catalog.sqlite');
  let db = createFinalCatalog(path);
  db.prepare("INSERT INTO character_identities(id,creation_method) VALUES (?,'manual')").run(id);
  db.prepare(`INSERT INTO characters(id,rank,favourites,tie_order,likes_source,name_full,gender,image_url)
    VALUES (?,1,2000,1,'generated','Original','female','https://example.com/original.png')`).run(id);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { get db() { return db; }, reopen() {
    db.close();
    db = openCatalog(path);
  } };
}
function reserve(db) {
  return reserveRoll(db, { guildId: '1', channelId: '10', commandMessageId: '100', userId: '101',
    pool: 'w', now, random: () => 0 });
}
function fake(send) { return { channels: { fetch: async () => ({ id: '10', guildId: '1', send }) } }; }

test('paid pending survives reopen, transient failure, edits and repeated recovery without recharging', async t => {
  const f = fixture(t);
  const buff = addActiveBuff(f.db, '1', '101', 'four_leaf_clover', null, null, 3);
  const reserved = reserve(f.db);
  const windows = f.db.prepare('SELECT rules_json FROM character_rolls').get().rules_json;
  f.reopen();
  recoverRolls(f.db, now + 1);
  assert.equal(f.db.prepare('SELECT state FROM character_rolls').get().state, 'pending');
  let attempts = 0;
  const failed = await recoverPendingRollDeliveries(f.db, fake(async () => { attempts++; throw new Error('temporary'); }));
  assert.equal(failed[0].status, 'pending');
  f.reopen();
  f.db.prepare("UPDATE characters SET name_full='Edited',favourites=99,image_url='https://example.com/edited.png' WHERE id=?").run(id);
  f.db.prepare(`INSERT INTO game_config_overrides(scope_id,key,value_json) VALUES ('1','windows.claimMs','120000')
    ON CONFLICT(scope_id,key) DO UPDATE SET value_json=excluded.value_json`).run();
  const client = fake(async payload => {
    attempts++;
    assert.equal(payload.enforceNonce, true);
    assert.ok(payload.nonce.length <= 25);
    const rendered = JSON.stringify(payload);
    assert.match(rendered, /Original/);
    assert.doesNotMatch(rendered, /Edited|edited.png/);
    assert.match(rendered, /original.png/);
    return { id: '500' };
  });
  const [a, b] = await Promise.all([
    deliverReservedRoll(f.db, client, { rollId: reserved.rollId, now: () => now + 10 }),
    deliverReservedRoll(f.db, client, { rollId: reserved.rollId, now: () => now + 10 }),
  ]);
  assert.deepEqual(a, b);
  assert.equal(a.status, 'published');
  f.reopen();
  assert.deepEqual(await recoverPendingRollDeliveries(f.db, client), []);
  assert.equal(attempts, 2);
  assert.equal(f.db.prepare('SELECT used FROM roll_allowances').get().used, 1);
  assert.equal(f.db.prepare('SELECT remaining_rolls FROM active_user_buffs WHERE id=?').get(buff.id).remaining_rolls, 2);
  const roll = f.db.prepare('SELECT * FROM character_rolls').get();
  assert.equal(roll.rules_json, windows);
  assert.equal(roll.expires_at, now + 10 + JSON.parse(windows).claimMs);
});

test('acknowledgement commits before publication and restart binds without another send', async t => {
  const f = fixture(t);
  const reservation = reserve(f.db);
  f.db.exec(`CREATE TRIGGER stop_publish BEFORE UPDATE OF state ON character_rolls
    WHEN NEW.state='open' BEGIN SELECT RAISE(ABORT,'publish interrupted'); END`);
  let sends = 0;
  const client = fake(async () => { sends++; return { id: '501' }; });
  await assert.rejects(deliverReservedRoll(f.db, client, { rollId: reservation.rollId, now: () => now }), /publish interrupted/);
  assert.equal(f.db.prepare('SELECT state FROM character_rolls').get().state, 'pending');
  assert.equal(f.db.prepare('SELECT phase FROM roll_delivery').get().phase, 'acknowledged');
  // Test-only fault injection is not authoritative schema; remove it before
  // normal reopen, retaining the independently committed acknowledgement.
  f.db.exec('DROP TRIGGER stop_publish');
  f.reopen();
  assert.equal((await deliverReservedRoll(f.db, client, { rollId: reservation.rollId })).status, 'published');
  assert.equal(sends, 1);
  assert.equal(f.db.prepare('SELECT message_id FROM character_rolls').get().message_id, '501');
});

test('corrupt captured windows leave pending rather than using live configuration', async t => {
  const f = fixture(t);
  reserve(f.db);
  f.db.exec('UPDATE character_rolls SET rules_json=NULL');
  const result = await recoverPendingRollDeliveries(f.db, fake(async () => { assert.fail('must not send'); }));
  assert.equal(result[0].status, 'pending');
  assert.equal(f.db.prepare('SELECT state FROM character_rolls').get().state, 'pending');
});
