import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as catalog from '../lib/catalogDb.js';
import { findCharacters, loadCharacterIndex } from '../lib/gameCharacterLookup.js';

function stage(db, id, name, portraitUrl, favourites = 500) {
  catalog.keepCandidate(db, { id, favourites });
  db.prepare(`UPDATE stage_characters SET name_full = ?, image_url = ? WHERE id = ?`)
    .run(name, portraitUrl, id);
}

test('opening a version-1 catalog preserves its character identity', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'character-identity-'));
  const path = join(directory, 'catalog.sqlite');
  let reopened;
  t.after(() => {
    reopened?.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const oldCatalog = catalog.openCatalog(path);
  oldCatalog.prepare(`INSERT INTO characters
    (id, rank, favourites, name_full, image_url)
    VALUES (42, 1, 500, 'Example Character', 'https://anilist.co/img/example.jpg')`).run();
  catalog.saveDecision(oldCatalog, 42, 'approve', 'legacy_tag', 'automatic');
  oldCatalog.exec('DROP TABLE character_identities; PRAGMA user_version = 1');
  oldCatalog.close();

  reopened = catalog.openCatalog(path);
  assert.deepEqual(catalog.getCharacterIdentity(reopened, 42), {
    id: 42,
    name: 'Example Character',
    portraitUrl: 'https://anilist.co/img/example.jpg',
    inCatalog: true,
    tagName: 'legacy_tag',
  });
});

test('catalog refresh retains a departed character and its approved tag', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'character-identity-'));
  const db = catalog.openCatalog(join(directory, 'catalog.sqlite'));
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });

  stage(db, 42, 'Example Character', 'https://anilist.co/img/example.jpg');
  catalog.publishCatalog(db);
  catalog.saveDecision(db, 42, 'approve', 'example_tag', 'automatic');
  db.exec('DELETE FROM stage_characters');
  catalog.publishCatalog(db);

  assert.deepEqual(catalog.getCharacterIdentity(db, 42), {
    id: 42,
    name: 'Example Character',
    portraitUrl: 'https://anilist.co/img/example.jpg',
    inCatalog: false,
    tagName: 'example_tag',
  });

  stage(db, 42, 'Updated Character', 'https://anilist.co/img/updated.jpg', 600);
  catalog.publishCatalog(db);
  assert.deepEqual(catalog.getCharacterIdentity(db, 42), {
    id: 42,
    name: 'Updated Character',
    portraitUrl: 'https://anilist.co/img/updated.jpg',
    inCatalog: true,
    tagName: 'example_tag',
  });
});

test('ordinary character lookup searches only the current catalog', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'character-identity-'));
  const db = catalog.openCatalog(join(directory, 'catalog.sqlite'));
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });

  stage(db, 42, 'Example Character', 'https://anilist.co/img/example.jpg');
  catalog.publishCatalog(db);
  db.exec('DELETE FROM stage_characters');
  catalog.publishCatalog(db);

  assert.equal(catalog.getCharacterIdentity(db, 42)?.inCatalog, false);
  assert.deepEqual(findCharacters(loadCharacterIndex(db), 'Example Character'), []);
});

test('failed publication keeps prior identities and current catalog', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'character-identity-'));
  const db = catalog.openCatalog(join(directory, 'catalog.sqlite'));
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });

  stage(db, 42, 'Example Character', 'https://anilist.co/img/example.jpg');
  catalog.publishCatalog(db);
  db.exec('DELETE FROM stage_characters');
  stage(db, 42, 'Unpublished Name', 'https://anilist.co/img/unpublished.jpg');
  stage(db, 43, 'New Character', null, 600);
  db.exec(`CREATE TEMP TRIGGER reject_catalog_insert BEFORE INSERT ON characters
    BEGIN SELECT RAISE(ABORT, 'test publication failure'); END`);

  assert.throws(() => catalog.publishCatalog(db), /test publication failure/);
  assert.equal(catalog.getCharacterIdentity(db, 42)?.name, 'Example Character');
  assert.equal(catalog.getCharacterIdentity(db, 43), null);
  assert.deepEqual(findCharacters(loadCharacterIndex(db), 'Example Character').map((row) => row.id), [42]);
});
