import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCatalog } from '../lib/catalogDb.js';
import { convertLegacyCatalogToFinal } from '../lib/characterIdentityMigration.js';
import { previewManualCharacterCreation, confirmManualCharacterCreation } from '../lib/manualCharacterMutations.js';
import { previewCatalogMutation, confirmCatalogMutation, CATALOG_PREVIEW_TTL_MS } from '../lib/catalogMutations.js';
import { findCharacters, loadCharacterIndex } from '../lib/gameCharacterLookup.js';
import { loadFranchiseIndex, findFranchises, loadFranchiseCharacters, loadFranchiseCover } from '../lib/franchiseLookup.js';

const auth = { account: 'editor', role: 'moderator' };
function fixture(likes = [100, 50, 50, 0], path = ':memory:') {
  const db = openCatalog(path);
  const add = db.prepare('INSERT INTO characters (id,rank,favourites,name_full,name_alternatives,gender) VALUES (?, ?, ?, ?, ?, ?)');
  likes.forEach((count, i) => {
    add.run(i + 1, i + 1, count, `Imported ${i + 1}`, JSON.stringify([`Alias ${i + 1}`]), 'Male');
    db.prepare('INSERT INTO character_identities (id,name_full) VALUES (?, ?)').run(i + 1, `Imported ${i + 1}`);
  });
  db.exec("INSERT INTO franchises (id,display_name,created_at) VALUES (1,'Portal','test'),(2,'Other','test')");
  convertLegacyCatalogToFinal(db, { dryRun: false });
  for (const name of ['test_tag', 'chell_(portal)', 'safe_tag']) cacheTag(db, name);
  return db;
}
function cacheTag(db, name, extra = {}) {
  const params = new URLSearchParams({ 'search[name]': name, 'search[category]': '4', limit: '5' });
  db.prepare('INSERT OR REPLACE INTO tag_search_cache VALUES (?, ?, ?)')
    .run(`/tags.json?${params}`, JSON.stringify([{ name, category: 4, is_deprecated: false, ...extra }]), 'test');
}
const rows = db => db.prepare('SELECT * FROM characters ORDER BY rank').all();
const preview = (db, operation, input, extra = {}) => previewCatalogMutation(db, { ...auth, operation, input, now: 1000, ...extra });
const confirm = (db, p, extra = {}) => confirmCatalogMutation(db, { ...auth, previewId: p.previewId,
  payloadHash: p.payloadHash, idempotencyKey: p.previewId, now: 1001, ...extra });
function manual(db) {
  const p = previewManualCharacterCreation(db, { ...auth, now: 100, rank: 1,
    input: { name: 'Chell', gender: 'female', portraitUrl: 'https://example.test/chell', franchiseIds: [1] } });
  return confirmManualCharacterCreation(db, { ...auth, ...p, now: 101, idempotencyKey: 'create' }).characterId;
}
function dump(db) {
  return Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(({ name }) => [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]));
}
function unchanged(db, fn, pattern) {
  const before = dump(db); assert.throws(fn, pattern); assert.deepEqual(dump(db), before);
}

test('manual linked metadata edits preserve identity, source and likes; aliases and memberships feed read models', () => {
  const db = fixture();
  try {
    const id = manual(db);
    db.prepare("INSERT INTO character_sources VALUES ('anilist', '99999', ?)").run(id);
    const old = rows(db).find(r => r.id === id);
    const appearanceBefore = db.prepare('SELECT appearance_revision FROM catalog_state').get().appearance_revision;
    const p = preview(db, 'edit', { characterId: id, name: 'GLaDOS', aliases: ['Potato'], gender: 'unknown',
      description: 'Line one\nLine two', portraitUrl: 'https://example.test/new', franchiseIds: [2], referenceUrl: 'https://example.test/ref' });
    assert.equal(rows(db).find(r => r.id === id).name_full, 'Chell');
    const result = confirm(db, p);
    assert.equal(result.appearanceRevision, appearanceBefore + 1);
    const after = rows(db).find(r => r.id === id);
    for (const key of ['id', 'rank', 'favourites', 'tie_order', 'likes_source']) assert.equal(after[key], old[key]);
    assert.equal(after.name_full, 'GLaDOS'); assert.equal(after.gender, null);
    assert.equal(after.description, 'Line one\nLine two');
    assert.equal(db.prepare('SELECT name_full FROM character_identities WHERE id=?').get(id).name_full, 'GLaDOS');
    assert.equal(db.prepare('SELECT external_id FROM character_sources WHERE character_id=?').get(id).external_id, '99999');
    assert.equal(findCharacters(loadCharacterIndex(db), 'Potato')[0].id, id);
    assert.deepEqual(db.prepare('SELECT franchise_id FROM effective_character_franchises WHERE character_id=?').all(id).map(r => r.franchise_id), [2]);
    const audit = db.prepare('SELECT * FROM catalog_mutations WHERE id=?').get(result.mutationId);
    assert.equal(audit.account, auth.account); assert.equal(audit.role, auth.role);
    assert.equal(JSON.parse(audit.before_json).character.name_full, 'Chell');
    assert.equal(JSON.parse(audit.after_json).character.name_full, 'GLaDOS');
    assert.equal(db.prepare("SELECT value FROM catalog_meta WHERE key='catalog_revision'").get().value, String(result.revision));
    assert.equal(db.prepare('SELECT source_revision FROM catalog_state').get().source_revision, 0);
  } finally { db.close(); }
});

test('imported metadata restrictions, unknown fields, patch validation and no free-form likes', () => {
  const db = fixture();
  try {
    const id = rows(db)[0].id;
    for (const key of ['name', 'gender', 'portraitUrl', 'description']) unchanged(db,
      () => preview(db, 'edit', { characterId: id, [key]: null }), /Imported metadata/);
    for (const field of ['favourites', 'likes', 'likesSource', 'id', 'site_url', 'name_native']) unchanged(db,
      () => preview(db, 'edit', { characterId: id, [field]: 100 }), /Unknown field/);
    const result = confirm(db, preview(db, 'edit', { characterId: id, aliases: ['Curated'], franchiseIds: [1, 1, 2], referenceUrl: 'https://example.test/' }));
    assert.equal(result.appearanceRevision, 1);
    assert.equal(findCharacters(loadCharacterIndex(db), 'Curated')[0].id, id);
    assert.equal(rows(db)[0].name_full, 'Imported 1');
    const mid = manual(db);
    for (const patch of [{ name: '' }, { gender: 'Female' }, { portraitUrl: 'http://example.test' },
      { description: 'x'.repeat(4001) }, { franchiseIds: [] }, { franchiseIds: [999] }, { aliases: [''] },
      { referenceUrl: 'https://user:pass@example.test' }, { referenceUrl: 'file:///tmp/a' }]) unchanged(db,
      () => preview(db, 'edit', { characterId: mid, ...patch }));
    unchanged(db, () => preview(db, 'edit', { characterId: mid }), /Empty edit/);
    unchanged(db, () => previewCatalogMutation(db, { ...auth, operation: 'edit', input: { characterId: id, aliases: [] }, surprise: 1 }), /Unknown field/);
    unchanged(db, () => preview(db, 'delete', { characterId: id }), /Unsupported/);
  } finally { db.close(); }
});

test('reposition excludes mover, generates exact final rank including ties and boundaries, preserves everyone else', () => {
  for (const [likes, from, rank, expected] of [[[100, 50, 50, 0], 0, 3, 25], [[10, 10, 10], 0, 2, 10],
    [[10, 10, 10], 2, 2, 10], [[0, 0, 0], 0, 3, 0], [[10, 9], 1, 1, 11], [[10], 0, 1, 0]]) {
    const db = fixture(likes);
    try {
      db.exec('UPDATE characters SET tie_order=tie_order+100');
      const before = rows(db); const id = before[from].id;
      unchanged(db, () => preview(db, 'reposition', { characterId: id, rank }), /switchToGenerated/);
      const p = preview(db, 'reposition', { characterId: id, rank, switchToGenerated: true });
      assert.equal(p.favourites, expected);
      const remaining = before.filter(r => r.id !== id);
      assert.equal(p.upperId, remaining[rank - 2]?.id ?? null);
      assert.equal(p.lowerId, remaining[rank - 1]?.id ?? null);
      const result = confirm(db, p);
      assert.equal(result.rank, rank); assert.equal(result.favourites, expected); assert.equal(result.appearanceRevision, 0);
      const after = rows(db);
      assert.equal(after[rank - 1].id, id); assert.equal(after[rank - 1].likes_source, 'generated');
      assert.deepEqual(after.filter(r => r.id !== id).map(r => [r.id, r.favourites]), remaining.map(r => [r.id, r.favourites]));
      assert.deepEqual(db.prepare('SELECT id FROM characters ORDER BY favourites DESC,tie_order').all().map(r => r.id), after.map(r => r.id));
      assert.deepEqual(after.map(r => r.tie_order), after.map((_, i) => i + 1));
      assert.equal(findCharacters(loadCharacterIndex(db), `#${rank}`)[0].id, id);
    } finally { db.close(); }
  }
});

test('durable request-bound retries precede expiry/staleness and reject different key/hash/preview/role/account', () => {
  const db = fixture();
  try {
    const input = { characterId: rows(db)[0].id, aliases: ['Curated'] };
    const p = preview(db, 'edit', input);
    const result = confirm(db, p, { idempotencyKey: 'key' });
    const later = preview(db, 'edit', input);
    assert.equal(later.payloadHash, p.payloadHash);
    const before = dump(db);
    assert.deepEqual(confirm(db, p, { idempotencyKey: 'key', now: 1000 + CATALOG_PREVIEW_TTL_MS * 2 }), result);
    assert.deepEqual(dump(db), before);
    for (const [extra, pattern] of [[{ payloadHash: 'a'.repeat(64) }, /hash mismatch/],
      [{ previewId: later.previewId }, /request mismatch/], [{ role: 'admin' }, /request mismatch/],
      [{ account: 'another' }, /owner/]]) unchanged(db, () => confirm(db, p, { idempotencyKey: 'key', ...extra }), pattern);
    unchanged(db, () => confirm(db, p, { idempotencyKey: 'new' }), /already confirmed/);
    assert.equal(db.prepare('SELECT count(*) n FROM catalog_mutations').get().n, 1);
  } finally { db.close(); }
});

test('all revisions stale; malformed/expired/tampered confirmations cannot publish', () => {
  for (const column of ['revision', 'source_revision', 'appearance_revision']) {
    const db = fixture();
    try {
      const p = preview(db, 'tag', { characterId: rows(db)[0].id, status: 'approve', tagName: 'test_tag' });
      db.exec(`UPDATE catalog_state SET ${column}=${column}+1`);
      unchanged(db, () => confirm(db, p), /Stale/);
    } finally { db.close(); }
  }
  const db = fixture();
  try {
    const p = preview(db, 'edit', { characterId: rows(db)[0].id, aliases: [] });
    for (const [extra, pattern] of [[{ account: 'other' }, /owner/], [{ role: 'admin' }, /role/],
      [{ now: 999 }, /timestamp/], [{ now: p.expiresAt }, /expired/], [{ payloadHash: 'a'.repeat(64) }, /hash mismatch/],
      [{ payloadHash: 'A'.repeat(64) }, /Invalid payload/], [{ idempotencyKey: '' }, /idempotency/]]) unchanged(db, () => confirm(db, p, extra), pattern);
    unchanged(db, () => confirmCatalogMutation(db, { ...auth, ...p, idempotencyKey: 'key', unknown: true }), /Unknown field/);
    db.prepare("UPDATE catalog_previews SET payload_json='{}' WHERE id=?").run(p.previewId);
    unchanged(db, () => confirm(db, p), /Stored preview/);
  } finally { db.close(); }
});

test('tags follow literal approval/no-match constraints with durable attribution, no network or appearance invalidation', () => {
  const db = fixture();
  try {
    const id = rows(db)[0].id;
    for (const tagName of ['x', 'foo rating:e', 'foo/bar', 'UPPER', 'x'.repeat(121)]) unchanged(db,
      () => preview(db, 'tag', { characterId: id, status: 'approve', tagName }), /Invalid tag/);
    unchanged(db, () => preview(db, 'tag', { characterId: id, status: 'no_match', tagName: 'foo' }), /cannot include/);
    unchanged(db, () => preview(db, 'tag', { characterId: id, status: 'approve', tagName: 'unverified' }), /verified/);
    cacheTag(db, 'deprecated', { is_deprecated: true });
    cacheTag(db, 'general_tag', { category: 0 });
    for (const tagName of ['deprecated', 'general_tag']) unchanged(db,
      () => preview(db, 'tag', { characterId: id, status: 'approve', tagName }), /verified/);
    const p = preview(db, 'tag', { characterId: id, status: 'approve', tagName: 'chell_(portal)' });
    assert.equal(confirm(db, p).appearanceRevision, 0);
    assert.deepEqual({ ...db.prepare('SELECT * FROM tag_decisions').get() }, { character_id: id, status: 'approve',
      tag_name: 'chell_(portal)', source: 'manual', updated_at: new Date(1001).toISOString() });
    confirm(db, preview(db, 'tag', { characterId: id, status: 'no_match' }));
    assert.equal(db.prepare('SELECT tag_name FROM tag_decisions').get().tag_name, null);
  } finally { db.close(); }
});

test('franchise bootstrap/create/edit supports HTTPS cover/reference, curated aliases and shared read model', () => {
  const db = fixture([]);
  try {
    const p = preview(db, 'franchise_create', { displayName: 'Half Life', aliases: ['Black Mesa'],
      coverUrl: 'https://example.test/cover', referenceUrl: 'https://example.test/reference' });
    const result = confirm(db, p);
    assert.equal(result.appearanceRevision, 0);
    const id = result.franchiseId;
    assert.deepEqual(confirm(db, p), result);
    let row = db.prepare('SELECT * FROM franchises WHERE id=?').get(id);
    assert.equal(row.display_name, 'Half Life'); assert.equal(row.curated_cover_url, 'https://example.test/cover');
    assert.equal(loadFranchiseCover(db, id), 'https://example.test/cover');
    db.prepare("INSERT INTO franchise_aliases VALUES (?, 'Source Alias', 'source alias', 'automatic')").run(id);
    confirm(db, preview(db, 'franchise_edit', { franchiseId: id, displayName: 'Half-Life', aliases: ['Lambda'], coverUrl: null, referenceUrl: null }));
    row = db.prepare('SELECT * FROM franchises WHERE id=?').get(id);
    assert.equal(row.display_name, 'Half-Life'); assert.equal(row.curated_cover_url, null); assert.equal(row.reference_url, null);
    assert.deepEqual(db.prepare('SELECT alias FROM franchise_aliases WHERE franchise_id=? ORDER BY normalized_alias').all(id).map(r => r.alias), ['Half-Life', 'Lambda', 'Source Alias']);
    assert.equal(findFranchises(loadFranchiseIndex(db), 'Lambda')[0].id, id);
    assert.equal(loadFranchiseCover(db, id), null);
    const audit = db.prepare('SELECT * FROM catalog_mutations WHERE id=?').get(result.mutationId);
    assert.equal(audit.character_id, null); assert.deepEqual(JSON.parse(audit.before_json), {});
    assert.equal(JSON.parse(audit.after_json).franchise.id, id);
    for (const patch of [{ coverUrl: 'http://example.test' }, { referenceUrl: 'javascript:alert(1)' }, { coverUrl: 'https://u:p@example.test' },
      { displayName: '' }, { aliases: ['x'] }, { animeIds: [1] }]) unchanged(db, () => preview(db, 'franchise_edit', { franchiseId: id, ...patch }));
    unchanged(db, () => preview(db, 'franchise_edit', { franchiseId: 999, displayName: 'Missing' }), /Unknown franchise/);
  } finally { db.close(); }
});

test('only changed effective membership increments appearance revision; duplicate direct/derived membership is deduplicated', () => {
  const db = fixture();
  try {
    const id = manual(db);
    db.exec("INSERT INTO anime (id,title_romaji,fetched_at) VALUES (10,'Portal Anime','test'); INSERT INTO franchise_anime VALUES (1,10,'automatic')");
    db.prepare('INSERT INTO character_anime (character_id,anime_id) VALUES (?,10)').run(id);
    const base = db.prepare('SELECT appearance_revision FROM catalog_state').get().appearance_revision;
    assert.equal(confirm(db, preview(db, 'edit', { characterId: id, franchiseIds: [] })).appearanceRevision, base);
    assert.equal(confirm(db, preview(db, 'edit', { characterId: id, franchiseIds: [1] })).appearanceRevision, base);
    assert.equal(confirm(db, preview(db, 'edit', { characterId: id, franchiseIds: [1, 2] })).appearanceRevision, base + 1);
    assert.equal(confirm(db, preview(db, 'edit', { characterId: id, name: 'Chell Updated' })).appearanceRevision, base + 1);
    assert.equal(loadFranchiseCharacters(db, 1).filter(row => row.id === id).length, 1);
    assert.equal(loadFranchiseCharacters(db, 2).filter(row => row.id === id).length, 1);
    assert.deepEqual(db.prepare('SELECT franchise_id FROM effective_character_franchises WHERE character_id=? ORDER BY franchise_id').all(id).map(r => r.franchise_id), [1, 2]);
  } finally { db.close(); }
});

test('duplicate edit warnings are advisory, retain optional audited explanation and never merge identities', () => {
  const db = fixture();
  try {
    const id = manual(db);
    const p = preview(db, 'edit', { characterId: id, name: 'Ｉｍｐｏｒｔｅｄ  1' });
    assert.equal(p.duplicateWarnings.length, 1);
    const edited = confirm(db, p);
    assert.equal(rows(db).find(row => row.id === id).name_full, 'Imported  1');
    assert.equal(db.prepare('SELECT duplicate_override_reason FROM catalog_mutations WHERE id=?').get(edited.mutationId).duplicate_override_reason, null);
    const accepted = preview(db, 'edit', { characterId: id, aliases: ['Alias 1'], duplicateOverrideReason: 'Different adaptation' });
    const result = confirm(db, accepted);
    assert.equal(result.characterId, id); assert.equal(rows(db).length, 5);
    assert.equal(db.prepare('SELECT duplicate_override_reason FROM catalog_mutations WHERE id=?').get(result.mutationId).duplicate_override_reason, 'Different adaptation');
  } finally { db.close(); }
});

test('late failure atomically rolls back all mutation kinds, revisions/audit/results and permits retry', () => {
  for (const operation of ['edit', 'reposition', 'tag', 'franchise_create', 'franchise_edit']) {
    const db = fixture();
    try {
      const id = rows(db)[0].id;
      const input = { edit: { characterId: id, aliases: ['Safe'], franchiseIds: [1] },
        reposition: { characterId: id, rank: 3, switchToGenerated: true },
        tag: { characterId: id, status: 'approve', tagName: 'safe_tag' },
        franchise_create: { displayName: 'New franchise' }, franchise_edit: { franchiseId: 1, displayName: 'Renamed' } }[operation];
      const p = preview(db, operation, input);
      db.exec("CREATE TRIGGER fail_confirmation BEFORE INSERT ON catalog_confirmation_results BEGIN SELECT RAISE(ABORT,'injected'); END");
      unchanged(db, () => confirm(db, p), /injected/);
      db.exec('DROP TRIGGER fail_confirmation');
      assert.equal(confirm(db, p).revision, 1);
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    } finally { db.close(); }
  }
});

test('file-backed previews and committed retries survive restart; another writer makes pending previews stale', () => {
  const directory = mkdtempSync(join(tmpdir(), 'catalog-mutations-'));
  const path = join(directory, 'synthetic.sqlite');
  let db;
  let other;
  try {
    db = fixture([10, 10, 0], path);
    const id = rows(db)[0].id;
    const p = preview(db, 'reposition', { characterId: id, rank: 2, switchToGenerated: true });
    db.close();
    db = new DatabaseSync(path); db.exec('PRAGMA foreign_keys=ON');
    const result = confirm(db, p);
    const pending = preview(db, 'edit', { characterId: id, aliases: ['Pending'] });
    other = new DatabaseSync(path); other.exec('PRAGMA foreign_keys=ON');
    const winner = confirm(other, preview(other, 'edit', { characterId: id, aliases: ['Winner'] }));
    assert.equal(winner.revision, result.revision + 1);
    unchanged(db, () => confirm(db, pending), /Stale/);
    other.close(); other = null;
    db.close(); db = new DatabaseSync(path); db.exec('PRAGMA foreign_keys=ON');
    assert.deepEqual(confirm(db, p, { now: p.expiresAt + 1 }), result);
    assert.equal(findCharacters(loadCharacterIndex(db), 'Winner')[0].id, id);
  } finally { other?.close(); db?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('confirmation revalidates franchises/tags; unsafe likes and order overflow roll back', () => {
  const db = fixture();
  try {
    const id = rows(db)[0].id;
    const p = preview(db, 'edit', { characterId: id, franchiseIds: [2] });
    db.exec('DELETE FROM franchises WHERE id=2');
    unchanged(db, () => confirm(db, p), /Unknown franchise/);
    const tag = preview(db, 'tag', { characterId: id, status: 'approve', tagName: 'test_tag' });
    cacheTag(db, 'test_tag', { is_deprecated: true });
    unchanged(db, () => confirm(db, tag), /verified/);
    const move = preview(db, 'reposition', { characterId: id, rank: 3, switchToGenerated: true });
    db.prepare('UPDATE characters SET tie_order=? WHERE id=?').run(Number.MAX_SAFE_INTEGER, id);
    unchanged(db, () => confirm(db, move), /overflow/);
  } finally { db.close(); }
  const max = fixture([Number.MAX_SAFE_INTEGER, 0]);
  try { unchanged(max, () => preview(max, 'reposition', { characterId: rows(max)[1].id, rank: 1, switchToGenerated: true }), /overflow/); }
  finally { max.close(); }
});

test('permission, schema, timestamp, overflow and caller transaction boundaries', () => {
  const db = fixture();
  try {
    const input = { characterId: rows(db)[0].id, aliases: [] };
    for (const role of [undefined, null, '', 'user', 'Admin']) {
      unchanged(db, () => preview(db, 'edit', input, { role }), /Unauthorized/);
      unchanged(db, () => confirmCatalogMutation(db, { ...auth, role }), /Unauthorized/);
    }
    for (const account of ['', ' ', null, 1, 'a\nb', 'x'.repeat(121)]) unchanged(db, () => preview(db, 'edit', input, { account }), /account/);
    for (const now of [-1, 1.5, Infinity, 8.64e15 + 1, Number.MAX_SAFE_INTEGER]) unchanged(db, () => preview(db, 'edit', input, { now }), /timestamp|overflow/);
    for (const version of [10, 11, 13]) {
      db.exec(`PRAGMA user_version=${version}`);
      unchanged(db, () => preview(db, 'edit', input), /version 12/);
    }
    db.exec('PRAGMA user_version=12; PRAGMA foreign_keys=OFF');
    unchanged(db, () => preview(db, 'edit', input), /foreign_keys ON/);
    db.exec('PRAGMA foreign_keys=ON');
    const p = preview(db, 'edit', input);
    db.exec("BEGIN; INSERT INTO catalog_meta VALUES ('caller','owned')");
    assert.throws(() => preview(db, 'edit', input), /transaction/i);
    assert.throws(() => confirm(db, p), /transaction/i);
    assert.equal(db.prepare("SELECT value FROM catalog_meta WHERE key='caller'").get().value, 'owned');
    db.exec('ROLLBACK');
    db.prepare('UPDATE catalog_state SET revision=?').run(Number.MAX_SAFE_INTEGER);
    const overflow = preview(db, 'edit', input);
    unchanged(db, () => confirm(db, overflow), /overflow/);
  } finally { db.close(); }
});
