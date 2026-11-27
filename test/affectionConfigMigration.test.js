import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { installEmptyFinalCatalog } from "../lib/catalogFinalSchema.js";
import {
  createFinalCatalog,
  openFinalCatalog,
  openFinalCatalogReadOnly,
  transaction,
} from "../lib/catalogDb.js";
import { installConfiguredAffectionAwards } from "../lib/affectionSchema.js";
import { installSeasonSchema } from "../lib/seasonSchema.js";
import { installWeeklyEventSchema } from "../lib/weeklyEventSchema.js";

const id = "11111111-1111-4111-8111-111111111111";
function catalogPath(t) {
  const directory = mkdtempSync(join(tmpdir(), "affection-gains-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "catalog.sqlite");
}

function insertAward(db, key, base, amount) {
  db.prepare(
    "INSERT INTO affection_awards VALUES(?, '1', '10', ?, ?, ?, ?, '[]', 1)",
  ).run(key, id, base, amount, amount);
}

test("a writable catalog upgrade preserves old affection receipts and their season bindings", (t) => {
  const path = catalogPath(t);
  const previous = new DatabaseSync(path);
  installEmptyFinalCatalog(previous);
  installSeasonSchema(previous);
  installWeeklyEventSchema(previous);
  previous.prepare("INSERT INTO character_identities(id) VALUES(?)").run(id);
  previous.prepare("INSERT INTO guild_seasons VALUES ('1',2,1)").run();
  insertAward(previous, "old-reclaim", 8, 16);
  const receipts = previous.prepare("SELECT * FROM season_receipts").all();
  const awards = previous
    .prepare("SELECT * FROM season_current_affection_awards")
    .all();
  previous.close();
  openFinalCatalogReadOnly(path).close();
  const upgraded = openFinalCatalog(path);
  try {
    assert.deepEqual(
      upgraded.prepare("SELECT * FROM season_receipts").all(),
      receipts,
    );
    assert.deepEqual(
      upgraded.prepare("SELECT * FROM season_current_affection_awards").all(),
      awards,
    );
    insertAward(upgraded, "custom", 175, 455);
    assert.equal(
      upgraded
        .prepare(
          "SELECT season FROM season_receipts WHERE record_key LIKE '%custom%'",
        )
        .get().season,
      2,
    );
  } finally {
    upgraded.close();
  }
  const reopened = openFinalCatalogReadOnly(path);
  try {
    assert.equal(
      reopened
        .prepare(
          "SELECT amount FROM season_current_affection_awards WHERE source_key='custom'",
        )
        .get().amount,
      455,
    );
  } finally {
    reopened.close();
  }
});

test("fresh catalogs accept configured awards and enforce the affection cap", (t) => {
  const db = createFinalCatalog(catalogPath(t));
  try {
    db.prepare("INSERT INTO character_identities(id) VALUES(?)").run(id);
    insertAward(db, "custom", 2100, 2100);
    assert.throws(() => insertAward(db, "too-high", 2101, 2100), /constraint/i);
    assert.throws(() => insertAward(db, "too-much", 50, 2101), /constraint/i);
  } finally {
    db.close();
  }
});

test("failure after replacing the table rolls back the award schema and season bindings", (t) => {
  const db = new DatabaseSync(catalogPath(t));
  try {
    installEmptyFinalCatalog(db);
    installSeasonSchema(db);
    installWeeklyEventSchema(db);
    db.prepare("INSERT INTO character_identities(id) VALUES(?)").run(id);
    insertAward(db, "historical", 8, 16);
    const schema = db
      .prepare("SELECT * FROM sqlite_schema ORDER BY name")
      .all();
    const receipts = db.prepare("SELECT * FROM season_receipts").all();
    assert.throws(
      () =>
        transaction(db, () => {
          installConfiguredAffectionAwards(db);
          throw new Error("injected migration failure");
        }),
      /injected migration failure/,
    );
    assert.deepEqual(
      db.prepare("SELECT * FROM sqlite_schema ORDER BY name").all(),
      schema,
    );
    assert.deepEqual(
      db.prepare("SELECT * FROM season_receipts").all(),
      receipts,
    );
    assert.equal(
      db.prepare("SELECT amount FROM season_current_affection_awards").get()
        .amount,
      16,
    );
  } finally {
    db.close();
  }
});
