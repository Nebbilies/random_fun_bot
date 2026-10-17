import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCatalog } from '../lib/catalogDb.js';
import { divorceCharacter, getMarriage, listMarriages, marryCharacter } from '../lib/characterMarriage.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'character-marriage-'));
  const db = openCatalog(join(directory, 'catalog.sqlite'));
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  db.prepare(`INSERT INTO characters (id, rank, favourites, name_full) VALUES
    (11, 1, 100, 'Eleven'), (12, 2, 90, 'Twelve')`).run();
  return db;
}

for (const version of [1, 2]) {
  test(`opening a version-${version} database adds marriage storage without losing characters`, (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'marriage-migration-'));
    const path = join(directory, 'catalog.sqlite');
    let db = openCatalog(path);
    t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
    db.prepare("INSERT INTO characters (id, rank, favourites, name_full) VALUES (11, 1, 100, 'Eleven')").run();
    db.exec(`DROP TABLE marriages; PRAGMA user_version = ${version}`);
    if (version === 1) db.exec('DROP TABLE character_identities');
    db.close();

    db = openCatalog(path);
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 6);
    assert.equal(db.prepare('SELECT name_full FROM characters WHERE id = 11').get()?.name_full, 'Eleven');
    assert.equal(marryCharacter(db, '1', 11, '101').status, 'married');
  });
}

test('marriage is exclusive per character and server, with no per-user limit', (t) => {
  const db = fixture(t);
  assert.equal(marryCharacter(db, '1', 11, '101').status, 'married');
  assert.equal(marryCharacter(db, '1', 11, '101').status, 'already_yours');
  assert.equal(marryCharacter(db, '1', 11, '102').status, 'already_owned');
  assert.equal(marryCharacter(db, '1', 12, '101').status, 'married');
  assert.equal(marryCharacter(db, '2', 11, '102').status, 'married');
  assert.equal(marryCharacter(db, '1', 99, '101').status, 'unknown');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM marriages').get()?.n, 3);
});

test('divorce targets one active marriage and cannot remove a later remarriage', (t) => {
  const db = fixture(t);
  const first = marryCharacter(db, '1', 11, '101').marriage;
  assert.ok(first);
  assert.equal(divorceCharacter(db, '1', 11, '102', first.id), false);
  assert.equal(divorceCharacter(db, '1', 11, '101', first.id), true);
  const second = marryCharacter(db, '1', 11, '102').marriage;
  assert.ok(second);
  assert.notEqual(second.id, first.id);
  assert.equal(divorceCharacter(db, '1', 11, '101', first.id), false);
  assert.equal(getMarriage(db, '1', 11)?.ownerId, '102');
});

test('lists current marriages by time or current rank', (t) => {
  const db = fixture(t);
  marryCharacter(db, '1', 11, '101');
  marryCharacter(db, '1', 12, '101');
  db.prepare("UPDATE marriages SET married_at = '2026-01-01T00:00:00.000Z' WHERE character_id = 11").run();
  db.prepare("UPDATE marriages SET married_at = '2026-01-02T00:00:00.000Z' WHERE character_id = 12").run();
  assert.deepEqual(listMarriages(db, '1', '101', 'time').map((row) => row.characterId), [12, 11]);
  assert.deepEqual(listMarriages(db, '1', '101', 'rank').map((row) => row.characterId), [11, 12]);
  assert.deepEqual(listMarriages(db, '2', '101', 'time'), []);
});
