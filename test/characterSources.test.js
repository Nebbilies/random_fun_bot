import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createCharacterId } from "../lib/characterIdentity.js";
import {
  initCharacterSources,
  resolveAniListCharacter,
  linkAniListCharacter,
} from "../lib/characterSources.js";

test("source mappings are unique, idempotent and never merge identities", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(
    "PRAGMA foreign_keys = ON; CREATE TABLE character_identities (id TEXT PRIMARY KEY)",
  );
  initCharacterSources(db);
  const first = createCharacterId();
  const second = createCharacterId();
  const add = db.prepare("INSERT INTO character_identities VALUES (?)");
  add.run(first);
  add.run(second);
  assert.equal(resolveAniListCharacter(db, 123), null);
  assert.equal(linkAniListCharacter(db, first, 123), true);
  assert.equal(linkAniListCharacter(db, first, "123"), false);
  assert.equal(resolveAniListCharacter(db, "123"), first);
  assert.throws(
    () => linkAniListCharacter(db, second, 123),
    /another character/,
  );
  assert.throws(() => linkAniListCharacter(db, first, 124), /replacement/);
  assert.throws(
    () => linkAniListCharacter(db, createCharacterId(), 125),
    /Unknown/,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM character_identities").get().n,
    2,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM character_sources").get().n,
    1,
  );
});
