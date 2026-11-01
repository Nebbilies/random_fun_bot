import test from 'node:test';
import { once } from 'node:events';
import { createReviewServer } from '../web/reviewCharacterTags.js';
import { authConfig, login } from './helpers/portalAuth.js';
import { onRollReport } from '../lib/characterRollRuntime.js';
import assert from 'node:assert/strict';
import { openCatalog } from '../lib/catalogDb.js';
import { convertLegacyCatalogToFinal } from '../lib/characterIdentityMigration.js';
import { previewCatalogMutation, confirmCatalogMutation } from '../lib/catalogMutations.js';
import { reportCharacterGender, genderCase } from '../lib/characterGenderReviews.js';
import { reportCharacterTag } from '../lib/catalogDb.js';
import { bindSourceCatalogStaging, publishSourceCatalog } from '../lib/sourceCatalogPublication.js';
import { CHARACTER_GENDER_DDL } from '../lib/characterGenderSchema.js';
import { FINAL_CATALOG_DDL, validateFinalCatalogSchema } from '../lib/catalogFinalSchema.js';
import { ensureFortuneCatalog } from '../lib/vaultFortuneUpgrade.js';
import { DatabaseSync } from 'node:sqlite';
import { hydrateOneBatch } from '../scripts/importCharacterCatalog.js';

const auth = { account: 'reviewer', role: 'moderator' };
function fixture(t) {
  const db = openCatalog(':memory:'); t.after(() => db.close());
  db.exec(`INSERT INTO characters(id,rank,favourites,name_full,gender) VALUES(1,1,100,'One','Male'),(2,2,50,'Two','Female');
    INSERT INTO character_identities(id,name_full) VALUES(1,'One'),(2,'Two');`);
  convertLegacyCatalogToFinal(db, { dryRun: false });
  return { db, ids: db.prepare('SELECT id FROM characters ORDER BY rank').all().map(r => r.id) };
}
function preview(db, id, action, gender) {
  const row = genderCase(db, id);
  return previewCatalogMutation(db, { ...auth, operation: 'gender_review', input: { characterId: id,
    caseId: row.caseId, revision: row.revision, action, ...(gender ? { gender } : {}) } });
}
function confirm(db, p) {
  return confirmCatalogMutation(db, { ...auth, previewId: p.previewId, payloadHash: p.payloadHash, idempotencyKey: p.previewId });
}
test('gender reports dedupe independently, corrections audit and preserve unrelated character fields', t => {
  const { db, ids: [id] } = fixture(t);
  assert.equal(reportCharacterGender(db, id, 'viewer'), true);
  assert.equal(reportCharacterGender(db, id, 'viewer'), false);
  assert.equal(reportCharacterTag(db, id, 'viewer'), true);
  assert.equal(reportCharacterGender(db, id, 'other'), true);
  const before = db.prepare('SELECT * FROM characters WHERE id=?').get(id);
  const result = confirm(db, preview(db, id, 'correct', 'Non-binary'));
  assert.equal(result.outcome, 'corrected');
  const after = db.prepare('SELECT * FROM characters WHERE id=?').get(id);
  assert.deepEqual({ ...after, gender: before.gender }, { ...before });
  assert.equal(after.gender, 'Non-binary');
  const review = db.prepare('SELECT * FROM character_gender_reviews').get();
  assert.equal(review.account, 'reviewer'); assert.equal(review.role, 'moderator');
  assert.equal(review.before_gender, 'Male'); assert.equal(review.after_gender, 'Non-binary');
  assert.equal(genderCase(db, id).reportCount, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM character_tag_reports WHERE resolved_at IS NULL').get().n, 1);
  assert.equal(reportCharacterGender(db, id, 'viewer'), true);
  assert.equal(confirm(db, preview(db, id, 'correct', 'Non-binary')).outcome, 'dismissed');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM catalog_mutations').get().n, 2);
});
test('new reports and concurrent revisions reject stale cases without partial resolution', t => {
  const { db, ids: [id, other] } = fixture(t);
  reportCharacterGender(db, id, 'first');
  const p = preview(db, id, 'correct', 'Female');
  reportCharacterGender(db, id, 'second');
  assert.throws(() => confirm(db, p), /Stale gender review/);
  assert.equal(genderCase(db, id).reportCount, 2);
  const p2 = preview(db, id, 'dismiss');
  reportCharacterGender(db, other, 'viewer');
  confirm(db, preview(db, other, 'dismiss'));
  assert.throws(() => confirm(db, p2), /Stale catalog preview/);
  assert.equal(genderCase(db, id).reportCount, 2);
});
test('override survives source refresh; restoring uses latest source gender and is audited', async t => {
  const { db, ids: [id] } = fixture(t);
  reportCharacterGender(db, id, 'viewer');
  confirm(db, preview(db, id, 'correct', 'Unknown'));
  const sourceId = db.prepare("SELECT external_id FROM character_sources WHERE character_id=? AND source='anilist'").get(id).external_id;
  db.exec('BEGIN IMMEDIATE');
  const binding = bindSourceCatalogStaging(db);
  db.prepare('INSERT INTO stage_characters(id,favourites) VALUES(?,?)').run(Number(sourceId), 200);
  db.exec('COMMIT');
  const before = db.prepare('SELECT * FROM characters WHERE id=?').get(id);
  const calls = [];
  const api = { async characterDetails(ids) {
    calls.push(ids);
    return [{ id: Number(sourceId), gender: 'Female', name: { full: 'Source renamed' }, age: '99' }];
  } };
  assert.equal(await hydrateOneBatch(db, api, () => {}, binding), true);
  assert.deepEqual(calls, [[Number(sourceId)]]);
  assert.equal(await hydrateOneBatch(db, api, () => {}, binding), false);
  db.exec('BEGIN IMMEDIATE');
  publishSourceCatalog(db, binding); db.exec('COMMIT');
  const after = db.prepare('SELECT * FROM characters WHERE id=?').get(id);
  assert.deepEqual({ ...after, favourites: before.favourites }, { ...before });
  assert.equal(genderCase(db, id).gender, 'Unknown');
  assert.equal(genderCase(db, id).sourceGender, 'Female');
  const restored = confirm(db, preview(db, id, 'source'));
  assert.equal(restored.outcome, 'source');
  assert.equal(genderCase(db, id).gender, 'Female');
  assert.equal(genderCase(db, id).hasOverride, false);
  validateFinalCatalogSchema(db, { readOnly: false });
});
test('gender hydration skips manual overrides and existing imports without overrides', async t => {
  const { db, ids: [manualId, importedId] } = fixture(t);
  db.prepare("UPDATE character_identities SET creation_method='manual' WHERE id=?").run(manualId);
  reportCharacterGender(db, manualId, 'viewer');
  confirm(db, preview(db, manualId, 'correct', 'Unknown'));
  const before = [manualId, importedId].map(id => ({ ...db.prepare('SELECT * FROM characters WHERE id=?').get(id) }));
  const sourceGender = genderCase(db, manualId).sourceGender;
  db.exec('BEGIN IMMEDIATE');
  const binding = bindSourceCatalogStaging(db);
  db.exec(`INSERT INTO stage_characters(id,favourites)
    SELECT CAST(source.external_id AS INTEGER), c.favourites FROM character_sources AS source
    JOIN characters AS c ON c.id=source.character_id WHERE source.source='anilist'`);
  db.exec('COMMIT');
  assert.equal(await hydrateOneBatch(db, { characterDetails() { assert.fail('Existing metadata must not be fetched'); } }, () => {}, binding), false);
  db.exec('BEGIN IMMEDIATE');
  publishSourceCatalog(db, binding); db.exec('COMMIT');
  assert.deepEqual([manualId, importedId].map(id => ({ ...db.prepare('SELECT * FROM characters WHERE id=?').get(id) })), before);
  assert.equal(genderCase(db, manualId).sourceGender, sourceGender);
  assert.equal(genderCase(db, manualId).gender, 'Unknown');
});
test('gender review rolls back gender, reports, audit and revisions on publication failure', t => {
  const { db, ids: [id] } = fixture(t);
  reportCharacterGender(db, id, 'viewer');
  const p = preview(db, id, 'correct', 'Female');
  db.exec(`CREATE TRIGGER fail_gender_revision BEFORE UPDATE ON catalog_state BEGIN SELECT RAISE(ABORT,'publication failed'); END;`);
  assert.throws(() => confirm(db, p), /publication failed/);
  assert.equal(genderCase(db, id).gender, 'Male'); assert.equal(genderCase(db, id).reportCount, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM character_gender_reviews').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM character_gender_overrides').get().n, 0);
});
test('exact pre-gender v12 schema upgrades additively; read-only requests upgrade; unknown DDL fails closed', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(FINAL_CATALOG_DDL.replace(CHARACTER_GENDER_DDL, ''));
    db.exec(`INSERT INTO catalog_state VALUES(1,0,0,0); INSERT INTO game_config_state VALUES(1,0); INSERT INTO item_expiry_schema VALUES(1,0); PRAGMA user_version=12;`);
    assert.throws(() => validateFinalCatalogSchema(db), /Gender review schema update needed/);
    ensureFortuneCatalog(db);
    validateFinalCatalogSchema(db, { readOnly: false });
    db.exec('CREATE TABLE unexpected(value TEXT)');
    assert.throws(() => validateFinalCatalogSchema(db, { readOnly: false }), /invalid final catalog schema/);
  } finally { db.close(); }
});

test('integrated portal moderator queue, stale resolution, source reset and attributed history', async t => {
  const { db, ids: [id, other] } = fixture(t);
  reportCharacterGender(db, other, 'earlier');
  reportCharacterGender(db, id, 'later');
  db.prepare('UPDATE character_gender_reports SET reported_at=? WHERE character_id=?').run(1, other);
  const server = createReviewServer({ db, port: 0, authConfig });
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${origin}/api/gender/next`)).status, 401);
  const client = await login(origin, 'moderator');
  const headers = { cookie: client.cookie, origin, 'x-csrf-token': client.csrfToken, 'content-type': 'application/json' };
  assert.equal((await fetch(`${origin}/gender`, { headers })).status, 200);
  const row = await (await fetch(`${origin}/api/gender/next`, { headers })).json();
  assert.equal(row.id, other);
  const input = { characterId: row.id, caseId: row.caseId, revision: row.revision, action: 'correct', gender: 'Male' };
  assert.equal((await fetch(`${origin}/api/gender/resolve`, { method: 'POST', headers: { ...headers, 'x-csrf-token': '' }, body: JSON.stringify(input) })).status, 403);
  assert.equal((await fetch(`${origin}/api/gender/resolve`, { method: 'POST', headers, body: JSON.stringify(input) })).status, 200);
  assert.equal((await fetch(`${origin}/api/gender/resolve`, { method: 'POST', headers, body: JSON.stringify(input) })).status, 409);
  const history = await (await fetch(`${origin}/api/gender/history`, { headers })).json();
  assert.equal(history[0].account, 'test-moderator');
  assert.equal(history[0].before_gender, 'Female'); assert.equal(history[0].after_gender, 'Male');
  const overrides = await (await fetch(`${origin}/api/gender/overrides`, { headers })).json();
  assert.equal(overrides[0].id, other);
  const reset = { characterId: other, caseId: overrides[0].caseId, revision: overrides[0].revision, action: 'source' };
  assert.equal((await fetch(`${origin}/api/gender/resolve`, { method: 'POST', headers, body: JSON.stringify(reset) })).status, 200);
  assert.equal(genderCase(db, other).gender, 'Female');
  assert.equal((await (await fetch(`${origin}/api/gender/next`, { headers })).json()).id, id);
});

test('roll gender button shares global deduping and report lifetime, including closed rolls', async t => {
  const { db, ids: [id] } = fixture(t);
  const now = Date.now();
  db.prepare(`INSERT INTO character_rolls(guild_id,channel_id,command_message_id,message_id,character_id,character_name,state,published_at)
    VALUES('1','2','3','4',?,'One','closed',?)`).run(id, now);
  const replies = [];
  const interaction = { isButton: () => true, customId: 'roll:gender-report', guildId: '1', channelId: '2',
    message: { id: '4' }, user: { id: 'viewer' }, reply: async value => replies.push(value) };
  assert.equal(await onRollReport(db, interaction), true);
  assert.match(replies[0].content, /Gender report saved/);
  assert.equal(reportCharacterGender(db, id, 'viewer'), false);
  await onRollReport(db, interaction);
  assert.match(replies[1].content, /already reported/);
  db.prepare('UPDATE character_rolls SET published_at=0').run();
  await onRollReport(db, interaction);
  assert.match(replies[2].content, /expired/);
});
