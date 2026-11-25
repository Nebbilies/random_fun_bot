import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openCatalog,
  publishCatalog,
  saveDecision,
  setMeta,
} from "../lib/catalogDb.js";
import { runImport, scanOnePage } from "../scripts/importCharacterCatalog.js";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "growing-catalog-"));
  const db = openCatalog(join(directory, "catalog.sqlite"));
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return db;
}

test("publication keeps old characters, adds lower-ranked discoveries, and reranks seen favourites", (t) => {
  const db = fixture(t);
  db.prepare(
    `INSERT INTO characters (id, rank, favourites, name_full, image_url) VALUES
    (1, 1, 100, 'One', 'https://example.test/one.jpg'),
    (2, 2, 90, 'Two', 'https://example.test/two.jpg')`,
  ).run();
  db.prepare(
    `INSERT INTO character_identities (id, name_full, image_url) VALUES
    (1, 'One', 'https://example.test/one.jpg'),
    (2, 'Two', 'https://example.test/two.jpg')`,
  ).run();
  saveDecision(db, 2, "approve", "two_tag");
  db.prepare(
    `INSERT INTO stage_characters (id, favourites, name_full) VALUES
    (1, 80, 'One'), (3, 10, 'Three')`,
  ).run();

  assert.equal(publishCatalog(db), 3);
  assert.deepEqual(
    db
      .prepare("SELECT id, rank, favourites FROM characters ORDER BY rank")
      .all()
      .map((row) => ({ ...row })),
    [
      { id: 2, rank: 1, favourites: 90 },
      { id: 1, rank: 2, favourites: 80 },
      { id: 3, rank: 3, favourites: 10 },
    ],
  );
  assert.equal(
    db
      .prepare("SELECT tag_name FROM tag_decisions WHERE character_id = 2")
      .get().tag_name,
    "two_tag",
  );
  assert.equal(
    db.prepare("SELECT image_url FROM character_identities WHERE id = 2").get()
      .image_url,
    "https://example.test/two.jpg",
  );
});

test("failed growing publication leaves catalog and ranks unchanged", (t) => {
  const db = fixture(t);
  db.prepare(
    "INSERT INTO characters (id, rank, favourites, name_full) VALUES (1, 1, 100, 'One')",
  ).run();
  db.prepare(
    "INSERT INTO stage_characters (id, favourites, name_full) VALUES (2, 200, 'Two')",
  ).run();
  db.exec(`CREATE TEMP TRIGGER reject_new_character BEFORE INSERT ON characters
    WHEN NEW.id = 2 BEGIN SELECT RAISE(ABORT, 'blocked insert'); END`);

  assert.throws(() => publishCatalog(db), /blocked insert/);
  assert.deepEqual(
    db
      .prepare("SELECT id, rank FROM characters")
      .all()
      .map((row) => ({ ...row })),
    [{ id: 1, rank: 1 }],
  );
  assert.equal(
    db.prepare("SELECT id FROM character_identities WHERE id = 2").get(),
    undefined,
  );
  db.exec("DROP TRIGGER reject_new_character");
  assert.equal(publishCatalog(db), 2);
});

test("a growing scan retains a discovery beyond the old 15,000-character cap", async (t) => {
  const db = fixture(t);
  db.exec(`WITH RECURSIVE ids(id) AS (SELECT 1 UNION ALL SELECT id + 1 FROM ids WHERE id < 15000)
    INSERT INTO stage_characters (id, favourites) SELECT id, 20000 - id FROM ids`);
  setMeta(db, "scan_mode", "growing");
  setMeta(db, "scan_range_start", 1);
  setMeta(db, "scan_page", 1);
  setMeta(db, "scan_max_id", 1);
  await scanOnePage(db, {
    animePage: async () => ({
      pageInfo: { hasNextPage: false },
      media: [
        {
          id: 1,
          characters: {
            pageInfo: { hasNextPage: false },
            nodes: [{ id: 15001, favourites: 1 }],
          },
        },
      ],
    }),
  });
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM stage_characters").get().n,
    15001,
  );
});

test("a fresh import adds new characters while reusing existing metadata", async (t) => {
  const db = fixture(t);
  db.prepare(
    "INSERT INTO characters (id, rank, favourites, name_full) VALUES (1, 1, 100, 'Existing')",
  ).run();
  const requested = [];
  const api = {
    highestAnimeId: async () => 1,
    animePage: async () => ({
      pageInfo: { hasNextPage: false },
      media: [
        {
          id: 1,
          characters: {
            pageInfo: { hasNextPage: false },
            nodes: [
              { id: 1, favourites: 80 },
              { id: 2, favourites: 90 },
            ],
          },
        },
      ],
    }),
    characterDetails: async (ids) => {
      requested.push(...ids);
      return [
        {
          id: 2,
          name: { full: "New", alternative: [] },
          dateOfBirth: {},
          media: {
            pageInfo: { hasNextPage: false },
            nodes: [
              {
                id: 20,
                title: { romaji: "Eligible" },
                format: "TV",
                status: "FINISHED",
                averageScore: 70,
                popularity: 20_000,
              },
            ],
          },
        },
      ];
    },
  };
  await runImport({ db, api, log: () => {} });
  assert.deepEqual(requested, [2]);
  assert.deepEqual(
    db
      .prepare(
        "SELECT id, rank, favourites, name_full FROM characters ORDER BY rank",
      )
      .all()
      .map((row) => ({ ...row })),
    [
      { id: 2, rank: 1, favourites: 90, name_full: "New" },
      { id: 1, rank: 2, favourites: 80, name_full: "Existing" },
    ],
  );
});
