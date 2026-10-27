import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openCatalog } from '../lib/catalogDb.js';
import { migrateCharacterIdentities } from '../lib/characterIdentityMigration.js';
import { CATALOG_RELEASE_VERSION, initializeCatalogReleaseSchema } from '../lib/catalogReleaseSchema.js';

function fixture(path = ':memory:') {
  const db = openCatalog(path);
  db.exec(`INSERT INTO characters(id, rank, favourites, name_full, name_alternatives)
    VALUES (1, 1, 50, 'First', '["Imported alias"]'), (2, 2, 20, 'Second', '[]');
    INSERT INTO character_identities(id, name_full) VALUES (1, 'First'), (2, 'Second');
    INSERT INTO franchises(id, display_name, created_at) VALUES (1, 'Series', 'synthetic');
    INSERT INTO character_anime VALUES (1, 100), (1, 101);
    INSERT INTO franchise_anime VALUES (1, 100, 'automatic'), (1, 101, 'automatic');
    INSERT INTO catalog_meta VALUES ('published_at', 'untouched');`);
  migrateCharacterIdentities(db, { dryRun: false, targetVersion: 11 });
  return db;
}
const version = db => db.prepare('PRAGMA user_version').get().user_version;
const id = db => db.prepare('SELECT id FROM characters WHERE rank = 1').get().id;
function readCharacters(db) {
  const statement = db.prepare('SELECT * FROM characters ORDER BY rank');
  statement.setReadBigInts(true);
  return statement.all();
}
const snapshot = db => ({
  schema: db.prepare('SELECT type, name, sql FROM sqlite_schema ORDER BY name').all(),
  meta: db.prepare('SELECT * FROM catalog_meta ORDER BY key').all(),
  characters: readCharacters(db),
  identities: db.prepare('SELECT * FROM character_identities ORDER BY id').all(),
  sources: db.prepare('SELECT * FROM character_sources ORDER BY external_id').all(),
  version: version(db),
});

test('explicit release extensions preserve foundation and survive raw file reopen, not normal startup', () => {
  const directory = mkdtempSync(join(tmpdir(), 'catalog-release-'));
  const path = join(directory, 'synthetic.sqlite');
  let db;
  try {
    db = fixture(path);
    const before = snapshot(db);
    initializeCatalogReleaseSchema(db);
    assert.equal(CATALOG_RELEASE_VERSION, 12);
    assert.equal(version(db), 12);
    const after = snapshot(db);
    for (const key of ['meta', 'characters', 'identities', 'sources']) assert.deepEqual(after[key], before[key]);
    assert.deepEqual({ ...db.prepare('SELECT * FROM catalog_state').get() },
      { singleton: 1, revision: 0, source_revision: 0, appearance_revision: 0 });
    db.close();
    db = new DatabaseSync(path);
    db.exec('PRAGMA foreign_keys = ON');
    assert.equal(version(db), 12);
    assert.equal(db.prepare('SELECT count(*) AS n FROM effective_character_franchises').get().n, 1);
    assert.throws(() => openCatalog(path), /Unsupported catalog database version 12/);
    assert.throws(() => initializeCatalogReleaseSchema(db), /version 11/);
    assert.equal(version(db), 12);
  } finally {
    db?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('durable aliases are independent, direct memberships deduplicate and restrict parent deletion', () => {
  const db = fixture();
  try {
    initializeCatalogReleaseSchema(db);
    const character = id(db);
    db.prepare('INSERT INTO character_curated_aliases VALUES (?, ?, ?)').run(character, 'Curated', 'curated');
    assert.throws(() => db.prepare('INSERT INTO character_curated_aliases VALUES (?, ?, ?)').run(character, 'Other', 'curated'));
    assert.throws(() => db.prepare('INSERT INTO character_curated_aliases VALUES (?, ?, ?)').run(character, ' ', 'empty'));
    db.prepare('INSERT INTO character_curation VALUES (?, ?)').run(character, 'https://example.test/reference');
    db.prepare('INSERT INTO character_franchise_memberships VALUES (?, 1)').run(character);
    assert.equal(db.prepare('SELECT count(*) AS n FROM effective_character_franchises').get().n, 1);
    assert.throws(() => db.prepare('INSERT INTO character_franchise_memberships VALUES (?, 999)').run(character), /FOREIGN KEY/);
    assert.throws(() => db.prepare('INSERT INTO character_franchise_memberships VALUES (?, 1)').run('missing'), /FOREIGN KEY/);
    assert.throws(() => db.exec('DELETE FROM franchises WHERE id = 1'), /FOREIGN KEY/);
    assert.throws(() => db.prepare('DELETE FROM characters WHERE id = ?').run(character), /FOREIGN KEY/);
    db.exec(`UPDATE characters SET name_alternatives = '[]'; DELETE FROM character_anime;`);
    assert.equal(db.prepare('SELECT alias FROM character_curated_aliases').get().alias, 'Curated');
    assert.equal(db.prepare('SELECT count(*) AS n FROM effective_character_franchises').get().n, 1);
    db.exec("UPDATE franchises SET curated_cover_url = 'https://example.test/cover', reference_url = 'https://example.test/series'");
    assert.throws(() => db.exec("UPDATE franchises SET curated_cover_url = 'http://example.test/cover'"));
    assert.throws(() => db.exec("UPDATE franchises SET curated_cover_url = 'https://bad url'"));
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});

function preview(db, overrides = {}) {
  const row = { id: 'preview', account: 'editor', role: 'moderator', operation: 'create',
    payload_hash: 'a'.repeat(64), payload_json: '{}', revision: 0, source_revision: 0,
    appearance_revision: 0, created_at: 100, expires_at: 200, ...overrides };
  db.prepare(`INSERT INTO catalog_previews (${Object.keys(row).join(',')})
    VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row));
}
function audit(db, overrides = {}) {
  const row = { id: 1, preview_id: 'preview', character_id: id(db), account: 'editor', role: 'moderator',
    operation: 'create', revision: 1, before_json: '{}', after_json: '{}',
    duplicate_override_reason: null, created_at: 150, ...overrides };
  db.prepare(`INSERT INTO catalog_mutations (${Object.keys(row).join(',')})
    VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row));
}

test('typed safe revisions, preview payload/hash/roles, audit and idempotency constraints', () => {
  const db = fixture();
  try {
    initializeCatalogReleaseSchema(db);
    for (const column of ['revision', 'source_revision', 'appearance_revision']) {
      for (const value of [-1, 1.5, 9007199254740992]) {
        assert.throws(() => db.prepare(`UPDATE catalog_state SET ${column} = ?`).run(value));
      }
      db.prepare(`UPDATE catalog_state SET ${column} = ?`).run(Number.MAX_SAFE_INTEGER);
    }
    assert.throws(() => db.exec('INSERT INTO catalog_state VALUES (2, 0, 0, 0)'));
    for (const overrides of [{ role: 'user' }, { account: ' ' }, { payload_hash: 'A'.repeat(64) },
      { payload_hash: 'a' }, { payload_json: '[' }, { payload_json: '[]' }, { payload_json: 'null' },
      { revision: -1 }, { source_revision: 1.5 }, { appearance_revision: 9007199254740992 },
      { expires_at: 100 }, { created_at: -1 }]) assert.throws(() => preview(db, overrides));
    preview(db);
    for (const overrides of [{ role: 'anonymous' }, { revision: 0 }, { before_json: '[]' },
      { after_json: 'broken' }, { duplicate_override_reason: ' ' }, { preview_id: 'missing' },
      { character_id: 'missing' }, { created_at: 9007199254740992 }]) assert.throws(() => audit(db, overrides));
    audit(db);
    assert.throws(() => audit(db, { id: 2, revision: 2 })); // preview consumed only once
    const confirm = db.prepare('INSERT INTO catalog_confirmation_results VALUES (?, ?, ?, ?, ?, ?)');
    confirm.run('editor', 'retry-key', 'a'.repeat(64), 1, '{"id":1}', 150);
    assert.throws(() => confirm.run('editor', 'retry-key', 'b'.repeat(64), 1, '{}', 151));
    assert.throws(() => confirm.run('other', 'other-key', 'a'.repeat(64), 1, '{}', 151));
    assert.throws(() => confirm.run('editor', 'new-key', 'a'.repeat(64), 999, '{}', 151), /FOREIGN KEY/);
    assert.throws(() => db.exec("DELETE FROM catalog_previews WHERE id = 'preview'"), /FOREIGN KEY/);
    assert.throws(() => db.exec('DELETE FROM catalog_mutations'), /FOREIGN KEY/);
    assert.equal(db.prepare('SELECT result_json FROM catalog_confirmation_results WHERE account = ? AND idempotency_key = ?')
      .get('editor', 'retry-key').result_json, '{"id":1}');
  } finally { db.close(); }
});

test('invalid foundations fail atomically without repair', () => {
  const corruptions = [
    "UPDATE characters SET likes_source = 'other'", "UPDATE character_identities SET creation_method = 'other'",
    'UPDATE characters SET tie_order = NULL', 'UPDATE characters SET tie_order = 1.5 WHERE rank = 1',
    'UPDATE characters SET favourites = -1', 'UPDATE characters SET favourites = 9007199254740992',
    'UPDATE characters SET rank = rank + 0.5',
    "UPDATE character_sources SET external_id = '01' WHERE external_id = '1'",
    "UPDATE character_sources SET external_id = '9007199254740992' WHERE external_id = '1'",
    "UPDATE character_sources SET source = 'unknown'", 'DELETE FROM character_sources',
  ];
  for (const sql of corruptions) {
    const db = fixture();
    try {
      db.exec(sql);
      const before = snapshot(db);
      assert.throws(() => initializeCatalogReleaseSchema(db), /Invalid/);
      assert.deepEqual(snapshot(db), before, sql);
    } finally { db.close(); }
  }
  // Canonical identity validation is separate from referential validation.
  const db = fixture();
  try {
    db.exec('PRAGMA foreign_keys = OFF');
    db.prepare('UPDATE character_identities SET id = ? WHERE id = ?').run(id(db).toUpperCase(), id(db));
    db.exec('PRAGMA foreign_keys = ON');
    const before = snapshot(db);
    assert.throws(() => initializeCatalogReleaseSchema(db), /canonical character UUID/);
    assert.deepEqual(snapshot(db), before);
  } finally { db.close(); }
});

test('DDL failure rolls back installed tables, columns, version and meta; caller transaction is untouched', () => {
  const db = fixture();
  try {
    // Collision occurs after several tables and franchise columns have been installed.
    db.exec('CREATE TABLE catalog_mutations (collision TEXT)');
    const before = snapshot(db);
    assert.throws(() => initializeCatalogReleaseSchema(db), /already exists/);
    assert.deepEqual(snapshot(db), before);
    db.exec("BEGIN; INSERT INTO catalog_meta VALUES ('caller', 'pending')");
    assert.throws(() => initializeCatalogReleaseSchema(db), /transaction/i);
    assert.equal(db.prepare("SELECT value FROM catalog_meta WHERE key = 'caller'").get().value, 'pending');
    db.exec('ROLLBACK');
    assert.deepEqual(snapshot(db), before);
  } finally { db.close(); }
});

test('legacy, unknown versions and foreign-keys-off are refused without changes; empty bootstrap is supported explicitly', () => {
  const db = openCatalog(':memory:');
  try {
    for (const number of [10, 0, 13]) {
      db.exec(`PRAGMA user_version = ${number}`);
      const before = snapshotLegacy(db);
      assert.throws(() => initializeCatalogReleaseSchema(db), /version 11/);
      assert.deepEqual(snapshotLegacy(db), before);
    }
    db.exec('PRAGMA user_version = 10');
    migrateCharacterIdentities(db, { dryRun: false, targetVersion: 11 });
    db.exec('PRAGMA foreign_keys = OFF');
    assert.throws(() => initializeCatalogReleaseSchema(db), /foreign_keys ON/);
    assert.equal(version(db), 11);
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 0);
    db.exec('PRAGMA foreign_keys = ON');
    initializeCatalogReleaseSchema(db);
    assert.equal(db.prepare('SELECT count(*) AS n FROM effective_character_franchises').get().n, 0);
  } finally { db.close(); }
});
function snapshotLegacy(db) {
  return { version: version(db), schema: db.prepare('SELECT name, sql FROM sqlite_schema ORDER BY name').all() };
}
