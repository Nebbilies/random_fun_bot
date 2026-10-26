import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCatalog, createFinalCatalog } from '../lib/catalogDb.js';
import { createReviewServer } from '../web/reviewCharacterTags.js';
import { createFranchiseReviewServer } from '../web/reviewFranchises.js';
import { authConfig, login } from './helpers/portalAuth.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'review-catalog-'));
  const db = createFinalCatalog(join(dir, 'synthetic.sqlite'));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  return db;
}
async function setup(t, factory, extra = {}) {
  const db = fixture(t);
  const server = factory({ db, port: 0, authConfig, ...extra });
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); });
  const client = await login(origin, 'moderator');
  const request = (path, body, headers = {}) => fetch(`${origin}${path}`, {
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    headers: { origin, cookie: client.cookie, 'x-csrf-token': client.csrfToken, 'content-type': 'application/json', ...headers },
  });
  const post = async (path, body) => {
    const response = await request(`/api/catalog${path}`, body);
    const value = await response.json();
    assert.equal(response.status, 200, JSON.stringify(value)); return value;
  };
  return { db, origin, request, post };
}
const metadata = { name: 'Chell', aliases: ['Test Subject'], gender: 'female', portraitUrl: 'https://example.test/portrait', franchiseIds: [1] };
for (const [name, factory] of [['combined', createReviewServer], ['standalone', createFranchiseReviewServer]]) {
  test(`${name}: authenticated catalog bootstrap, role boundaries, CSRF, strict create, stale and exact retry`, async t => {
    const { db, origin, request, post } = await setup(t, factory);
    assert.equal(db.prepare('SELECT value FROM catalog_meta WHERE key=\'import_phase\'').get()?.value === 'complete', false);
    for (const path of ['/catalog', '/api/catalog', '/assets/catalog.js']) {
      const response = await fetch(`${origin}${path}`, { redirect: 'manual' });
      assert.equal(response.status, path === '/catalog' ? 303 : 401);
      assert.equal((await request(path)).status, 200);
    }
    for (const path of ['/game', '/config', '/api/game/items', '/api/config']) assert.equal((await request(path)).status, 403);
    const empty = await (await request('/api/catalog/search')).json();
    assert.deepEqual(empty.characters, []); assert.equal(empty.count, 0);
    assert.equal((await request('/api/catalog/create/preview', {}, { 'x-csrf-token': '' })).status, 403);
    assert.equal((await request('/api/catalog/create/preview', {}, { origin: 'https://evil.test' })).status, 403);
    assert.equal((await request('/api/catalog/create/preview', { input: metadata, rank: 1, role: 'admin' })).status, 400);
    const franchise = await post('/franchise/preview', { operation: 'franchise_create', input: { displayName: 'Portal', aliases: ['Aperture'] } });
    const commit = p => ({ previewId: p.previewId, payloadHash: p.payloadHash, idempotencyKey: `key-${p.previewId}` });
    await post('/franchise/confirm', commit(franchise));
    assert.equal((await request('/api/catalog/create/preview', { input: { ...metadata, favourites: 1 }, rank: 1 })).status, 400);
    assert.equal((await request('/api/catalog/create/preview', { input: { ...metadata, gender: undefined }, rank: 1 })).status, 400);
    const stale = await post('/create/preview', { input: metadata, rank: 1 });
    const preview = await post('/create/preview', { input: metadata, rank: 1 });
    assert.equal(preview.favourites, 0);
    const created = await post('/create/confirm', commit(preview));
    assert.deepEqual(await post('/create/confirm', commit(preview)), created);
    assert.equal(db.prepare('SELECT count(*) AS n FROM characters').get().n, 1);
    const conflict = await request('/api/catalog/create/confirm', commit(stale));
    assert.equal(conflict.status, 409); assert.equal((await conflict.json()).refreshPreview, true);
    const detail = await (await request(`/api/catalog/detail?id=${created.characterId}`)).json();
    assert.equal(detail.creationMethod, 'manual'); assert.deepEqual(detail.franchiseIds, [1]);
    assert.equal(detail.likes_source, 'generated');
    const duplicate = await post('/create/preview', { input: metadata, rank: 1 });
    assert.equal(duplicate.duplicateWarnings.length, 1);
    assert.equal((await request('/api/catalog/create/confirm', commit(duplicate))).status, 400);
    const edit = await post('/edit/preview', { input: { characterId: created.characterId, aliases: ['Portal protagonist'] } });
    await post('/edit/confirm', commit(edit));
    const found = await (await request('/api/catalog/search?query=Portal%20protagonist')).json();
    assert.equal(found.characters[0].id, created.characterId);
    const rank = await post('/reposition/preview', { input: { characterId: created.characterId, rank: 1 } });
    assert.equal((await request('/api/catalog/edit/confirm', commit(rank))).status, 400);
    await post('/reposition/confirm', commit(rank));
    const source = await request('/api/catalog/source/preview', { operation: 'source-link', input: { characterId: created.characterId, source: 'anilist', externalId: '123' }, permissionConfirmed: true });
    assert.equal(source.status, 400);
    const denied = await request('/api/catalog/source/preview', { operation: 'source-link', input: { characterId: created.characterId, source: 'anilist', externalId: '123' } });
    assert.equal(denied.status, 400); assert.match((await denied.json()).error, /permission/i);
    const audits = await (await request('/api/catalog/audit')).json();
    assert.ok(audits.length >= 4); assert.ok(audits.every(row => row.account === 'test-moderator' && row.role === 'moderator'));
    assert.equal((await request('/api/catalog/franchises')).status, 200);
    assert.equal((await request('/api/catalog/detail?id=missing')).status, 404);
    const tag = await post('/tag/preview', { input: { characterId: created.characterId, status: 'no_match' } });
    await post('/tag/confirm', commit(tag));
    assert.equal((await request('/api/catalog/delete/preview', {})).status, 404);
    const admin = await login(origin, 'admin');
    assert.equal((await request('/api/catalog/search', undefined, { cookie: admin.cookie })).status, 200);
  });
}

for (const [name, factory] of [['combined', createReviewServer], ['standalone', createFranchiseReviewServer]]) {
  test(`${name}: source verification uses server permission and fixed transport, confirms without network`, async t => {
    let calls = 0;
    const { request, post, db, origin } = await setup(t, factory, {
      sourcePermissionConfirmed: true,
      verifySource: async (url, options) => {
        calls++;
        assert.equal(url, 'https://graphql.anilist.co');
        assert.equal(JSON.parse(options.body).variables.id, 123);
        return new Response(JSON.stringify({ data: { Character: { id: 123, favourites: 10,
          name: { full: 'Verified identity' }, image: { large: 'https://example.test/source' }, siteUrl: 'https://anilist.co/character/123' } } }));
      },
    });
    const commit = p => ({ previewId: p.previewId, payloadHash: p.payloadHash, idempotencyKey: p.previewId });
    const franchise = await post('/franchise/preview', { operation: 'franchise_create', input: { displayName: 'Portal' } });
    await post('/franchise/confirm', commit(franchise));
    const character = await post('/create/preview', { input: metadata, rank: 1 });
    const created = await post('/create/confirm', commit(character));
    const p = await post('/source/preview', { operation: 'source-link', input: { characterId: created.characterId, source: 'anilist', externalId: '123' } });
    assert.equal(p.verified.name, 'Verified identity');
    await post('/source/confirm', commit(p)); await post('/source/confirm', commit(p));
    assert.equal(calls, 1);
    assert.equal(db.prepare('SELECT likes_source FROM characters').get().likes_source, 'generated');
    const anon = await fetch(`${origin}/api/catalog/create/preview`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(anon.status, 401);
    assert.equal((await request('/api/catalog/source/confirm', { ...commit(p), verifySource: 'https://evil.test' })).status, 400);
  });
}

test('legacy unpublished combined catalog retains import gate', () => {
  const db = openCatalog(':memory:');
  try { assert.throws(() => createReviewServer({ db, port: 0, authConfig }), /Publish the catalog/); }
  finally { db.close(); }
});

const commitPreview = p => ({ previewId: p.previewId, payloadHash: p.payloadHash, idempotencyKey: p.previewId });
async function seedCharacter(post) {
  const franchise = await post('/franchise/preview', { operation: 'franchise_create', input: { displayName: 'Portal' } });
  await post('/franchise/confirm', commitPreview(franchise));
  const preview = await post('/create/preview', { input: metadata, rank: 1 });
  return (await post('/create/confirm', commitPreview(preview))).characterId;
}

test('v12 legacy queue decisions and corrections are attributed, audited, invalidate previews, and resolve reports atomically', async t => {
  let calls = 0;
  const { db, post, request } = await setup(t, createReviewServer, { api: { exactTag: async name => {
    calls++; return { name, category: 4, is_deprecated: false };
  } } });
  const characterId = await seedCharacter(post);
  const stale = await post('/edit/preview', { input: { characterId, aliases: ['stale'] } });
  const revision = () => db.prepare('SELECT revision FROM catalog_state').get().revision;
  const before = revision();
  const decision = await request('/api/decision', { characterId, status: 'approve', tag: 'chell_(portal)' });
  assert.equal(decision.status, 200, await decision.text());
  assert.equal(revision(), before + 1);
  assert.equal((await request('/api/catalog/edit/confirm', commitPreview(stale))).status, 409);
  const audit = db.prepare('SELECT * FROM catalog_mutations ORDER BY id DESC LIMIT 1').get();
  assert.equal(audit.operation, 'tag'); assert.equal(audit.account, 'test-moderator'); assert.equal(audit.role, 'moderator');
  assert.equal(JSON.parse(audit.after_json).tag.tag_name, 'chell_(portal)');
  assert.equal(calls, 1);
  const removal = await request('/api/decision', { characterId, status: 'no_match' });
  assert.equal(removal.status, 200); assert.equal(revision(), before + 2);
  assert.equal(db.prepare('SELECT tag_name FROM tag_decisions WHERE character_id=?').get(characterId).tag_name, null);
  db.prepare("INSERT INTO character_tag_reports(character_id, reporter_id, reported_at) VALUES (?, 'reporter', 'test')").run(characterId);
  // A failure in report resolution must roll back the tag, audit, and revision.
  db.exec("CREATE TRIGGER reject_resolution BEFORE UPDATE ON character_tag_reports BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END");
  const count = db.prepare('SELECT count(*) n FROM catalog_mutations').get().n;
  assert.equal((await request('/api/reports/resolve', { characterId, outcome: 'corrected', tag: 'corrected_tag' })).status, 500);
  assert.equal(revision(), before + 2);
  assert.equal(db.prepare('SELECT count(*) n FROM catalog_mutations').get().n, count);
  assert.equal(db.prepare('SELECT status FROM tag_decisions WHERE character_id=?').get(characterId).status, 'no_match');
  assert.equal(db.prepare('SELECT resolved_at FROM character_tag_reports').get().resolved_at, null);
  db.exec('DROP TRIGGER reject_resolution');
  const staleCorrection = await post('/tag/preview', { input: { characterId, status: 'no_match' } });
  assert.equal((await request('/api/reports/resolve', { characterId, outcome: 'corrected', tag: 'corrected_tag' })).status, 200);
  assert.equal(revision(), before + 3);
  assert.equal((await request('/api/catalog/tag/confirm', commitPreview(staleCorrection))).status, 409);
  assert.equal(db.prepare('SELECT outcome FROM character_tag_reports').get().outcome, 'corrected');
  assert.equal(db.prepare('SELECT tag_name FROM tag_decisions').get().tag_name, 'corrected_tag');
  const verified = await post('/tag/preview', { input: { characterId, status: 'approve', tagName: 'corrected_tag' } });
  const verifiedCalls = calls;
  await post('/tag/confirm', commitPreview(verified));
  assert.equal(calls, verifiedCalls, 'confirmation must use validated cached evidence without network');
});

test('v12 trusted tag adapters reject non-character and deprecated verification results', async t => {
  const { db, request, post } = await setup(t, createReviewServer, { api: { exactTag: async name =>
    ({ name, category: name === 'general_tag' ? 0 : 4, is_deprecated: name === 'deprecated_tag' }) } });
  const characterId = await seedCharacter(post);
  const revision = db.prepare('SELECT revision FROM catalog_state').get().revision;
  for (const tag of ['general_tag', 'deprecated_tag']) {
    assert.equal((await request('/api/decision', { characterId, status: 'approve', tag })).status, 400);
    assert.equal((await request('/api/catalog/tag/preview', { input: { characterId, status: 'approve', tagName: tag } })).status, 400);
  }
  assert.equal(db.prepare('SELECT revision FROM catalog_state').get().revision, revision);
  assert.equal(db.prepare('SELECT count(*) n FROM tag_decisions').get().n, 0);
});

for (const [name, factory] of [['combined', createReviewServer], ['standalone', createFranchiseReviewServer]]) {
  test(`${name}: search and filtered audit pagination, imported reference curation and tag removal`, async t => {
    const { db, request, post } = await setup(t, factory);
    const characterId = await seedCharacter(post);
    for (let i = 2; i <= 56; i++) {
      const id = `12345678-1234-4123-8123-${String(i).padStart(12, '0')}`;
      db.prepare("INSERT INTO character_identities(id,creation_method) VALUES (?,'manual')").run(id);
      db.prepare("INSERT INTO characters(id,rank,favourites,tie_order,likes_source,name_full) VALUES (?,?,0,?,'generated',?)").run(id, i, i, `Synthetic ${i}`);
    }
    const first = await (await request('/api/catalog/search?query=Synthetic&limit=50&offset=0')).json();
    const second = await (await request('/api/catalog/search?query=Synthetic&limit=50&offset=50')).json();
    assert.equal(first.characters.length, 50); assert.equal(second.characters.length, 5);
    assert.equal(new Set([...first.characters, ...second.characters].map(row => row.id)).size, 55);
    for (let i = 0; i < 51; i++) {
      const p = await post('/edit/preview', { input: { characterId, aliases: [`Edit ${i}`] } });
      await post('/edit/confirm', commitPreview(p));
    }
    const history = await (await request(`/api/catalog/audit?characterId=${characterId}&offset=50`)).json();
    assert.equal(history.length, 2); assert.ok(history.every(row => row.character_id === characterId));
    db.prepare("UPDATE character_identities SET creation_method='imported' WHERE id=?").run(characterId);
    const edit = await post('/edit/preview', { input: { characterId, referenceUrl: 'https://example.test/curated' } });
    await post('/edit/confirm', commitPreview(edit));
    const detail = await (await request(`/api/catalog/detail?id=${characterId}`)).json();
    assert.equal(detail.referenceUrl, 'https://example.test/curated'); assert.equal(detail.name_full, metadata.name);
    const remove = await post('/tag/preview', { input: { characterId, status: 'no_match' } });
    await post('/tag/confirm', commitPreview(remove));
    assert.equal(db.prepare('SELECT status FROM tag_decisions WHERE character_id=?').get(characterId).status, 'no_match');
  });
}
