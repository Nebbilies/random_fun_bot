import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCatalog, publishCatalog } from "../lib/catalogDb.js";

function fixture(t) {
  const path = mkdtempSync(join(tmpdir(), "publication-retention-"));
  const db = openCatalog(join(path, "catalog.sqlite"));
  t.after(() => {
    db.close();
    rmSync(path, { recursive: true, force: true });
  });
  db.exec(`INSERT INTO characters (id,rank,favourites,name_full) VALUES (1,1,200,'First'),(2,2,100,'Second');
    INSERT INTO duckduckgo_tag_attempts VALUES (1,'query',NULL,NULL,'no_match',NULL,'{}','2026-01-01');
    INSERT INTO marriages (guild_id,character_id,owner_id,married_at) VALUES ('g',1,'u','2026-01-01');`);
  return db;
}

test("publication updates rows without cascading away completed tag attempts", (t) => {
  const db = fixture(t);
  db.exec(
    `INSERT INTO stage_characters (id,favourites,name_full) VALUES (1,50,'Updated'),(3,300,'New')`,
  );
  assert.equal(publishCatalog(db), 3);
  assert.deepEqual(
    db
      .prepare("SELECT id,rank FROM characters ORDER BY rank")
      .all()
      .map((r) => [r.id, r.rank]),
    [
      [3, 1],
      [2, 2],
      [1, 3],
    ],
  );
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM duckduckgo_tag_attempts").get().n,
    1,
  );
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM marriages WHERE character_id=1").get()
      .n,
    1,
  );
  assert.equal(
    db.prepare("SELECT name_full FROM characters WHERE id=1").get().name_full,
    "Updated",
  );
  assert.equal(publishCatalog(db), 3);
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM duckduckgo_tag_attempts").get().n,
    1,
  );
});

test("failure after publication starts restores ranks, rows and cascade references", (t) => {
  const db = fixture(t);
  db.exec(`INSERT INTO stage_characters (id,favourites,name_full) VALUES (1,400,'Updated');
    CREATE TRIGGER fail_update BEFORE UPDATE ON characters WHEN NEW.name_full='Updated'
    BEGIN SELECT RAISE(ABORT,'injected publication failure'); END;`);
  assert.throws(() => publishCatalog(db), /injected/);
  assert.deepEqual(
    db
      .prepare("SELECT id,rank FROM characters ORDER BY rank")
      .all()
      .map((r) => [r.id, r.rank]),
    [
      [1, 1],
      [2, 2],
    ],
  );
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM duckduckgo_tag_attempts").get().n,
    1,
  );
});
