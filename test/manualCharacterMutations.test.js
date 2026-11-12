import test from 'node:test';
import assert from 'node:assert/strict';
import { openCatalog } from '../lib/catalogDb.js';
import { migrateCharacterIdentities } from '../lib/characterIdentityMigration.js';
import { initializeCatalogReleaseSchema } from '../lib/catalogReleaseSchema.js';
import { bindSourceCatalogStaging, publishSourceCatalog } from '../lib/sourceCatalogPublication.js';
import { findCharacters, loadCharacterIndex } from '../lib/gameCharacterLookup.js';
import { isCharacterId } from '../lib/characterIdentity.js';
import { previewManualCharacterCreation as preview, confirmManualCharacterCreation as confirm,
  MANUAL_CHARACTER_PREVIEW_TTL_MS as TTL } from '../lib/manualCharacterMutations.js';

const auth = { account: 'editor', role: 'moderator' };
const input = (overrides = {}) => ({ name: 'Chell', aliases: ['Test Subject'], gender: 'female',
  franchiseIds: [1], portraitUrl: 'https://example.test/portrait', description: 'A test subject',
  referenceUrl: 'https://example.test/reference', ...overrides });
function fixture(likes = [100, 50, 50, 0]) {
  const db = openCatalog(':memory:');
  const add = db.prepare(`INSERT INTO characters (id, rank, favourites, name_full, name_alternatives, gender)
    VALUES (?, ?, ?, ?, ?, 'Male')`);
  likes.forEach((count, index) => {
    add.run(index + 1, index + 1, count, `Imported ${index + 1}`, JSON.stringify([`Alias ${index + 1}`]));
    db.prepare('INSERT INTO character_identities (id, name_full) VALUES (?, ?)').run(index + 1, `Imported ${index + 1}`);
  });
  db.exec("INSERT INTO franchises (id, display_name, created_at) VALUES (1, 'Portal', 'synthetic'), (2, 'Other', 'synthetic')");
  migrateCharacterIdentities(db, { dryRun: false, targetVersion: 11 });
  initializeCatalogReleaseSchema(db);
  return db;
}
function cacheTag(db, name, response = [{ name, category: 4, is_deprecated: false }]) {
  const params = new URLSearchParams({ 'search[name]': name, 'search[category]': '4', limit: '5' });
  db.prepare('INSERT OR REPLACE INTO tag_search_cache (query, response, fetched_at) VALUES (?, ?, ?)')
    .run(`/tags.json?${params}`, typeof response === 'string' ? response : JSON.stringify(response), 'test');
}
const makePreview = (db, options = {}) => preview(db, { ...auth, input: input(), rank: 2, now: 1000, ...options });
const commit = (db, p, options = {}) => confirm(db, { ...auth, previewId: p.previewId,
  payloadHash: p.payloadHash, idempotencyKey: 'request-1', now: 1001, ...options });
const rows = db => db.prepare('SELECT * FROM characters ORDER BY rank').all();
function snapshot(db) {
  const tables = ['characters', 'character_identities', 'character_sources', 'character_curated_aliases',
    'character_curation', 'character_franchise_memberships', 'tag_decisions', 'catalog_state', 'catalog_meta',
    'catalog_previews', 'catalog_mutations', 'catalog_confirmation_results'];
  return Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}
function unchanged(db, action, pattern) {
  const before = snapshot(db);
  assert.throws(action, pattern);
  assert.deepEqual(snapshot(db), before);
}

test('committed retries remain bound to their preview and authenticated role', () => {
  const db = fixture();
  try {
    const p = makePreview(db);
    const result = commit(db, p);
    unchanged(db, () => commit(db, p, { previewId: 'does-not-exist' }), /request mismatch/);
    unchanged(db, () => commit(db, p, { role: 'admin' }), /request mismatch/);
    const later = makePreview(db);
    assert.equal(later.payloadHash, p.payloadHash);
    unchanged(db, () => commit(db, later), /request mismatch/);
    assert.deepEqual(commit(db, p, { now: 1000 + TTL * 2 }), result);
  } finally { db.close(); }
});

test('manual create stores full metadata, independent aliases/direct memberships, audit and searchable UUID', () => {
  const db = fixture();
  try {
    const before = rows(db);
    const p = makePreview(db, { input: input({ franchiseIds: [2, 1, 1], aliases: ['Test Subject', 'test subject'] }) });
    assert.ok(isCharacterId(p.previewId));
    assert.match(p.payloadHash, /^[0-9a-f]{64}$/);
    assert.equal(p.count, 4);
    assert.equal(p.expiresAt, 1000 + TTL);
    assert.equal(p.upperId, before[0].id);
    assert.equal(p.neighbors.lower.id, before[1].id);
    assert.equal(p.favourites, 75);
    assert.deepEqual(rows(db), before);
    const result = commit(db, p);
    assert.ok(isCharacterId(result.characterId));
    assert.equal(result.revision, 1);
    const created = rows(db).find(row => row.id === result.characterId);
    assert.equal(created.rank, 2);
    assert.equal(created.tie_order, 2);
    assert.equal(created.favourites, 75);
    assert.equal(created.likes_source, 'generated');
    assert.equal(created.gender, 'Female');
    assert.equal(created.description, 'A test subject');
    assert.equal(created.image_url, 'https://example.test/portrait');
    assert.equal(created.name_alternatives, '[]');
    for (const key of ['name_native', 'age', 'date_of_birth', 'site_url']) assert.equal(created[key], null);
    assert.equal(created.anime_titles, '[]');
    assert.equal(created.anime_ids, '[]');
    assert.equal(created.anime_adult, 0);
    assert.equal(db.prepare('SELECT creation_method FROM character_identities WHERE id=?').get(result.characterId).creation_method, 'manual');
    assert.equal(db.prepare('SELECT count(*) AS n FROM character_sources WHERE character_id=?').get(result.characterId).n, 0);
    assert.equal(db.prepare('SELECT reference_url FROM character_curation').get().reference_url, 'https://example.test/reference');
    assert.deepEqual(db.prepare('SELECT franchise_id FROM effective_character_franchises WHERE character_id=? ORDER BY franchise_id')
      .all(result.characterId).map(row => row.franchise_id), [1, 2]);
    assert.deepEqual(db.prepare('SELECT alias, normalized_alias FROM character_curated_aliases').all().map(row => ({ ...row })),
      [{ alias: 'Test Subject', normalized_alias: 'test subject' }]);
    // Existing DB-backed name search works. Curated alias index integration is deliberately future work.
    assert.equal(findCharacters(loadCharacterIndex(db), 'Chell')[0].id, result.characterId);
    assert.equal(findCharacters(loadCharacterIndex(db), '#2')[0].id, result.characterId);
    assert.equal(findCharacters(loadCharacterIndex(db), 'Test Subject')[0].id, result.characterId);
    assert.equal(db.prepare('SELECT name_alternatives FROM characters WHERE id=?').get(result.characterId).name_alternatives, '[]');
    const retained = rows(db).filter(row => row.id !== result.characterId);
    assert.deepEqual(retained.map(row => [row.id, row.favourites]), before.map(row => [row.id, row.favourites]));
    const audit = db.prepare('SELECT * FROM catalog_mutations').get();
    assert.equal(audit.account, auth.account);
    assert.equal(audit.role, auth.role);
    assert.equal(audit.operation, 'create');
    assert.deepEqual(JSON.parse(audit.before_json), {});
    const after = JSON.parse(audit.after_json);
    assert.deepEqual(after.character, { ...created });
    assert.deepEqual(after.memberships, [{ franchise_id: 1 }, { franchise_id: 2 }]);
    assert.equal(after.identity.creation_method, 'manual');
    assert.equal(after.curation.reference_url, 'https://example.test/reference');
    assert.deepEqual(after.sources, []);
    assert.equal(after.tag, null);
    assert.equal(db.prepare('SELECT count(*) AS n FROM tag_decisions').get().n, 0);
    assert.equal(after.duplicateOverrideReason, null);
    assert.deepEqual({ ...db.prepare('SELECT * FROM catalog_state').get() },
      { singleton: 1, revision: 1, source_revision: 0, appearance_revision: 1 });
    assert.equal(db.prepare("SELECT value FROM catalog_meta WHERE key='catalog_revision'").get().value, '1');
    assert.equal(db.prepare("SELECT value FROM catalog_meta WHERE key='published_at'").get().value, new Date(1001).toISOString());
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});

test('optional single tag is hash-bound and committed atomically with manual provenance and audit', () => {
  const db = fixture();
  try {
    cacheTag(db, 'chell_(portal)');
    const blank = makePreview(db);
    assert.equal(blank.tagName, null);
    for (const tagName of [undefined, null, '', '   ']) {
      assert.equal(makePreview(db, { input: input({ tagName }) }).payloadHash, blank.payloadHash);
    }
    const p = makePreview(db, { input: input({ tagName: ' chell_(portal) ' }) });
    assert.equal(p.tagName, 'chell_(portal)');
    assert.notEqual(p.payloadHash, blank.payloadHash);
    assert.equal(db.prepare('SELECT count(*) AS n FROM tag_decisions').get().n, 0);
    const payload = JSON.parse(db.prepare('SELECT payload_json FROM catalog_previews WHERE id=?').get(p.previewId).payload_json);
    assert.equal(payload.input.tagName, 'chell_(portal)');
    const result = commit(db, p);
    const tag = { ...db.prepare('SELECT * FROM tag_decisions WHERE character_id=?').get(result.characterId) };
    assert.deepEqual(tag, { character_id: result.characterId, status: 'approve', tag_name: 'chell_(portal)',
      source: 'manual', updated_at: new Date(1001).toISOString() });
    assert.deepEqual(JSON.parse(db.prepare('SELECT after_json FROM catalog_mutations WHERE id=?').get(result.mutationId).after_json).tag, tag);
    db.exec('DELETE FROM tag_search_cache');
    assert.deepEqual(commit(db, p, { now: p.expiresAt + 1 }), result, 'committed retry needs no evidence or network');
    assert.equal(db.prepare('SELECT count(*) AS n FROM tag_decisions').get().n, 1);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});

test('creation rejects invalid/unverified tags and rechecks exact active category-4 cached evidence on confirm', () => {
  const db = fixture();
  try {
    for (const tagName of [[], ['chell'], {}, 1, 'x', 'UPPER', 'foo bar', 'foo,bar', 'foo*bar', 'x'.repeat(121)]) {
      unchanged(db, () => makePreview(db, { input: input({ tagName }) }), /Invalid character tag/);
    }
    const tagName = 'chell_(portal)';
    unchanged(db, () => makePreview(db, { input: input({ tagName }) }), /verified/);
    for (const evidence of ['{bad', {}, [], [{ name: 'other_tag', category: 4 }],
      [{ name: tagName, category: 0 }], [{ name: tagName, category: 4, is_deprecated: true }]]) {
      cacheTag(db, tagName, evidence);
      unchanged(db, () => makePreview(db, { input: input({ tagName }) }), /verified/);
    }
    cacheTag(db, tagName);
    const p = makePreview(db, { input: input({ tagName }) });
    for (const evidence of ['null', [{ name: tagName, category: 0 }], [{ name: tagName, category: 4, is_deprecated: true }]]) {
      cacheTag(db, tagName, evidence);
      unchanged(db, () => commit(db, p), /verified/);
    }
    db.exec('DELETE FROM tag_search_cache');
    unchanged(db, () => commit(db, p), /verified/);
    cacheTag(db, tagName);
    assert.equal(commit(db, p).revision, 1);
  } finally { db.close(); }
});

test('canonical payload hashes are stable across object key order and bind rank/reason', () => {
  const db = fixture();
  try {
    const p = makePreview(db);
    const reversed = Object.fromEntries(Object.entries(input()).reverse());
    assert.equal(makePreview(db, { input: reversed }).payloadHash, p.payloadHash);
    assert.notEqual(makePreview(db, { rank: 3 }).payloadHash, p.payloadHash);
    assert.notEqual(makePreview(db, { duplicateOverrideReason: 'Distinct' }).payloadHash, p.payloadHash);
    assert.equal(JSON.parse(db.prepare('SELECT payload_json FROM catalog_previews WHERE id=?').get(p.previewId).payload_json).input.name, 'Chell');
  } finally { db.close(); }
});

test('empty, leader, middle gaps, adjacent counts, ties and end give exact ranks without changing existing likes/order', () => {
  for (const [likes, rank, expected] of [[[], 1, 0], [[10], 1, 11], [[10], 2, 9],
    [[0], 2, 0], [[100, 10], 2, 55], [[10, 9], 2, 9], [[10, 10, 10], 2, 10], [[10, 10, 10], 3, 10]]) {
    const db = fixture(likes);
    try {
      const before = rows(db);
      // Noncanonical tie orders exercise collisions with BOTH unique indexes.
      db.exec('UPDATE characters SET tie_order=tie_order+100');
      const p = makePreview(db, { rank });
      assert.equal(p.favourites, expected);
      const result = commit(db, p);
      const next = rows(db);
      assert.equal(next[rank - 1].id, result.characterId);
      assert.deepEqual(next.map(row => row.rank), next.map((_, i) => i + 1));
      assert.deepEqual(next.map(row => row.tie_order), next.map((_, i) => i + 1));
      assert.deepEqual(next.filter(row => row.id !== result.characterId).map(row => [row.id, row.favourites]), before.map(row => [row.id, row.favourites]));
      const sorted = db.prepare('SELECT id FROM characters ORDER BY favourites DESC, tie_order').all().map(row => row.id);
      assert.deepEqual(sorted, next.map(row => row.id));
    } finally { db.close(); }
  }
});

test('all explicit gender mappings including unknown are persisted', () => {
  for (const [gender, expected] of [['female', 'Female'], ['male', 'Male'], ['nonbinary', 'Non-binary'], ['unknown', null]]) {
    const db = fixture([]);
    try {
      const result = commit(db, makePreview(db, { rank: 1, input: input({ gender }) }));
      assert.equal(db.prepare('SELECT gender FROM characters WHERE id=?').get(result.characterId).gender, expected);
    } finally { db.close(); }
  }
});

test('duplicate warnings cover normalized full/native/imported/curated aliases and are advisory only', () => {
  const db = fixture();
  try {
    const first = rows(db)[0];
    db.prepare('INSERT INTO character_curated_aliases VALUES (?, ?, ?)').run(first.id, 'Curated Alias', 'curated alias');
    db.prepare('UPDATE characters SET name_native=? WHERE id=?').run('Native Name', first.id);
    for (const name of ['Ｉｍｐｏｒｔｅｄ  1', 'ALIAS 1', ' Curated   Alias ', 'native name']) {
      const p = makePreview(db, { input: input({ name }) });
      assert.equal(p.duplicateWarnings[0].id, first.id);
      assert.equal(p.duplicateWarnings[0].sources[0].source, 'anilist');
      const result = commit(db, p, { idempotencyKey: p.previewId });
      assert.notEqual(result.characterId, first.id);
      assert.equal(db.prepare('SELECT duplicate_override_reason FROM catalog_mutations WHERE id=?').get(result.mutationId).duplicate_override_reason, null);
    }
    const p = makePreview(db, { input: input({ aliases: ['Alias 1'] }), duplicateOverrideReason: ' Different adaptation ' });
    const result = commit(db, p);
    assert.notEqual(result.characterId, first.id);
    const audit = db.prepare('SELECT * FROM catalog_mutations WHERE id=?').get(result.mutationId);
    assert.equal(audit.duplicate_override_reason, 'Different adaptation');
    assert.equal(JSON.parse(audit.after_json).duplicateOverrideReason, 'Different adaptation');
  } finally { db.close(); }
});

test('idempotent retry precedes expiry, stale revisions and consumed-preview checks; keys bind account/hash', () => {
  const db = fixture();
  try {
    const p = makePreview(db);
    const result = commit(db, p);
    db.exec('UPDATE catalog_state SET revision=revision+1, source_revision=source_revision+1');
    const before = snapshot(db);
    assert.deepEqual(commit(db, p, { now: p.expiresAt + 1 }), result);
    assert.deepEqual(snapshot(db), before);
    unchanged(db, () => commit(db, p, { payloadHash: 'a'.repeat(64) }), /Idempotency key.*mismatch/);
    unchanged(db, () => commit(db, p, { idempotencyKey: 'fresh-key' }), /already confirmed/);
    unchanged(db, () => commit(db, p, { account: 'other' }), /owner/);
    assert.equal(db.prepare('SELECT count(*) AS n FROM catalog_mutations').get().n, 1);
  } finally { db.close(); }
});

test('confirmation rejects wrong owner/role/hash, missing preview, expiry, future time and tampered payload', () => {
  const db = fixture();
  try {
    const p = makePreview(db);
    for (const [options, pattern] of [[{ account: 'other' }, /owner/], [{ role: 'admin' }, /role/],
      [{ payloadHash: 'a'.repeat(64) }, /hash mismatch/], [{ previewId: 'missing' }, /missing/],
      [{ now: p.expiresAt }, /expired/], [{ now: 999 }, /timestamp/]]) {
      unchanged(db, () => commit(db, p, options), pattern);
    }
    db.prepare("UPDATE catalog_previews SET payload_json='{}' WHERE id=?").run(p.previewId);
    unchanged(db, () => commit(db, p), /Stored preview.*mismatch/);
  } finally { db.close(); }
});

test('each revision dimension, an actual source publication and a second manual creation invalidate previews', () => {
  for (const revision of ['revision', 'source_revision', 'appearance_revision', 'import', 'manual']) {
    const db = fixture();
    try {
      const p = makePreview(db);
      if (revision === 'import') {
        db.exec('BEGIN IMMEDIATE');
        try {
          bindSourceCatalogStaging(db);
          // A bound scan refreshes an existing source, rather than publishing empty staging.
          db.exec("INSERT INTO stage_characters(id,favourites,name_full) VALUES(1,101,'Refreshed imported 1')");
          publishSourceCatalog(db);
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      } else if (revision === 'manual') {
        commit(db, makePreview(db, { input: input({ name: 'Another' }) }), { idempotencyKey: 'another' });
      } else db.exec(`UPDATE catalog_state SET ${revision}=${revision}+1`);
      unchanged(db, () => commit(db, p), /Stale catalog preview/);
    } finally { db.close(); }
  }
});

test('validation/authentication/unknown franchises fail without any writes', () => {
  const db = fixture();
  try {
    for (const role of [undefined, null, '', 'mod', 'user', 'Admin']) {
      unchanged(db, () => makePreview(db, { role }), /Unauthorized/);
      unchanged(db, () => confirm(db, { ...auth, role }), /Unauthorized/);
    }
    for (const account of [undefined, null, '', ' ', 1, 'a'.repeat(121), 'a\nb']) {
      unchanged(db, () => makePreview(db, { account }), /account/);
      unchanged(db, () => confirm(db, { ...auth, account }), /account/);
    }
    for (const overrides of [{ name: '' }, { name: 'x'.repeat(121) }, { name: 'a\u0000b' },
      { aliases: 'bad' }, { aliases: ['x'.repeat(121)] }, { aliases: Array(51).fill('x') },
      { gender: '' }, { gender: 'Female' }, { franchiseIds: [] }, { franchiseIds: [0] },
      { franchiseIds: [1.5] }, { franchiseIds: ['1'] }, { franchiseIds: [Number.MAX_SAFE_INTEGER + 1] },
      { franchiseIds: [999] }, { description: 'x'.repeat(4001) },
      { portraitUrl: 'http://example.test/a' }, { portraitUrl: 'https://user:pass@example.test/a' },
      { portraitUrl: 'https://example.test/' + 'x'.repeat(2048) }, { referenceUrl: 'file:///secret' },
      { tag: 'chell' }, { approvedTag: 'chell' }, { id: 'injected' }, { favourites: 100 }]) {
      unchanged(db, () => makePreview(db, { input: input(overrides) }));
    }
    for (const rank of [0, -1, 1.5, 6, '2', NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
      unchanged(db, () => makePreview(db, { rank }), /rank/);
    }
    for (const duplicateOverrideReason of ['', '  ', 'x'.repeat(2001), 1]) {
      unchanged(db, () => makePreview(db, { duplicateOverrideReason }), /reason/);
    }
    for (const now of [-1, 1.5, Infinity, NaN, 8.64e15 + 1, Number.MAX_SAFE_INTEGER]) {
      unchanged(db, () => makePreview(db, { now }), /timestamp|overflow/);
    }
  } finally { db.close(); }
});

test('confirmation validates request bounds and rechecks franchises', () => {
  const db = fixture();
  try {
    const p = makePreview(db);
    for (const options of [{ idempotencyKey: '' }, { idempotencyKey: 'k'.repeat(201) },
      { previewId: '' }, { previewId: 'p'.repeat(101) }, { payloadHash: 'A'.repeat(64) },
      { payloadHash: 'a' }, { now: -1 }]) unchanged(db, () => commit(db, p, options));
    db.exec('DELETE FROM franchises WHERE id=1');
    unchanged(db, () => commit(db, p), /Unknown franchise/);
  } finally { db.close(); }
});

test('overflow refuses likes, temporary rank/tie orders and revision without partial writes', () => {
  const likesDb = fixture([Number.MAX_SAFE_INTEGER]);
  try { unchanged(likesDb, () => makePreview(likesDb, { rank: 1 }), /overflow/); }
  finally { likesDb.close(); }
  for (const column of ['rank', 'tie_order', 'revision']) {
    const db = fixture([10]);
    try {
      if (column === 'revision') db.prepare('UPDATE catalog_state SET revision=?').run(Number.MAX_SAFE_INTEGER);
      else db.prepare(`UPDATE characters SET ${column}=?`).run(Number.MAX_SAFE_INTEGER);
      const p = makePreview(db, { rank: 1 });
      unchanged(db, () => commit(db, p), /overflow/);
    } finally { db.close(); }
  }
});

test('late failure trigger rolls back identity, order, membership, revisions, metadata, audit and result; retry succeeds', () => {
  const db = fixture();
  try {
    cacheTag(db, 'chell_(portal)');
    const p = makePreview(db, { input: input({ tagName: 'chell_(portal)' }) });
    db.exec(`CREATE TRIGGER fail_confirmation BEFORE INSERT ON catalog_confirmation_results
      BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
    unchanged(db, () => commit(db, p), /injected failure/);
    db.exec('DROP TRIGGER fail_confirmation');
    assert.equal(commit(db, p).revision, 1);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});

test('caller transaction is rejected without rollback, even on a committed retry', () => {
  const db = fixture();
  try {
    const p = makePreview(db);
    commit(db, p);
    db.exec("BEGIN; INSERT INTO catalog_meta VALUES ('caller-owned', 'pending')");
    const before = snapshot(db);
    assert.throws(() => makePreview(db), /transaction/i);
    assert.throws(() => commit(db, p), /transaction/i);
    assert.deepEqual(snapshot(db), before);
    db.exec('ROLLBACK');
    assert.equal(db.prepare("SELECT 1 FROM catalog_meta WHERE key='caller-owned'").get(), undefined);
  } finally { db.close(); }
});

test('service rejects other schema versions and foreign keys off without mutation', () => {
  const db = fixture();
  try {
    for (const version of [10, 11, 13]) {
      db.exec(`PRAGMA user_version=${version}`);
      unchanged(db, () => makePreview(db), /version 12/);
    }
    db.exec('PRAGMA user_version=12; PRAGMA foreign_keys=OFF');
    unchanged(db, () => makePreview(db), /foreign_keys ON/);
  } finally { db.close(); }
});
