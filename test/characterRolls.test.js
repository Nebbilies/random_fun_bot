import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCatalog } from '../lib/catalogDb.js';
import { claimRoll, failRoll, getRoll, markClaimNotice, nextClaimReset, publishRoll, recoverRolls, reserveRoll } from '../lib/characterRolls.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'character-rolls-'));
  const path = join(dir, 'catalog.sqlite');
  const db = openCatalog(path);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  db.exec(`INSERT INTO characters (id,rank,favourites,name_full,gender) VALUES
    (1,1,100,'Female','Female'),(2,2,90,'Male','Male'),
    (3,3,80,'Other','Non-binary'),(4,4,70,'Unknown',NULL)`);
  return db;
}

const midnight = Date.parse('2026-10-15T17:00:00Z');
function reserve(db, messageId, pool = 'w', user = '101', guild = '1', now = midnight, random = () => 0) {
  return reserveRoll(db, { guildId: guild, channelId: '10', commandMessageId: messageId,
    userId: user, pool, now, random });
}

test('pools, shared hourly quota, and no carryover', (t) => {
  const db = fixture(t);
  assert.equal(reserve(db, '100', 'w').character.name_full, 'Female');
  assert.equal(reserve(db, '101', 'h').character.name_full, 'Male');
  assert.equal(reserve(db, '112', 'w', '102', '1', midnight, () => 0.5).character.name_full, 'Other');
  assert.equal(reserve(db, '113', 'h', '102', '1', midnight, () => 0.99).character.name_full, 'Unknown');
  for (let i = 2; i < 7; i++) assert.equal(reserve(db, String(100 + i)).status, 'reserved');
  assert.equal(reserve(db, '107').status, 'exhausted');
  assert.equal(reserve(db, '100').status, 'duplicate');
  assert.equal(reserve(db, '108', 'h', '101', '1', midnight + 3_600_000).status, 'reserved');
  assert.equal(reserve(db, '109', 'w', '102').status, 'reserved');
  assert.equal(reserve(db, '110', 'w', '101', '2').status, 'reserved');
  db.exec("INSERT INTO marriages (guild_id,character_id,owner_id,married_at) VALUES ('3',1,'111','now'),('3',3,'111','now'),('3',4,'111','now')");
  assert.equal(reserve(db, '111', 'w', '101', '3').status, 'empty');
});

test('one claim per three-hour period and duplicate cards close forever', (t) => {
  const db = fixture(t);
  const a = reserve(db, '200');
  const b = reserve(db, '201');
  publishRoll(db, a.rollId, '500', midnight);
  publishRoll(db, b.rollId, '501', midnight);
  assert.equal(claimRoll(db, { guildId: '1', channelId: '10', messageId: '500', userId: '101', now: midnight + 1 }).status, 'married');
  assert.equal(claimRoll(db, { guildId: '1', channelId: '10', messageId: '501', userId: '102', now: midnight + 2 }).status, 'closed');
  db.exec("DELETE FROM marriages WHERE guild_id = '1' AND character_id = 1");
  assert.equal(claimRoll(db, { guildId: '1', channelId: '10', messageId: '501', userId: '102', now: midnight + 3 }).status, 'closed');
  const c = reserve(db, '202', 'h');
  publishRoll(db, c.rollId, '502', midnight);
  assert.equal(claimRoll(db, { guildId: '1', channelId: '10', messageId: '502', userId: '101', now: midnight + 4 }).status, 'exhausted');
  assert.equal(claimRoll(db, { guildId: '1', channelId: '10', messageId: '502', userId: '101', now: midnight + 3 * 3_600_000 }).status, 'expired');
});

test('expiry, failed delivery, and saved roll state', (t) => {
  const db = fixture(t);
  const a = reserve(db, '300');
  publishRoll(db, a.rollId, '600', midnight);
  assert.equal(getRoll(db, '1', '10', '600').expiresAt, midnight + 60_000);
  assert.equal(claimRoll(db, { guildId: '1', channelId: '10', messageId: '600', userId: '101', now: midnight + 60_000 }).status, 'expired');
  const b = reserve(db, '301');
  failRoll(db, b.rollId);
  assert.equal(getRoll(db, '1', '10', '301'), null);
});

test('claim crossing the Vietnam three-hour boundary uses the new allowance', (t) => {
  const db = fixture(t);
  const before = midnight + 3 * 3_600_000 - 30_000;
  const a = reserve(db, '401', 'w', '101', '1', before);
  publishRoll(db, a.rollId, '701', before);
  assert.equal(claimRoll(db, { guildId: '1', channelId: '10', messageId: '701', userId: '101', now: before + 1 }).status, 'married');
  const b = reserve(db, '402', 'h', '101', '1', before);
  publishRoll(db, b.rollId, '702', before);
  assert.equal(claimRoll(db, { guildId: '1', channelId: '10', messageId: '702', userId: '101', now: before + 2 }).status, 'exhausted');
  assert.equal(nextClaimReset(before), midnight + 3 * 3_600_000);
  assert.equal(claimRoll(db, { guildId: '1', channelId: '10', messageId: '702', userId: '101', now: before + 30_000 }).status, 'married');
});

test('recovery preserves active deadline and notice deduplication', (t) => {
  const db = fixture(t);
  const a = reserve(db, '501');
  publishRoll(db, a.rollId, '801', midnight);
  const b = reserve(db, '502');
  assert.equal(recoverRolls(db, midnight + 30_000).length, 1);
  assert.equal(getRoll(db, '1', '10', '801').expiresAt, midnight + 60_000);
  assert.equal(markClaimNotice(db, a.rollId, '102'), true);
  assert.equal(markClaimNotice(db, a.rollId, '102'), false);
  assert.equal(db.prepare('SELECT state FROM character_rolls WHERE id = ?').get(b.rollId)?.state, 'failed');
});

test('version 4 upgrade preserves existing marriage and prefix', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'roll-migrate-'));
  const path = join(dir, 'catalog.sqlite');
  let db = openCatalog(path);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  db.exec("INSERT INTO characters (id,rank,favourites,name_full) VALUES (1,1,1,'One'); INSERT INTO marriages (guild_id,character_id,owner_id,married_at) VALUES ('1',1,'101','now'); INSERT INTO guild_prefixes (guild_id,prefix) VALUES ('1','?'); PRAGMA user_version = 4");
  db.close();
  db = openCatalog(path);
  assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 5);
  assert.equal(db.prepare("SELECT owner_id FROM marriages WHERE guild_id = '1'").get()?.owner_id, '101');
  assert.equal(db.prepare("SELECT prefix FROM guild_prefixes WHERE guild_id = '1'").get()?.prefix, '?');
});
