import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCatalog } from '../lib/catalogDb.js';
import { migrateCharacterIdentities } from '../lib/characterIdentityMigration.js';
import { initializeCatalogReleaseSchema } from '../lib/catalogReleaseSchema.js';
import { sirensCall } from '../lib/items/sirensCall.js';
import { startForcedEscape } from '../lib/characterRollRuntime.js';
import { loadRollCharacterSnapshot, refreshEscapeRoll } from '../lib/characterRolls.js';

const now = 10_000;
function fixture(t, { file = ':memory:', legacy = false } = {}) {
  const db = openCatalog(file);
  t.after(() => { if (db.isOpen) db.close(); });
  db.exec(`INSERT INTO characters(id,rank,favourites,name_full,image_url,anime_titles,gender)
    VALUES(12,1,1234,'Original name','https://example.invalid/old.png','["Old anime"]','Female');
    INSERT INTO character_identities SELECT id,name_full,image_url FROM characters;`);
  if (!legacy) {
    migrateCharacterIdentities(db, { dryRun: false, targetVersion: 11 });
    initializeCatalogReleaseSchema(db);
    db.exec(`UPDATE character_identities SET creation_method='manual';
      DELETE FROM character_sources;
      UPDATE characters SET likes_source='generated';`);
  }
  const id = db.prepare('SELECT id FROM characters').get().id;
  db.prepare(`INSERT INTO marriages(guild_id,character_id,owner_id,married_at) VALUES('1',?,'101','original')`).run(id);
  db.prepare(`INSERT INTO tag_decisions(character_id,status,tag_name,source,updated_at)
    VALUES(?,'approve','original_tag','manual','original')`).run(id);
  return { db, id };
}
function siren(db) {
  const result = sirensCall.execute({ db, guildId: '1', userId: '102', channelId: '10',
    args: ['<@101>'], random: () => 0, now });
  assert.equal(result.success, true);
  return result.escapeAttempt;
}
function edit(db) {
  db.exec(`UPDATE tag_decisions SET tag_name='edited_tag';
    UPDATE characters SET name_full='Edited name',rank=999,favourites=9876,
    image_url='https://example.invalid/new.png',anime_titles='["New anime"]',gender='Male'`);
  if (db.prepare('PRAGMA table_info(characters)').all().some(c => c.name === 'likes_source')) {
    db.exec(`UPDATE characters SET likes_source='anilist'`);
  }
}
const serialize = payload => JSON.stringify(payload.components.map(c => c.toJSON()));
function delivery(db, directive, extra = {}) {
  const sent = [], edits = [], timers = [];
  const card = { id: '500', guildId: '1', channelId: '10', edit: async payload => { edits.push(serialize(payload)); } };
  const options = { db, guildId: '1', channelId: '10', ...directive,
    now: () => now, setTimer: callback => { timers.push(callback); return { unref() {} }; }, clearTimer() {},
    channel: { send: async payload => { sent.push(serialize(payload)); return card; } }, ...extra };
  return { options, sent, edits, timers };
}
function assertOld(text, generated = true) {
  assert.match(text, /Original name/);
  assert.match(text, /Old anime/);
  assert.doesNotMatch(text, /Likes|1,234|\[generated\]/);
  assert.match(text, /#1/);
  assert.doesNotMatch(text, /Edited name|9,876|#999|New anime/);
}

test('init12 manual generated Siren terms survive offline raw reopen, catalog edits, and card updates', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'forced-terms-'));
  const file = join(dir, 'catalog.sqlite');
  let { db, id } = fixture(t, { file });
  t.after(() => {
    if (db.isOpen) db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const directive = siren(db);
  const snapshot = loadRollCharacterSnapshot(db, directive.pendingRollId);
  assert.equal(snapshot.id, id);
  assert.equal(snapshot.likes_source, 'generated');
  assert.equal(snapshot.tag_name, 'original_tag');
  const windows = JSON.stringify({ claimMs: 120000, escapeProtectionMs: 30000, escapeClaimMs: 90000 });
  db.prepare('UPDATE character_rolls SET rules_json=? WHERE id=?').run(windows, directive.pendingRollId);
  edit(db);
  db.close();
  // Offline persistence test: deliberately not the normal production opener/recovery.
  db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys=ON');
  const attempt = delivery(db, directive);
  const result = await startForcedEscape(attempt.options);
  assert.equal(result.status, 'started');
  assert.deepEqual(result.character, snapshot);
  assertOld(attempt.sent[0]);
  assert.equal(db.prepare('SELECT rules_json FROM character_rolls').get().rules_json, windows);
  await attempt.timers[0]();
  assertOld(attempt.edits[0]);
  assert.deepEqual(loadRollCharacterSnapshot(db, directive.pendingRollId), snapshot);
});

test('ordinary forced creation persists captured terms before asynchronous send and retains them for updates', async t => {
  const { db, id } = fixture(t);
  const attempt = delivery(db, { ownerId: '101', characterId: id });
  let snapshot;
  attempt.options.channel.send = async payload => {
    const roll = db.prepare('SELECT id FROM character_rolls').get();
    snapshot = loadRollCharacterSnapshot(db, roll.id);
    assert.equal(snapshot.name_full, 'Original name');
    await Promise.resolve();
    edit(db);
    attempt.sent.push(serialize(payload));
    return { id: '500', guildId: '1', channelId: '10', edit: async p => attempt.edits.push(serialize(p)) };
  };
  const result = await startForcedEscape(attempt.options);
  assert.deepEqual(result.character, snapshot);
  assertOld(attempt.sent[0]);
  await attempt.timers[0]();
  assertOld(attempt.edits[0]);
});

test('malformed pending terms abort before send, cleanup, or row mutation', async t => {
  const { db } = fixture(t);
  const directive = siren(db);
  const valid = loadRollCharacterSnapshot(db, directive.pendingRollId);
  for (const bad of [{}, { ...valid, version: 999 }, { ...valid, id: '00000000-0000-4000-8000-000000000099' },
    { ...valid, name_full: 'Wrong published name' }, { ...valid, favourites: -1 }]) {
    db.prepare('UPDATE character_rolls SET character_snapshot_json=? WHERE id=?').run(JSON.stringify(bad), directive.pendingRollId);
    const before = db.prepare('SELECT * FROM character_rolls').all();
    const attempt = delivery(db, directive, { channelId: 'changed' });
    await assert.rejects(startForcedEscape(attempt.options), /snapshot/);
    assert.deepEqual(db.prepare('SELECT * FROM character_rolls').all(), before);
    assert.equal(attempt.sent.length, 0);
  }
});

test('absent pending terms capture current row once, without replacing original windows', async t => {
  const { db } = fixture(t);
  const directive = siren(db);
  db.exec('UPDATE character_rolls SET character_snapshot_json=NULL');
  edit(db);
  const attempt = delivery(db, directive);
  assert.equal((await startForcedEscape(attempt.options)).status, 'started');
  assert.equal(loadRollCharacterSnapshot(db, directive.pendingRollId).name_full, 'Edited name');
});

test('v10 without snapshot column continues delivering legacy pending Sirens', async t => {
  const { db } = fixture(t, { legacy: true });
  const directive = siren(db);
  assert.equal(loadRollCharacterSnapshot(db, directive.pendingRollId), null);
  edit(db);
  const attempt = delivery(db, directive);
  assert.equal((await startForcedEscape(attempt.options)).status, 'started');
  assert.match(attempt.sent[0], /Edited name/);
  assert.equal(loadRollCharacterSnapshot(db, directive.pendingRollId), null);
});

for (const change of ['owner', 'marriage']) {
  test(`stored terms cannot override live ${change} validation`, async t => {
    const { db, id } = fixture(t);
    const directive = siren(db);
    if (change === 'owner') db.exec(`UPDATE marriages SET owner_id='999'`);
    else {
      db.exec('DELETE FROM marriages');
      db.prepare(`INSERT INTO marriages(guild_id,character_id,owner_id,married_at)
        VALUES('1',?,'101','replacement')`).run(id);
    }
    const before = db.prepare('SELECT * FROM character_rolls').all();
    const attempt = delivery(db, directive);
    assert.equal((await startForcedEscape(attempt.options)).status, 'unknown');
    assert.equal(attempt.sent.length, 0);
    assert.deepEqual(db.prepare('SELECT * FROM character_rolls').all(), before);
  });
}

test('failed pending send remains retryable with the same captured terms', async t => {
  const { db } = fixture(t);
  const directive = siren(db);
  const original = loadRollCharacterSnapshot(db, directive.pendingRollId);
  const attempt = delivery(db, directive, { channel: { send: async () => { throw new Error('offline'); } } });
  await assert.rejects(startForcedEscape(attempt.options), /offline/);
  assert.equal(db.prepare('SELECT state FROM character_rolls').get().state, 'pending');
  edit(db);
  const retry = delivery(db, directive);
  assert.equal((await startForcedEscape(retry.options)).status, 'started');
  assertOld(retry.sent[0]);
  assert.deepEqual(loadRollCharacterSnapshot(db, directive.pendingRollId), original);
});


test('escape refresh rejects corrupt persisted terms before expiry settlement', async t => {
  const {db}=fixture(t); const directive=siren(db); const x=delivery(db,directive);
  await startForcedEscape(x.options);
  db.exec("UPDATE character_rolls SET character_snapshot_json='{}'");
  const before=db.prepare('SELECT * FROM character_rolls').all();
  assert.throws(()=>refreshEscapeRoll(db,'1','10','500',now+1000000),/snapshot/);
  assert.deepEqual(db.prepare('SELECT * FROM character_rolls').all(),before);
  assert.equal(x.edits.length,0);
});
