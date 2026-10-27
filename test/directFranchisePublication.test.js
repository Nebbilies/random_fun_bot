import test from 'node:test';
import assert from 'node:assert/strict';
import { openCatalog, setMeta } from '../lib/catalogDb.js';
import { migrateCharacterIdentities } from '../lib/characterIdentityMigration.js';
import { initializeCatalogReleaseSchema } from '../lib/catalogReleaseSchema.js';
import { publishFranchiseCatalog, mergeFranchises, createFranchise, renameFranchise,
  addFranchiseAlias, removeFranchiseAlias, moveAnimeToFranchise, removeAnimeFromFranchise,
  stageFranchiseBatch } from '../lib/franchiseCatalog.js';
import { previewManualCharacterCreation, confirmManualCharacterCreation } from '../lib/manualCharacterMutations.js';

function fixture(version = 12) {
  const db = openCatalog(':memory:');
  db.exec(`INSERT INTO characters (id, rank, favourites, name_full) VALUES (1, 1, 10, 'Imported');
    INSERT INTO character_identities (id, name_full) VALUES (1, 'Imported');
    INSERT INTO franchises (id, display_name, created_at) VALUES
      (1, 'Source', 'synthetic'), (2, 'Target', 'synthetic'), (3, 'Unused', 'synthetic');
    INSERT INTO anime (id, title_english, fetched_at) VALUES (10, 'Anime', 'synthetic');
    INSERT INTO character_anime VALUES (1, 10);
    INSERT INTO franchise_anime VALUES (1, 10, 'automatic');`);
  if (version >= 11) migrateCharacterIdentities(db, { dryRun: false, targetVersion: 11 });
  if (version === 12) initializeCatalogReleaseSchema(db);
  setMeta(db, 'published_at', 'synthetic-source');
  setMeta(db, 'franchise_import_source_published_at', 'synthetic-source');
  if (version === 12) setMeta(db, 'franchise_import_source_token', 'source:0');
  return db;
}
const state = db => ({ ...db.prepare('SELECT * FROM catalog_state').get() });
const character = db => db.prepare('SELECT id FROM characters ORDER BY rank LIMIT 1').get().id;
function stage(db, withAppearance = false) {
  stageFranchiseBatch(db, { media: [{ id: 20, title: { english: 'Next Anime' } }],
    appearances: withAppearance ? [[character(db), 20]] : [], relations: [], cursor: 1 });
}
function snapshot(db) {
  return Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
}
const auth = { account: 'editor', role: 'moderator' };
function preview(db) {
  return previewManualCharacterCreation(db, { ...auth, now: 1000, rank: 2,
    input: { name: 'Manual Hero', aliases: [], gender: 'unknown', franchiseIds: [2],
      portraitUrl: 'https://example.test/hero' } });
}

test('publication retains automatic direct-only franchises and characters but prunes unreferenced ones', () => {
  const db = fixture();
  try {
    const p = preview(db);
    const created = confirmManualCharacterCreation(db, { ...auth, previewId: p.previewId,
      payloadHash: p.payloadHash, idempotencyKey: 'create', now: 1001 });
    const before = db.prepare('SELECT * FROM characters ORDER BY rank').all();
    setMeta(db, 'franchise_import_source_published_at', new Date(1001).toISOString());
    stage(db, true);
    publishFranchiseCatalog(db);
    assert.ok(db.prepare('SELECT 1 FROM franchises WHERE id=2').get());
    assert.equal(db.prepare('SELECT 1 FROM franchises WHERE id=3').get(), undefined);
    assert.deepEqual(db.prepare('SELECT * FROM characters ORDER BY rank').all(), before);
    assert.deepEqual(db.prepare('SELECT franchise_id FROM effective_character_franchises WHERE character_id=?')
      .all(created.characterId).map(row => row.franchise_id), [2]);
    assert.deepEqual(state(db), { singleton: 1, revision: 2, source_revision: 0, appearance_revision: 2 });
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});

test('merge moves and deduplicates direct memberships, preserving characters and target curated fields', () => {
  const db = fixture();
  try {
    const id = character(db);
    db.prepare('INSERT INTO character_franchise_memberships VALUES (?, 1), (?, 2)').run(id, id);
    db.exec(`UPDATE franchises SET curated_cover_url='https://example.test/source', reference_url='source reference' WHERE id=1;
      UPDATE franchises SET curated_cover_url='https://example.test/target', reference_url='target reference' WHERE id=2;`);
    const before = db.prepare('SELECT * FROM characters').all();
    mergeFranchises(db, 1, 2);
    assert.deepEqual(db.prepare('SELECT * FROM characters').all(), before);
    assert.deepEqual(db.prepare('SELECT * FROM character_franchise_memberships').all().map(row => ({ ...row })),
      [{ character_id: id, franchise_id: 2 }]);
    assert.equal(db.prepare('SELECT 1 FROM franchises WHERE id=1').get(), undefined);
    const target = db.prepare('SELECT * FROM franchises WHERE id=2').get();
    assert.equal(target.curated_cover_url, 'https://example.test/target');
    assert.equal(target.reference_url, 'target reference');
    assert.deepEqual(state(db), { singleton: 1, revision: 1, source_revision: 0, appearance_revision: 1 });
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});

test('all public franchise mutations advance typed revision; only effective membership changes advance appearances', () => {
  const db = fixture();
  try {
    let revision = 0;
    const check = (action, appearances) => {
      action();
      assert.deepEqual(state(db), { singleton: 1, revision: ++revision, source_revision: 0, appearance_revision: appearances });
    };
    check(() => createFranchise(db, 'New Franchise'), 0);
    check(() => renameFranchise(db, 2, 'Renamed Target'), 0);
    check(() => addFranchiseAlias(db, 2, 'Alias'), 0);
    check(() => removeFranchiseAlias(db, 2, 'Alias'), 0);
    check(() => moveAnimeToFranchise(db, 10, 2), 1);
    check(() => moveAnimeToFranchise(db, 10, 2), 1);
    check(() => removeAnimeFromFranchise(db, 10), 2);
    stage(db);
    assert.equal(state(db).revision, revision);
    check(() => publishFranchiseCatalog(db), 2);
    stage(db);
    check(() => publishFranchiseCatalog(db), 2);
  } finally { db.close(); }
});

test('direct-only merge migrates a source-only membership without requiring anime', () => {
  const db = fixture();
  try {
    const id = character(db);
    db.exec('DELETE FROM franchise_anime; DELETE FROM character_anime');
    db.prepare('INSERT INTO character_franchise_memberships VALUES (?, 1)').run(id);
    mergeFranchises(db, 1, 2);
    assert.deepEqual(db.prepare('SELECT * FROM character_franchise_memberships').all().map(row => ({ ...row })),
      [{ character_id: id, franchise_id: 2 }]);
    assert.deepEqual(state(db), { singleton: 1, revision: 1, source_revision: 0, appearance_revision: 1 });
  } finally { db.close(); }
});

test('merge does not fill NULL target curated fields from source', () => {
  const db = fixture();
  try {
    db.exec("UPDATE franchises SET curated_cover_url='https://example.test/source', reference_url='source' WHERE id=1");
    mergeFranchises(db, 1, 2);
    const target = db.prepare('SELECT * FROM franchises WHERE id=2').get();
    assert.equal(target.curated_cover_url, null);
    assert.equal(target.reference_url, null);
  } finally { db.close(); }
});

for (const version of [10, 11]) {
  test(`legacy v${version} publish and merge work without extension relations`, () => {
    const db = fixture(version);
    try {
      mergeFranchises(db, 1, 2);
      assert.equal(db.prepare('SELECT franchise_id FROM franchise_anime WHERE anime_id=10').get().franchise_id, 2);
      stage(db, true);
      publishFranchiseCatalog(db);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM character_anime').get().n, 1);
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, version);
      assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='catalog_state'").get(), undefined);
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    } finally { db.close(); }
  });
}

for (const operation of ['publication', 'merge']) {
  for (const failure of ['revision', 'appearance_revision', 'late trigger']) {
    test(`${operation} rolls back all rows on ${failure} failure`, () => {
      const db = fixture();
      try {
        db.prepare('INSERT INTO character_franchise_memberships VALUES (?, 1)').run(character(db));
        if (operation === 'publication') stage(db, true);
        if (failure === 'late trigger') db.exec(`CREATE TRIGGER fail_revision BEFORE UPDATE ON catalog_state
          BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
        else db.prepare(`UPDATE catalog_state SET ${failure}=?`).run(Number.MAX_SAFE_INTEGER);
        const before = snapshot(db);
        assert.throws(() => operation === 'publication' ? publishFranchiseCatalog(db) : mergeFranchises(db, 1, 2),
          /overflow|injected failure/);
        assert.deepEqual(snapshot(db), before);
        assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      } finally { db.close(); }
    });
  }
}

for (const operation of ['publication', 'merge']) {
  test(`${operation} makes a creation preview stale`, () => {
    const db = fixture();
    try {
      const p = preview(db);
      if (operation === 'publication') { stage(db); publishFranchiseCatalog(db); }
      else mergeFranchises(db, 1, 2);
      const before = snapshot(db);
      assert.throws(() => confirmManualCharacterCreation(db, { ...auth, previewId: p.previewId,
        payloadHash: p.payloadHash, idempotencyKey: 'stale', now: 1001 }), /Stale catalog preview/);
      assert.deepEqual(snapshot(db), before);
    } finally { db.close(); }
  });
}
