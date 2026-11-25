import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCatalog, publishCatalog } from "../lib/catalogDb.js";
import { migrateCharacterIdentities } from "../lib/characterIdentityMigration.js";
import { createCharacterId } from "../lib/characterIdentity.js";
import { initializeCatalogReleaseSchema } from "../lib/catalogReleaseSchema.js";
import { bindSourceCatalogStaging } from "../lib/sourceCatalogPublication.js";
import { hydrateOneBatch } from "../scripts/importCharacterCatalog.js";
import { runFranchiseImport } from "../scripts/importFranchiseCatalog.js";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "source-publication-"));
  const db = openCatalog(join(dir, "fixture.sqlite"));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  db.exec(`INSERT INTO characters(id,rank,favourites,name_full) VALUES(20,1,100,'Existing first'),(10,2,100,'Existing second');
    INSERT INTO character_identities SELECT id,name_full,image_url FROM characters;
    INSERT INTO duckduckgo_tag_attempts VALUES (20,'query',NULL,NULL,'no_match',NULL,'{}','2026-01-01');`);
  migrateCharacterIdentities(db, { dryRun: false, targetVersion: 11 });
  return db;
}

test("UUID publication reuses source identities, preserves ties and cascaded history", (t) => {
  const db = fixture(t);
  const original = db
    .prepare("SELECT id FROM characters ORDER BY rank")
    .all()
    .map((r) => r.id);
  db.exec(
    `INSERT INTO stage_characters(id,favourites,name_full) VALUES(20,100,'Refreshed'),(10,100,'Second'),(30,100,'New thirty'),(25,100,'New twenty-five')`,
  );
  assert.equal(publishCatalog(db), 4);
  const order = () =>
    db
      .prepare(
        `SELECT s.external_id FROM characters c JOIN character_sources s ON s.character_id=c.id ORDER BY c.rank`,
      )
      .all()
      .map((r) => r.external_id);
  assert.deepEqual(order(), ["20", "10", "25", "30"]);
  assert.deepEqual(
    db
      .prepare("SELECT id FROM characters ORDER BY rank LIMIT 2")
      .all()
      .map((r) => r.id),
    original,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM duckduckgo_tag_attempts").get().n,
    1,
  );
  assert.equal(publishCatalog(db), 4);
  assert.deepEqual(order(), ["20", "10", "25", "30"]);
  assert.equal(
    db
      .prepare("SELECT value FROM catalog_meta WHERE key='catalog_revision'")
      .get().value,
    "2",
  );
});

test("release publication advances typed revision atomically with legacy revision metadata", (t) => {
  const db = fixture(t);
  initializeCatalogReleaseSchema(db);
  db.exec("BEGIN IMMEDIATE");
  try {
    bindSourceCatalogStaging(db);
    db.exec(
      "INSERT INTO stage_characters(id,favourites,name_full) VALUES(20,101,'Refresh')",
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  publishCatalog(db);
  assert.equal(
    db.prepare("SELECT revision FROM catalog_state").get().revision,
    1,
  );
  assert.equal(
    db
      .prepare("SELECT value FROM catalog_meta WHERE key='catalog_revision'")
      .get().value,
    "1",
  );
  db.exec("INSERT INTO stage_characters(id,favourites) VALUES(999,200)");
  assert.throws(() => publishCatalog(db), /incomplete/);
  assert.equal(
    db.prepare("SELECT revision FROM catalog_state").get().revision,
    1,
  );
});

test("source refresh preserves manual metadata and generated counts independently", (t) => {
  const db = fixture(t);
  const id = createCharacterId();
  db.prepare(
    "INSERT INTO character_identities(id,name_full,creation_method) VALUES(?,'Curated','manual')",
  ).run(id);
  db.prepare("INSERT INTO character_sources VALUES('anilist','50',?)").run(id);
  db.prepare(
    "INSERT INTO characters(id,rank,favourites,name_full,likes_source,tie_order) VALUES(?,3,99,'Curated','generated',3)",
  ).run(id);
  db.exec(
    `INSERT INTO stage_characters(id,favourites,name_full) VALUES(50,9999,'Source override')`,
  );
  publishCatalog(db);
  const row = db.prepare("SELECT * FROM characters WHERE id=?").get(id);
  assert.equal(row.name_full, "Curated");
  assert.equal(row.favourites, 99);
  assert.equal(row.rank, 3);
  db.prepare("UPDATE characters SET likes_source='anilist' WHERE id=?").run(id);
  publishCatalog(db);
  const updated = db.prepare("SELECT * FROM characters WHERE id=?").get(id);
  assert.equal(updated.name_full, "Curated");
  assert.equal(updated.favourites, 9999);
  assert.equal(updated.rank, 1);
});

test("hydration resolves existing AniList keys instead of querying UUIDs against AniList", async (t) => {
  const db = fixture(t);
  db.exec("INSERT INTO stage_characters(id,favourites) VALUES(20,99),(10,98)");
  assert.equal(
    await hydrateOneBatch(db, {
      characterDetails() {
        throw new Error("Existing identities should not be fetched");
      },
    }),
    false,
  );
  publishCatalog(db);
  assert.equal(
    db.prepare("SELECT favourites FROM characters WHERE rank=1").get()
      .favourites,
    99,
  );
});

test("franchise importer queries source IDs and skips unlinked manual characters", async (t) => {
  const db = fixture(t);
  const id = createCharacterId();
  db.prepare(
    "INSERT INTO character_identities(id,name_full,creation_method) VALUES(?,'Manual','manual')",
  ).run(id);
  db.prepare(
    "INSERT INTO characters(id,rank,favourites,name_full,likes_source,tie_order) VALUES(?,3,99,'Manual','generated',3)",
  ).run(id);
  db.exec(
    "INSERT INTO catalog_meta VALUES('import_phase','complete'),('published_at','fixture-publication')",
  );
  const calls = [];
  const api = {
    async characterAnimePage(externalId) {
      calls.push(externalId);
      return { pageInfo: { hasNextPage: false }, nodes: [{ id: 500 }] };
    },
    async animeDetails(ids) {
      return ids.map((id) => ({
        id,
        title: { romaji: "Fixture anime" },
        relations: { edges: [] },
      }));
    },
  };
  await runFranchiseImport({ db, api, log() {} });
  assert.deepEqual(calls, [10, 20]);
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM character_anime").get().n,
    2,
  );
  assert.equal(
    db
      .prepare("SELECT count(*) AS n FROM character_anime WHERE character_id=?")
      .get(id).n,
    0,
  );
  assert.ok(
    db
      .prepare("SELECT character_id FROM character_anime")
      .all()
      .every((r) => typeof r.character_id === "string"),
  );
});

test("invalid staging rolls back partial source links, metadata and ranks", (t) => {
  const db = fixture(t);
  db.exec(
    `INSERT INTO stage_characters(id,favourites,name_full) VALUES(30,200,'Valid'),(40,300,NULL)`,
  );
  assert.throws(() => publishCatalog(db), /incomplete/);
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM character_sources").get().n,
    2,
  );
  assert.equal(db.prepare("SELECT count(*) AS n FROM characters").get().n, 2);
  assert.equal(
    db.prepare("SELECT name_full FROM characters WHERE rank=1").get().name_full,
    "Existing first",
  );
});
