import assert from "node:assert/strict";
import test from "node:test";
import { openCatalog, setMeta } from "../lib/catalogDb.js";
import { migrateCharacterIdentities } from "../lib/characterIdentityMigration.js";
import { characterFranchiseRelation } from "../lib/characterFranchises.js";
import {
  loadFranchiseCharacters,
  loadFranchiseCover,
  isFranchiseCatalogCurrent,
} from "../lib/franchiseLookup.js";
import {
  listMarriagesByFranchise,
  marryCharacter,
  getMarriage,
} from "../lib/characterMarriage.js";
import { reserveRoll } from "../lib/characterRolls.js";
import { addActiveBuff, getActiveBuffs } from "../lib/itemStorage.js";
import { bloodPact } from "../lib/items/bloodPact.js";
import { wishUponAStar } from "../lib/items/wishUponAStar.js";

import { initializeCatalogReleaseSchema } from "../lib/catalogReleaseSchema.js";

function fixture(t, mode) {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  db.exec(`INSERT INTO characters (id, rank, favourites, name_full, gender) VALUES
    (1, 1, 500, 'Prize', 'female'), (2, 2, 400, 'Alpha', 'female'),
    (3, 3, 300, 'Beta', 'female'), (4, 4, 200, 'Gamma', 'female'),
    (5, 5, 100, 'Outsider', 'female');
    INSERT INTO franchises (id, display_name, created_at) VALUES (10, 'Shared', 'now'), (20, 'Direct', 'now');
    INSERT INTO anime (id, title_english, format, popularity, cover_image, fetched_at)
      VALUES (100, 'Real Anime', 'TV', 100, 'https://example.com/anime.jpg', 'now');
    INSERT INTO franchise_anime (franchise_id, anime_id) VALUES (10, 100);
    INSERT INTO character_anime (character_id, anime_id) VALUES (2, 100);`);
  if (mode !== "legacy") {
    db.exec(
      "INSERT INTO character_identities SELECT id, name_full, image_url FROM characters",
    );
    migrateCharacterIdentities(db, { dryRun: false, targetVersion: 11 });
  }
  const ids = Object.fromEntries(
    db
      .prepare("SELECT id, name_full FROM characters")
      .all()
      .map((r) => [r.name_full, r.id]),
  );
  if (mode === "release") {
    initializeCatalogReleaseSchema(db);
    const insert = db.prepare(
      "INSERT INTO character_franchise_memberships (character_id, franchise_id) VALUES (?, ?)",
    );
    for (const name of ["Prize", "Alpha", "Beta", "Gamma"])
      insert.run(ids[name], 10);
    insert.run(ids.Prize, 20);
  } else {
    for (const name of ["Prize", "Beta", "Gamma"]) {
      db.prepare(
        "INSERT INTO character_anime (character_id, anime_id) VALUES (?, 100)",
      ).run(ids[name]);
    }
  }
  return { db, ids };
}

for (const mode of ["legacy", "migrated", "release"]) {
  test(`${mode}: franchise lists deduplicate and marriages retain likes projection and Other`, (t) => {
    const { db, ids } = fixture(t, mode);
    assert.equal(
      characterFranchiseRelation(db).includes("effective_character_franchises"),
      mode === "release",
    );
    marryCharacter(db, "1", ids.Alpha, "2");
    marryCharacter(db, "1", ids.Prize, "2");
    marryCharacter(db, "1", ids.Outsider, "2");
    const rows = loadFranchiseCharacters(db, 10, "1");
    assert.deepEqual(
      rows.map((r) => r.name_full),
      ["Prize", "Alpha", "Beta", "Gamma"],
    );
    assert.deepEqual(
      rows.map((r) => r.married),
      [1, 1, 0, 0],
    );
    const groups = listMarriagesByFranchise(db, "1", "2", "rank");
    const shared = groups.find((g) => g.id === 10);
    assert.deepEqual(
      shared.characters.map((c) => c.characterId),
      [ids.Prize, ids.Alpha],
    );
    assert.ok(shared.characters.every((c) => c.likes_source === "anilist"));
    assert.deepEqual(
      groups.at(-1).characters.map((c) => c.characterId),
      [ids.Outsider],
    );
    if (mode === "release")
      assert.deepEqual(
        groups.find((g) => g.id === 20).characters.map((c) => c.characterId),
        [ids.Prize],
      );
  });

  test(`${mode}: Blood Pact shares memberships and targets an available franchise character`, (t) => {
    const { db, ids } = fixture(t, mode);
    for (const name of ["Alpha", "Beta", "Gamma"])
      marryCharacter(db, "1", ids[name], "2");
    const result = bloodPact.execute({
      db,
      guildId: "1",
      userId: "2",
      args: ["Alpha", "Beta", "Gamma"],
    });
    assert.equal(result.success, true);
    assert.equal(result.character.id, ids.Prize);
    assert.equal(getMarriage(db, "1", ids.Alpha), null);
    assert.equal(getMarriage(db, "1", ids.Prize).ownerId, "2");
  });

  test(`${mode}: Wish Upon A Star includes direct targets without duplicate weighting`, (t) => {
    const { db, ids } = fixture(t, mode);
    const result = wishUponAStar.execute({
      db,
      guildId: "1",
      userId: "2",
      args: ["Shared"],
      random: () => 0,
    });
    assert.equal(result.success, true);
    assert.equal(result.character.id, ids.Prize);
    const last = wishUponAStar.execute({
      db,
      guildId: "9",
      userId: "2",
      args: ["Shared"],
      random: () => 0.99,
    });
    assert.equal(last.character.id, ids.Beta);
  });

  test(`${mode}: passport filters membership and consumes its charge`, (t) => {
    const { db, ids } = fixture(t, mode);
    addActiveBuff(
      db,
      "1",
      "2",
      "franchise_passport",
      JSON.stringify({ franchiseId: mode === "release" ? 20 : 10 }),
      null,
      5,
    );
    const result = reserveRoll(db, {
      guildId: "1",
      channelId: "3",
      commandMessageId: "4",
      userId: "2",
      pool: "w",
      random: () => 0,
    });
    assert.equal(result.status, "reserved");
    if (mode === "release") assert.equal(result.character.id, ids.Prize);
    else
      assert.ok(
        ["Prize", "Alpha", "Beta", "Gamma"].includes(
          result.character.name_full,
        ),
      );
    assert.equal(result.character.likes_source, "anilist");
    assert.equal(getActiveBuffs(db, "1", "2")[0].remaining_rolls, 4);
  });
}

test("release covers skip unsafe URLs; relevant source coverage ignores metadata timestamps", (t) => {
  const { db } = fixture(t, "release");
  db.exec(
    `UPDATE franchises SET curated_cover_url = 'https://example.com/curated.jpg' WHERE id = 10`,
  );
  assert.equal(loadFranchiseCover(db, 10), "https://example.com/anime.jpg");
  db.exec(`INSERT INTO anime (id, format, popularity, cover_image, fetched_at)
    VALUES (101, 'TV', 50, 'https://example.com/second.jpg', 'now');
    INSERT INTO franchise_anime (franchise_id, anime_id) VALUES (10, 101);
    UPDATE anime SET cover_image = 'https://user:secret@example.com/unsafe.jpg' WHERE id = 100;`);
  assert.equal(loadFranchiseCover(db, 10), "https://example.com/second.jpg");
  db.exec(`UPDATE anime SET cover_image = 'http://example.com/unsafe.jpg'`);
  assert.equal(loadFranchiseCover(db, 10), "https://example.com/curated.jpg");
  db.exec(
    `UPDATE franchises SET curated_cover_url = 'https://user:secret@example.com/unsafe.jpg' WHERE id = 10`,
  );
  assert.equal(loadFranchiseCover(db, 10), null);
  assert.equal(loadFranchiseCover(db, 20), null);
  setMeta(db, "published_at", "new");
  setMeta(db, "franchise_source_published_at", "old");
  assert.equal(isFranchiseCatalogCurrent(db), false);
  setMeta(db, "franchise_source_token", "source:0");
  assert.equal(isFranchiseCatalogCurrent(db), true);
  db.exec("UPDATE catalog_state SET source_revision=1");
  assert.equal(isFranchiseCatalogCurrent(db), false);
  db.exec("DELETE FROM character_sources");
  assert.equal(isFranchiseCatalogCurrent(db), true);
});

test("Wish tied direct targets use catalog rank, not UUID order", (t) => {
  const { db } = fixture(t, "release");
  const tied = db
    .prepare(
      "SELECT c.id FROM characters c JOIN effective_character_franchises f ON f.character_id=c.id WHERE f.franchise_id=10 ORDER BY c.id DESC",
    )
    .all();
  db.exec(
    "UPDATE characters SET rank=rank+100, tie_order=tie_order+100; UPDATE characters SET favourites=10",
  );
  tied.forEach((row, index) =>
    db
      .prepare("UPDATE characters SET rank=?,tie_order=? WHERE id=?")
      .run(index + 1, index + 1, row.id),
  );
  const first = wishUponAStar.execute({
    db,
    guildId: "1",
    userId: "2",
    args: ["Shared"],
    random: () => 0,
  });
  assert.equal(first.character.id, tied[0].id);
  const third = wishUponAStar.execute({
    db,
    guildId: "9",
    userId: "2",
    args: ["Shared"],
    random: () => 0.99,
  });
  assert.equal(third.character.id, tied[2].id);
  assert.notEqual(third.character.id, tied[3].id);
});

test("legacy cover reader needs no curated columns and rejects credentials", (t) => {
  const { db } = fixture(t, "legacy");
  assert.equal(loadFranchiseCover(db, 10), "https://example.com/anime.jpg");
  db.exec(
    `UPDATE anime SET cover_image = 'https://user@example.com/cover.jpg'`,
  );
  assert.equal(loadFranchiseCover(db, 10), null);
});
