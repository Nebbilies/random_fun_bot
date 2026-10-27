import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFinalCatalog } from '../lib/catalogDb.js';
import { previewCatalogMutation, confirmCatalogMutation } from '../lib/catalogMutations.js';
import { previewSourceMutation as preview, confirmSourceMutation as confirm,
  SOURCE_MUTATION_PREVIEW_TTL_MS as TTL } from '../lib/catalogSourceMutations.js';

const auth = { account: 'editor', role: 'moderator' };
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'catalog-source-'));
  const db = createFinalCatalog(join(dir, 'catalog.sqlite'));
  const close = db.close.bind(db);
  db.close = () => { try { close(); } finally { rmSync(dir, { recursive: true, force: true }); } };
  const ids = [1, 2, 3].map(n => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`);
  for (const [index, likes] of [100, 50, 50].entries()) {
    const id = ids[index];
    db.prepare('INSERT INTO character_identities (id,name_full) VALUES (?,?)').run(id, `Local ${index}`);
    db.prepare("INSERT INTO character_sources (character_id,source,external_id) VALUES (?,'anilist',?)").run(id, String(index + 1));
    db.prepare('INSERT INTO characters (id,rank,tie_order,favourites,name_full) VALUES (?,?,?,?,?)').run(id, index + 1, index + 1, likes, `Local ${index}`);
  }
  db.prepare("UPDATE characters SET likes_source='generated' WHERE id=?").run(ids[0]);
  db.prepare('DELETE FROM character_sources WHERE character_id=?').run(ids[0]);
  db.prepare("UPDATE character_identities SET creation_method='manual' WHERE id=?").run(ids[0]);
  return { db, ids };
}
const dump = db => Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
  .map(({ name }) => [name, db.prepare(`SELECT * FROM ${name}`).all()]));
const source = (id = 44, favourites = 50) => ({ data: { Character: { id, favourites,
  name: { full: 'Verified name' }, image: { large: 'https://example.test/portrait' }, siteUrl: `https://anilist.co/character/${id}` } } });
function make(db, id, options = {}) {
  return preview(db, { ...auth, operation: 'source-link', input: { characterId: id, source: 'anilist', externalId: '44' },
    permissionConfirmed: true, verifySource: async () => new Response(JSON.stringify(source())), now: 1000, ...options });
}
const commit = (db, p, options = {}) => confirm(db, { ...auth, previewId: p.previewId, payloadHash: p.payloadHash,
  idempotencyKey: 'key', now: 1001, ...options });
function unchanged(db, fn, pattern) { const before = dump(db); assert.throws(fn, pattern); assert.deepEqual(dump(db), before); }
async function rejectsUnchanged(db, fn, pattern) { const before = dump(db); await assert.rejects(fn, pattern); assert.deepEqual(dump(db), before); }

test('manual link retains metadata/counts/UUID; fixed verification runs without a transaction; audited retry', async () => {
  const { db, ids } = fixture();
  try {
    const original = db.prepare('SELECT * FROM characters WHERE id=?').get(ids[0]);
    let calls = 0;
    const p = await make(db, ids[0], { verifySource: async (url, request) => {
      calls++;
      assert.equal(db.isTransaction, false);
      assert.equal(url, 'https://graphql.anilist.co');
      assert.equal(request.redirect, 'error');
      assert.deepEqual(JSON.parse(request.body).variables, { id: 44 });
      assert.match(JSON.parse(request.body).query, /Character\(id: \$id\)/);
      return new Response(JSON.stringify(source()));
    } });
    assert.equal(p.verified.name, 'Verified name');
    assert.equal(p.rankBefore, p.rankAfter);
    assert.equal(p.likesSource, 'generated');
    const result = commit(db, p);
    assert.deepEqual(db.prepare('SELECT * FROM characters WHERE id=?').get(ids[0]), original);
    assert.equal(result.characterId, ids[0]);
    assert.equal(result.source_revision, 1);
    assert.equal(result.appearance_revision, 0);
    assert.equal(calls, 1);
    const before = dump(db);
    assert.deepEqual(commit(db, p, { now: 1000 + TTL * 2 }), result);
    assert.deepEqual(dump(db), before);
    const audit = db.prepare('SELECT * FROM catalog_mutations').get();
    assert.equal(audit.account, auth.account);
    assert.equal(audit.role, auth.role);
    assert.equal(audit.operation, 'source-link');
    assert.equal(JSON.parse(audit.before_json).sources.length, 0);
    assert.equal(JSON.parse(audit.after_json).sources[0].external_id, '44');
    for (const options of [{ role: 'admin' }, { previewId: 'wrong' }, { payloadHash: 'a'.repeat(64) }]) unchanged(db, () => commit(db, p, options), /mismatch/);
    unchanged(db, () => commit(db, p, { idempotencyKey: 'different' }), /already confirmed/);
  } finally { db.close(); }
});

test('explicit adoption uses verified likes and stable persisted tie order, not UUID; no metadata override', async () => {
  const { db, ids } = fixture();
  try {
    commit(db, await make(db, ids[0]));
    // Tie order intentionally differs from rank/UUID order.
    db.prepare('UPDATE characters SET tie_order=10 WHERE id=?').run(ids[0]);
    const old = db.prepare('SELECT * FROM characters WHERE id=?').get(ids[0]);
    const p = await make(db, ids[0], { operation: 'imported-likes-adopt', input: { characterId: ids[0], source: 'anilist' } });
    assert.equal(p.rankAfter, 3);
    assert.equal(p.favourites, 50);
    const result = commit(db, p, { idempotencyKey: 'adopt' });
    assert.equal(result.likesSource, 'anilist');
    assert.equal(result.source_revision, 1);
    assert.equal(result.appearance_revision, 0);
    const after = db.prepare('SELECT * FROM characters WHERE id=?').get(ids[0]);
    assert.deepEqual({ ...after, rank: old.rank, favourites: old.favourites, likes_source: old.likes_source }, { ...old });
    assert.deepEqual(db.prepare('SELECT id FROM characters ORDER BY rank').all().map(row => row.id), [ids[1], ids[2], ids[0]]);
    await assert.rejects(make(db, ids[0], { operation: 'imported-likes-adopt', input: { characterId: ids[0], source: 'anilist' } }), /already imported/);
  } finally { db.close(); }
});

for (const operation of ['source-unlink', 'source-correct']) test(`${operation} freezes imported counts, removes wrong appearances, retains identity/direct history`, async () => {
  const { db, ids } = fixture();
  try {
    const id = ids[1];
    db.exec("INSERT INTO franchises (id,display_name,created_at) VALUES (1,'Direct','test')");
    db.prepare('INSERT INTO character_franchise_memberships VALUES (?,1)').run(id);
    db.prepare('INSERT INTO character_curated_aliases VALUES (?,?,?)').run(id, 'Curated', 'curated');
    db.prepare('INSERT INTO character_anime (character_id,anime_id) VALUES (?,99)').run(id);
    db.prepare("UPDATE characters SET anime_ids='[99]',anime_titles='[\"Wrong\"]',anime_adult=1 WHERE id=?").run(id);
    db.exec("INSERT INTO catalog_meta VALUES ('franchise_source_token','source:0')");
    const identity = db.prepare('SELECT * FROM character_identities WHERE id=?').get(id);
    const p = await make(db, id, { operation, input: { characterId: id, source: 'anilist', ...(operation === 'source-correct' ? { externalId: '44' } : {}) },
      verifySource: operation === 'source-unlink' ? () => { throw new Error('must not fetch'); } : async () => new Response(JSON.stringify(source())) });
    const result = commit(db, p);
    assert.equal(result.favourites, 50);
    assert.equal(result.likesSource, 'generated');
    assert.equal(result.source_revision, 1);
    assert.equal(result.appearance_revision, 1);
    assert.equal(db.prepare("SELECT value FROM catalog_meta WHERE key='franchise_source_token'").get(), undefined);
    assert.deepEqual(db.prepare('SELECT * FROM character_identities WHERE id=?').get(id), identity);
    assert.equal(db.prepare('SELECT count(*) n FROM character_anime WHERE character_id=?').get(id).n, 0);
    assert.equal(db.prepare('SELECT anime_ids FROM characters WHERE id=?').get(id).anime_ids, '[]');
    assert.equal(db.prepare('SELECT count(*) n FROM character_franchise_memberships WHERE character_id=?').get(id).n, 1);
    assert.equal(db.prepare('SELECT count(*) n FROM character_curated_aliases WHERE character_id=?').get(id).n, 1);
    const audit = db.prepare('SELECT * FROM catalog_mutations').get();
    assert.equal(JSON.parse(audit.before_json).appearances[0].anime_id, 99);
    assert.equal(JSON.parse(audit.after_json).appearances.length, 0);
    const links = db.prepare('SELECT external_id FROM character_sources WHERE character_id=?').all(id);
    assert.deepEqual(links.map(row => row.external_id), operation === 'source-correct' ? ['44'] : []);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});

test('validation, permission and conflicts fail before transport or transaction', async () => {
  const { db, ids } = fixture();
  try {
    const never = () => { throw new Error('transport was called'); };
    for (const options of [{ role: 'user' }, { account: '' }, { permissionConfirmed: false }, { permissionConfirmed: 'true' },
      { operation: 'merge' }, { input: { characterId: ids[0].toUpperCase(), source: 'anilist', externalId: 44 } },
      { input: { characterId: ids[0], source: 'other', externalId: 44 } },
      ...[0, -1, '01', 'https://evil.test', 2147483648].map(externalId => ({ input: { characterId: ids[0], source: 'anilist', externalId } })),
      ...['favourites', 'name', 'portraitUrl'].map(key => ({ input: { characterId: ids[0], source: 'anilist', externalId: 44, [key]: 999 } })),
      { input: { characterId: ids[0], source: 'anilist', externalId: 2 } },
      { input: { characterId: ids[1], source: 'anilist', externalId: 44 } }]) {
      await rejectsUnchanged(db, () => make(db, ids[0], { verifySource: never, ...options }));
    }
    db.exec('BEGIN');
    await assert.rejects(make(db, ids[0], { verifySource: never }), /transaction/);
    assert.equal(db.isTransaction, true);
    db.exec('ROLLBACK');
  } finally { db.close(); }
});

test('verification rejects API/mismatched/malformed/oversized responses without writes', async () => {
  const { db, ids } = fixture();
  try {
    for (const transport of [async () => { throw new Error('offline'); }, async () => new Response('', { status: 500 }),
      async () => new Response('not json'), async () => new Response('x'.repeat(65537)),
      ...[source(45), source(44, -1), source(44, Number.MAX_SAFE_INTEGER + 1), { errors: [{ message: 'no' }], ...source() },
        { data: { Character: null } }].map(value => async () => new Response(JSON.stringify(value)))]) {
      await rejectsUnchanged(db, () => make(db, ids[0], { verifySource: transport }));
    }
  } finally { db.close(); }
});

test('state races during verification, each revision, ownership, expiry and persisted hash are checked', async () => {
  const { db, ids } = fixture();
  try {
    await assert.rejects(make(db, ids[0], { verifySource: async () => {
      assert.equal(db.isTransaction, false);
      db.exec('UPDATE catalog_state SET source_revision=source_revision+1');
      return new Response(JSON.stringify(source()));
    } }), /Stale/);
    assert.equal(db.prepare('SELECT count(*) n FROM catalog_previews').get().n, 0);
    for (const key of ['revision', 'source_revision', 'appearance_revision']) {
      const p = await make(db, ids[0]);
      db.exec(`UPDATE catalog_state SET ${key}=${key}+1`);
      unchanged(db, () => commit(db, p), /Stale/);
    }
    const p = await make(db, ids[0]);
    for (const options of [{ account: 'other' }, { role: 'admin' }, { payloadHash: 'a'.repeat(64) },
      { now: p.expiresAt }, { now: 999 }, { idempotencyKey: '' }]) unchanged(db, () => commit(db, p, options));
    db.prepare("UPDATE catalog_previews SET payload_json='{}' WHERE id=?").run(p.previewId);
    unchanged(db, () => commit(db, p), /Stored preview mismatch/);
  } finally { db.close(); }
});

test('commit rechecks source uniqueness even for an uncoordinated writer', async () => {
  const { db, ids } = fixture();
  try {
    const p = await make(db, ids[0]);
    db.prepare("UPDATE characters SET likes_source='generated' WHERE id=?").run(ids[1]);
    db.prepare("UPDATE character_sources SET external_id='44' WHERE character_id=?").run(ids[1]);
    unchanged(db, () => commit(db, p), /belongs/);
  } finally { db.close(); }
});

test('overflow and late failure roll back source, appearances, rank, audit and result; retry succeeds', async () => {
  for (const key of ['revision', 'source_revision', 'appearance_revision', 'trigger']) {
    const { db, ids } = fixture();
    try {
      if (key !== 'trigger') db.prepare(`UPDATE catalog_state SET ${key}=?`).run(Number.MAX_SAFE_INTEGER);
      const p = await make(db, ids[1], { operation: 'source-correct', input: { characterId: ids[1], source: 'anilist', externalId: 44 } });
      if (key === 'trigger') db.exec("CREATE TRIGGER fail_result BEFORE INSERT ON catalog_confirmation_results BEGIN SELECT RAISE(ABORT,'late failure'); END");
      unchanged(db, () => commit(db, p), /overflow|late failure/);
      if (key === 'trigger') { db.exec('DROP TRIGGER fail_result'); assert.equal(commit(db, p).revision, 1); }
    } finally { db.close(); }
  }
});

for (const operation of ['source-correct', 'source-unlink']) {
  test(`${operation}: composed manual edit cannot leave only discarded derived franchises`, async () => {
    const { db, ids } = fixture();
    try {
      const id = ids[0];
      commit(db, await make(db, id));
      db.exec("INSERT INTO franchises (id,display_name,created_at) VALUES (1,'Direct','test'),(2,'Wrong derived','test'); INSERT INTO franchise_anime (franchise_id,anime_id) VALUES (2,99)");
      db.prepare('INSERT INTO character_franchise_memberships VALUES (?,1)').run(id);
      db.prepare('INSERT INTO character_anime VALUES (?,99)').run(id);
      db.prepare("UPDATE characters SET image_url='https://example.test/local', description='Local description' WHERE id=?").run(id);
      const options = { operation, input: { characterId: id, source: 'anilist', ...(operation === 'source-correct' ? { externalId: 45 } : {}) },
        verifySource: async () => new Response(JSON.stringify(source(45))) };
      const stored = await make(db, id, options);
      const edit = previewCatalogMutation(db, { ...auth, operation: 'edit', input: { characterId: id, franchiseIds: [] }, now: 1000 });
      confirmCatalogMutation(db, { ...auth, previewId: edit.previewId, payloadHash: edit.payloadHash, idempotencyKey: 'edit', now: 1001 });
      assert.deepEqual(db.prepare('SELECT franchise_id FROM effective_character_franchises WHERE character_id=?').all(id).map(r => r.franchise_id), [2]);
      await rejectsUnchanged(db, () => make(db, id, options), /direct franchise/);
      unchanged(db, () => commit(db, stored, { idempotencyKey: 'remove' }), /Stale/);
      // Simulate an uncoordinated membership writer without changing revisions.
      // The stored preview predates removal, so this exercises the confirmation
      // invariant independently of revision and character snapshot checks.
      const revisions = db.prepare('SELECT * FROM catalog_state').get();
      db.prepare('UPDATE catalog_state SET revision=?, source_revision=?, appearance_revision=?').run(stored.revision, stored.source_revision, stored.appearance_revision);
      unchanged(db, () => commit(db, stored, { idempotencyKey: 'remove' }), /direct franchise/);
      db.prepare('UPDATE catalog_state SET revision=?, source_revision=?, appearance_revision=?').run(revisions.revision, revisions.source_revision, revisions.appearance_revision);
      db.prepare('INSERT INTO character_franchise_memberships VALUES (?,1)').run(id);
      const fresh = await make(db, id, options);
      const result = commit(db, fresh, { idempotencyKey: 'remove' });
      assert.deepEqual(db.prepare('SELECT franchise_id FROM effective_character_franchises WHERE character_id=?').all(id).map(r => r.franchise_id), [1]);
      assert.equal(db.prepare('SELECT count(*) n FROM character_anime WHERE character_id=?').get(id).n, 0);
      const beforeRetry = dump(db);
      assert.deepEqual(commit(db, fresh, { idempotencyKey: 'remove', now: fresh.expiresAt }), result);
      assert.deepEqual(dump(db), beforeRetry);
    } finally { db.close(); }
  });
}

test('outer unknown options are rejected before destructuring, verification and confirmation retries', async () => {
  const { db, ids } = fixture();
  try {
    let calls = 0;
    for (const key of ['favourites', 'rank', 'metadata', 'unexpected']) {
      await rejectsUnchanged(db, () => make(db, ids[0], { [key]: 123, verifySource: () => { calls++; throw new Error('called'); } }), /Unknown option/);
    }
    assert.equal(calls, 0);
    const p = await make(db, ids[0]);
    unchanged(db, () => commit(db, p, { unexpected: true }), /Unknown option/);
    const result = commit(db, p);
    unchanged(db, () => commit(db, p, { unexpected: true }), /Unknown option/);
    assert.deepEqual(commit(db, p), result);
    const invalid = { unexpected: true, get account() { throw new Error('destructured'); } };
    await rejectsUnchanged(db, () => preview(db, invalid), /Unknown option/);
    unchanged(db, () => confirm(db, invalid), /Unknown option/);
  } finally { db.close(); }
});

for (const operation of ['source-link', 'source-correct', 'source-unlink', 'imported-likes-adopt']) {
  test(`${operation}: final-schema late rollback and exact retry`, async () => {
    const { db, ids } = fixture();
    try {
      const id = operation === 'source-link' ? ids[0] : ids[1];
      if (operation === 'imported-likes-adopt') db.prepare("UPDATE characters SET likes_source='generated' WHERE id=?").run(id);
      db.prepare('INSERT INTO character_anime VALUES (?,99)').run(id);
      const p = await make(db, id, { operation, input: { characterId: id, source: 'anilist',
        ...(['source-link', 'source-correct'].includes(operation) ? { externalId: 44 } : {}) },
        verifySource: async () => new Response(JSON.stringify(source(operation === 'imported-likes-adopt' ? 2 : 44, 100))) });
      db.exec("CREATE TRIGGER fail_result BEFORE INSERT ON catalog_confirmation_results BEGIN SELECT RAISE(ABORT,'late failure'); END");
      unchanged(db, () => commit(db, p), /late failure/);
      db.exec('DROP TRIGGER fail_result');
      const result = commit(db, p);
      const saved = dump(db);
      assert.deepEqual(commit(db, p, { now: p.expiresAt + 1 }), result);
      assert.deepEqual(dump(db), saved);
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    } finally { db.close(); }
  });
}

for (const operation of ['source-link', 'source-correct', 'source-unlink', 'imported-likes-adopt']) {
  const incremented = ['revision', ...(operation !== 'imported-likes-adopt' ? ['source_revision'] : []),
    ...(['source-correct', 'source-unlink'].includes(operation) ? ['appearance_revision'] : [])];
  for (const key of incremented) test(`${operation}: ${key} overflow is write-free on final DDL`, async () => {
    const { db, ids } = fixture();
    try {
      const id = operation === 'source-link' ? ids[0] : ids[1];
      if (operation === 'imported-likes-adopt') db.prepare("UPDATE characters SET likes_source='generated' WHERE id=?").run(id);
      db.prepare(`UPDATE catalog_state SET ${key}=?`).run(Number.MAX_SAFE_INTEGER);
      const p = await make(db, id, { operation, input: { characterId: id, source: 'anilist',
        ...(['source-link', 'source-correct'].includes(operation) ? { externalId: 44 } : {}) },
        verifySource: async () => new Response(JSON.stringify(source(operation === 'imported-likes-adopt' ? 2 : 44))) });
      unchanged(db, () => commit(db, p), /revision overflow/);
    } finally { db.close(); }
  });
}

test('adoption rejects rank offset overflow without writes on final DDL', async () => {
  const { db, ids } = fixture();
  try {
    db.prepare("UPDATE characters SET likes_source='generated',rank=? WHERE id=?").run(Number.MAX_SAFE_INTEGER, ids[1]);
    const p = await make(db, ids[1], { operation: 'imported-likes-adopt', input: { characterId: ids[1], source: 'anilist' },
      verifySource: async () => new Response(JSON.stringify(source(2))) });
    unchanged(db, () => commit(db, p), /rank overflow/);
  } finally { db.close(); }
});

test('schema/FK preconditions and caller transaction are not silently repaired or rolled back', async () => {
  const { db, ids } = fixture();
  try {
    const p = await make(db, ids[0]);
    db.exec('BEGIN');
    unchanged(db, () => commit(db, p), /transaction/);
    assert.equal(db.isTransaction, true);
    db.exec('ROLLBACK; PRAGMA user_version=11');
    await rejectsUnchanged(db, () => make(db, ids[0]), /version 12/);
    db.exec('PRAGMA user_version=12; PRAGMA foreign_keys=OFF');
    unchanged(db, () => commit(db, p), /foreign_keys ON/);
  } finally { db.close(); }
});
