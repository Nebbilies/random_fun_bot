import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  installEmptyFinalCatalog,
  validateFinalCatalogSchema,
} from "../lib/catalogFinalSchema.js";
const id = "00000000-0000-4000-8000-000000000001";
test("new final catalogs install a fixed policy and nullable immutable archived ranks", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys=ON");
    installEmptyFinalCatalog(db);
    assert.equal(
      db.prepare("SELECT version FROM character_ranking_policy").get().version,
      1,
    );
    db.prepare(
      "INSERT INTO character_identities(id,creation_method) VALUES(?,'manual')",
    ).run(id);
    db.prepare(
      "INSERT INTO characters(id,rank,favourites,tie_order,likes_source) VALUES(?,1,0,1,'generated')",
    ).run(id);
    assert.equal(
      db.prepare("SELECT legacy_rank FROM characters").get().legacy_rank,
      null,
    );
    assert.throws(
      () => db.exec("UPDATE characters SET legacy_rank=1"),
      /immutable/,
    );
    assert.equal(validateFinalCatalogSchema(db, { readOnly: false }), true);
    db.exec("UPDATE characters SET efficiency=1");
    assert.throws(
      () => validateFinalCatalogSchema(db, { readOnly: false }),
      /score|efficiency/,
    );
  } finally {
    db.close();
  }
});
