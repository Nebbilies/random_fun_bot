import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCatalog } from "../lib/catalogDb.js";
import { migrateCharacterIdentities } from "../lib/characterIdentityMigration.js";
import { initializeCatalogReleaseSchema } from "../lib/catalogReleaseSchema.js";
import { captureCharacterSnapshot } from "../lib/characterSnapshot.js";
import {
  reserveRoll,
  publishRoll,
  claimRoll,
  getRoll,
  loadRollCharacterSnapshot,
  getMysterySession,
  publishMysteryIntro,
  advanceMysterySession,
  openMysteryClaim,
} from "../lib/characterRolls.js";

function fixture(version = 12, path = ":memory:") {
  const db = openCatalog(path);
  db.exec(`INSERT INTO characters(id,rank,favourites,name_full,image_url,anime_titles,gender)
    VALUES(12,1,1234,'Original prize','https://example.invalid/original','["Original anime"]','Female');
    INSERT INTO character_identities SELECT id,name_full,image_url FROM characters;
    INSERT INTO tag_decisions VALUES(12,'approve','original_tag','synthetic','synthetic');`);
  if (version >= 11)
    migrateCharacterIdentities(db, { dryRun: false, targetVersion: 11 });
  if (version === 12) initializeCatalogReleaseSchema(db);
  return db;
}
function reserve(db, mystery = null) {
  return reserveRoll(db, {
    guildId: "1",
    channelId: "10",
    commandMessageId: "100",
    userId: "101",
    pool: "w",
    now: 1000,
    random: () => 0,
    mystery,
  });
}
function claim(db, now = 1200) {
  return claimRoll(db, {
    guildId: "1",
    channelId: "10",
    messageId: "500",
    userId: "102",
    now,
  });
}
function writes(db) {
  return Object.fromEntries(
    db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name",
      )
      .all()
      .map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}"`).all()]),
  );
}
function editCatalog(db, id) {
  db.prepare(
    `UPDATE characters SET name_full='Edited prize', rank=2000, favourites=99,
    likes_source='anilist', image_url='https://example.invalid/edited',
    anime_titles='["Edited anime"]', gender='Male' WHERE id=?`,
  ).run(id);
}

test("actual v12 ordinary reserve terms survive catalog edits, raw reopen, publication and claim", () => {
  const directory = mkdtempSync(join(tmpdir(), "roll-published-"));
  const path = join(directory, "synthetic.sqlite");
  let db;
  try {
    db = fixture(12, path);
    const id = db.prepare("SELECT id FROM characters").get().id;
    db.prepare("UPDATE characters SET likes_source='generated' WHERE id=?").run(
      id,
    );
    const roll = reserve(db);
    assert.equal(roll.status, "reserved");
    assert.equal(Object.isFrozen(roll.character), true);
    assert.equal(roll.character.likes_source, "generated");
    assert.equal(roll.character.tag_name, "original_tag");
    assert.deepEqual(roll.character, captureCharacterSnapshot(roll.character));
    const json = db
      .prepare("SELECT character_snapshot_json FROM character_rolls WHERE id=?")
      .get(roll.rollId).character_snapshot_json;
    assert.deepEqual(JSON.parse(json), roll.character);
    editCatalog(db, id);
    db.exec("UPDATE tag_decisions SET tag_name='edited_tag'");
    db.close();
    db = new DatabaseSync(path);
    db.exec("PRAGMA foreign_keys=ON");
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 12);
    assert.deepEqual(
      loadRollCharacterSnapshot(db, roll.rollId),
      roll.character,
    );
    assert.equal(publishRoll(db, roll.rollId, "500", 1100), true);
    assert.equal(getRoll(db, "1", "10", "500").characterSnapshotJson, json);
    db.close();
    db = new DatabaseSync(path);
    db.exec("PRAGMA foreign_keys=ON");
    assert.equal(claim(db).status, "married");
    assert.equal(getRoll(db, "1", "10", "500").characterName, "Original prize");
    assert.deepEqual(
      loadRollCharacterSnapshot(db, roll.rollId),
      roll.character,
    );
  } finally {
    db?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const phase of ["publish", "claim"]) {
  test(`present corrupt ordinary snapshot fails closed before ${phase} writes`, () => {
    const db = fixture();
    try {
      const roll = reserve(db);
      if (phase === "claim")
        assert.equal(publishRoll(db, roll.rollId, "500", 1100), true);
      for (const invalid of [
        {},
        { ...roll.character, version: 999 },
        { ...roll.character, rank: 0 },
        { ...roll.character, favourites: -1 },
        { ...roll.character, likes_source: "unknown" },
        { ...roll.character, name_full: "Forged name" },
        { ...roll.character, id: "00000000-0000-4000-8000-000000000099" },
      ]) {
        db.prepare(
          "UPDATE character_rolls SET character_snapshot_json=? WHERE id=?",
        ).run(JSON.stringify(invalid), roll.rollId);
        const before = writes(db);
        assert.throws(
          () => loadRollCharacterSnapshot(db, roll.rollId),
          /snapshot/,
        );
        assert.throws(
          () =>
            phase === "publish"
              ? publishRoll(db, roll.rollId, "500", 1100)
              : claim(db),
          /snapshot/,
        );
        assert.deepEqual(writes(db), before);
      }
    } finally {
      db.close();
    }
  });
}

for (const version of [10, 11]) {
  test(`legacy v${version} without snapshot column reserves, publishes and claims`, () => {
    const db = fixture(version);
    try {
      assert.equal(
        db
          .prepare("PRAGMA table_info(character_rolls)")
          .all()
          .some((column) => column.name === "character_snapshot_json"),
        false,
      );
      const roll = reserve(db);
      assert.equal(roll.status, "reserved");
      assert.equal(roll.character.likes_source, "anilist");
      assert.equal(loadRollCharacterSnapshot(db, roll.rollId), null);
      assert.equal(publishRoll(db, roll.rollId, "500", 1100), true);
      assert.equal(getRoll(db, "1", "10", "500").characterSnapshotJson, null);
      assert.equal(claim(db).status, "married");
    } finally {
      db.close();
    }
  });
}

test("same connection sees explicit initializer column and failed initializer rolls it back", () => {
  const db = fixture(11);
  try {
    assert.equal(loadRollCharacterSnapshot(db, 1), null);
    db.exec("CREATE TABLE catalog_mutations(collision TEXT)");
    const before = db
      .prepare("SELECT name, sql FROM sqlite_schema ORDER BY name")
      .all();
    assert.throws(() => initializeCatalogReleaseSchema(db), /already exists/);
    assert.deepEqual(
      db.prepare("SELECT name, sql FROM sqlite_schema ORDER BY name").all(),
      before,
    );
    assert.equal(
      db
        .prepare("PRAGMA table_info(character_rolls)")
        .all()
        .some((column) => column.name === "character_snapshot_json"),
      false,
    );
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 11);
    db.exec("DROP TABLE catalog_mutations");
    initializeCatalogReleaseSchema(db);
    const roll = reserve(db);
    assert.deepEqual(
      loadRollCharacterSnapshot(db, roll.rollId),
      roll.character,
    );
    for (const json of ["broken", "[]", "null", "1", '"text"']) {
      assert.throws(
        () =>
          db
            .prepare("UPDATE character_rolls SET character_snapshot_json=?")
            .run(json),
        /CHECK/,
      );
    }
    db.exec("UPDATE character_rolls SET character_snapshot_json=NULL");
    assert.equal(loadRollCharacterSnapshot(db, roll.rollId), null);
    assert.equal(publishRoll(db, roll.rollId, "500", 1100), true);
    assert.equal(claim(db).status, "married");
  } finally {
    db.close();
  }
});

test("mystery reserve captures once before event mutation and stores matching ordinary terms", () => {
  const db = fixture();
  try {
    const roll = reserve(db, {
      eventChannelId: "10",
      selectEvent: ({ character }) => {
        character.name_full = "Event mutation";
        character.favourites = 0;
        return { eventId: "doors", durationMs: 60000, state: {} };
      },
    });
    assert.equal(roll.status, "mystery");
    assert.equal(roll.character.name_full, "Original prize");
    assert.equal(roll.character.favourites, 1234);
    assert.deepEqual(
      loadRollCharacterSnapshot(db, roll.rollId),
      roll.character,
    );
    assert.deepEqual(
      JSON.parse(getMysterySession(db, roll.sessionId).stateJson)
        .characterSnapshot,
      roll.character,
    );
    assert.equal(publishMysteryIntro(db, roll.sessionId, "499", 1000), true);
    const intro = getMysterySession(db, roll.sessionId);
    const running = advanceMysterySession(db, {
      sessionId: roll.sessionId,
      expectedState: "reserved",
      expectedStateJson: intro.stateJson,
      state: "running",
      now: 6000,
    });
    assert.equal(running.status, "advanced");
    assert.equal(
      advanceMysterySession(db, {
        sessionId: roll.sessionId,
        expectedState: "running",
        expectedStateJson: running.session.stateJson,
        state: "countdown",
        winnerId: "102",
        nextAt: 6100,
        now: 6001,
      }).status,
      "advanced",
    );
    const session = getMysterySession(db, roll.sessionId);
    for (const change of [
      { rank: 2 },
      { favourites: 1 },
      { likes_source: "generated" },
      { name_full: "Forged name" },
    ]) {
      const state = JSON.parse(session.stateJson);
      state.characterSnapshot = { ...state.characterSnapshot, ...change };
      db.prepare("UPDATE mystery_sessions SET state_json=? WHERE id=?").run(
        JSON.stringify(state),
        roll.sessionId,
      );
      const before = writes(db);
      assert.throws(
        () => loadRollCharacterSnapshot(db, roll.rollId),
        /snapshot/,
      );
      assert.throws(
        () =>
          openMysteryClaim(db, {
            sessionId: roll.sessionId,
            messageId: "500",
            now: 6100,
          }),
        /snapshot/,
      );
      assert.deepEqual(writes(db), before);
    }
    db.prepare("UPDATE mystery_sessions SET state_json=? WHERE id=?").run(
      session.stateJson,
      roll.sessionId,
    );
    assert.equal(
      openMysteryClaim(db, {
        sessionId: roll.sessionId,
        messageId: "500",
        now: 6100,
      }).status,
      "open",
    );
    const state = JSON.parse(session.stateJson);
    state.characterSnapshot.favourites = 2;
    db.prepare("UPDATE mystery_sessions SET state_json=? WHERE id=?").run(
      JSON.stringify(state),
      roll.sessionId,
    );
    const before = writes(db);
    assert.throws(() => claim(db, 6200), /snapshot/);
    assert.deepEqual(writes(db), before);
    db.prepare("UPDATE mystery_sessions SET state_json=? WHERE id=?").run(
      session.stateJson,
      roll.sessionId,
    );
    assert.equal(claim(db, 6200).status, "married");
  } finally {
    db.close();
  }
});
