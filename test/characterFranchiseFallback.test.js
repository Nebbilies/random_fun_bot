import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { openCatalog } from "../lib/catalogDb.js";
import { migrateCharacterIdentities } from "../lib/characterIdentityMigration.js";
import { initializeCatalogReleaseSchema } from "../lib/catalogReleaseSchema.js";
import {
  previewManualCharacterCreation,
  confirmManualCharacterCreation,
} from "../lib/manualCharacterMutations.js";
import { characterSeries } from "../lib/characterSeries.js";
import {
  captureCharacterSnapshot,
  validateCharacterSnapshot,
} from "../lib/characterSnapshot.js";
import { loadCharacterIndex } from "../lib/gameCharacterLookup.js";
import { marryCharacter, listMarriages } from "../lib/characterMarriage.js";
import {
  reserveRoll,
  loadRollCharacterSnapshot,
  getMysterySession,
} from "../lib/characterRolls.js";
import { selectedMysteryCharacter } from "../lib/mysteryCoordinator.js";
import { rollCard, startForcedEscape } from "../lib/characterRollRuntime.js";
import { sirensCall } from "../lib/items/sirensCall.js";
import { topCharacters } from "../lib/topCharacters.js";
import { publishMasqueradeReveal } from "../lib/masqueradeReveal.js";
import { run as charCommand } from "../commands/char.js";
import { run as mmCommand } from "../commands/mm.js";

const serialize = (payload) =>
  JSON.stringify(payload.components.map((c) => c.toJSON()));
function fixture(t) {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  db.exec(
    "INSERT INTO franchises(id,display_name,created_at) VALUES(1,'Zulu','now'),(2,'Alpha','now')",
  );
  migrateCharacterIdentities(db, { dryRun: false, targetVersion: 11 });
  initializeCatalogReleaseSchema(db);
  const auth = { account: "editor", role: "moderator" };
  const preview = previewManualCharacterCreation(db, {
    ...auth,
    rank: 1,
    now: 1000,
    input: {
      name: "Manual Hero",
      gender: "female",
      franchiseIds: [1, 2],
      aliases: [],
      portraitUrl: "https://example.test/hero.png",
      description: "",
      referenceUrl: "https://example.test/ref",
    },
  });
  const result = confirmManualCharacterCreation(db, {
    ...auth,
    previewId: preview.previewId,
    payloadHash: preview.payloadHash,
    idempotencyKey: "create",
    now: 1001,
  });
  return { db, id: result.characterId };
}
function reserve(db, commandMessageId = "100", mystery = null) {
  return reserveRoll(db, {
    guildId: "1",
    channelId: "10",
    commandMessageId,
    userId: "101",
    pool: "w",
    now: 10000,
    random: () => 0,
    mystery,
  });
}
function context(db, args, index = loadCharacterIndex(db)) {
  const collector = Object.assign(new EventEmitter(), { stop() {} });
  const sent = [];
  const card = {
    id: "500",
    edit: async (payload) => {
      sent.push(payload);
    },
    createMessageComponentCollector: () => collector,
  };
  return {
    sent,
    collector,
    ctx: {
      args,
      prefix: "!",
      yoshiko: {
        catalogDb: db,
        characterIndex: index,
        imagePicker: {
          pick: async () => ({ url: "https://example.test/hero.png" }),
        },
      },
      message: {
        id: "100",
        guildId: "1",
        channelId: "10",
        author: { id: "101" },
        reply: async (payload) => {
          sent.push(payload);
          return card;
        },
      },
    },
  };
}

test("shared series policy prefers anime, sorts/deduplicates franchises and preserves unknowns", () => {
  assert.deepEqual(
    characterSeries({
      anime_titles: '["Anime Z","Anime A"]',
      franchise_names: '["Alpha"]',
    }),
    { label: "Anime", text: "Anime Z (+1 more)" },
  );
  for (const anime_titles of ["[]", null, "not json", "{}", '[null," "]']) {
    assert.deepEqual(
      characterSeries({
        anime_titles,
        franchise_names: '["Zulu","alpha","Alpha","Zulu"]',
      }),
      { label: "Franchise", text: "Alpha (+2 more)" },
    );
  }
  assert.deepEqual(characterSeries({}, "-"), { label: "Anime", text: "-" });
  assert.equal(
    characterSeries({ franchise_names: '["Zulu","Alpha"]' }).text,
    "Alpha (+1 more)",
  );
});

test("real manual/direct character is hydrated by production search, harem, top and roll reads", (t) => {
  const { db, id } = fixture(t);
  assert.equal(
    db.prepare("SELECT anime_titles FROM characters WHERE id=?").get(id)
      .anime_titles,
    "[]",
  );
  assert.equal(
    db
      .prepare("SELECT count(*) AS n FROM character_anime WHERE character_id=?")
      .get(id).n,
    0,
  );
  const index = loadCharacterIndex(db);
  assert.equal(characterSeries(index[0]).text, "Alpha (+1 more)");
  marryCharacter(db, "1", id, "101");
  assert.equal(
    characterSeries(listMarriages(db, "1", "101")[0]).text,
    "Alpha (+1 more)",
  );
  assert.equal(topCharacters(db)[0].anime, "Alpha (+1 more)");
  const roll = reserve(db);
  assert.equal(roll.status, "reserved");
  assert.equal(roll.character.version, 2);
  assert.equal(characterSeries(roll.character).text, "Alpha (+1 more)");
  assert.match(
    serialize(rollCard(roll.character, null, 6)),
    /Alpha \(\+1 more\)/,
  );
});

test("legacy anime-derived franchise relation is hydrated without release views", (t) => {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  db.exec(`INSERT INTO characters(id,rank,favourites,name_full,anime_titles) VALUES(1,1,1,'Legacy','[]');
    INSERT INTO anime(id,title_romaji,fetched_at) VALUES(10,'Legacy','now');
    INSERT INTO franchises(id,display_name,created_at) VALUES(1,'Derived','now');
    INSERT INTO character_anime(character_id,anime_id) VALUES(1,10);
    INSERT INTO franchise_anime(franchise_id,anime_id) VALUES(1,10)`);
  assert.equal(characterSeries(loadCharacterIndex(db)[0]).text, "Derived");
});

test("char detail/chooser and individual harem cards use fallback and correct label", async (t) => {
  const { db, id } = fixture(t);
  const detail = context(db, ["char", "#1"]);
  await charCommand(detail.ctx);
  assert.match(
    serialize(detail.sent[0]),
    /\*\*Franchise:\*\* Alpha \(\+1 more\)/,
  );
  assert.doesNotMatch(serialize(detail.sent[0]), /\*\*Anime:\*\*/);
  const index = loadCharacterIndex(db);
  const chooser = context(
    db,
    ["char", "Manual"],
    [
      ...index,
      { ...index[0], id: "00000000-0000-4000-8000-000000000099", rank: 2 },
    ],
  );
  await charCommand(chooser.ctx);
  assert.match(serialize(chooser.sent[0]), /Alpha \(\+1 more\)/);
  marryCharacter(db, "1", id, "101");
  const harem = context(db, ["mmi"]);
  await mmCommand(harem.ctx);
  assert.match(
    serialize(harem.sent[0]),
    /\*\*Franchise:\*\* Alpha \(\+1 more\)/,
  );
});

test("Masquerade production reveal hydrates manual/direct franchise names", async (t) => {
  const { db, id } = fixture(t);
  const sent = [];
  await publishMasqueradeReveal({
    db,
    action: {
      actor_id: "101",
      selections: {},
      result: {
        targets: [
          { characterId: id, ownerId: "101", rank: 1, name: "Manual Hero" },
        ],
        assignment: [0],
      },
    },
    channel: {
      send: async (payload) => {
        sent.push(serialize(payload));
        return { id: "500" };
      },
    },
    saveProgress() {},
    wait: async () => {},
  });
  assert.match(sent.at(-1), /Alpha \(\+1 more\)/);
});

for (const mystery of [false, true])
  test(`${mystery ? "mystery" : "ordinary"} snapshot recovery freezes franchise names across rename/removal`, (t) => {
    const { db } = fixture(t);
    const roll = reserve(
      db,
      "100",
      mystery
        ? {
            eventChannelId: "10",
            selectEvent: () => ({
              eventId: "doors",
              durationMs: 60000,
              state: {},
            }),
          }
        : null,
    );
    const original = roll.character;
    db.exec(
      "UPDATE franchises SET display_name='Renamed'; DELETE FROM character_franchise_memberships;",
    );
    assert.deepEqual(loadRollCharacterSnapshot(db, roll.rollId), original);
    if (mystery)
      assert.deepEqual(
        selectedMysteryCharacter(db, getMysterySession(db, roll.sessionId)),
        original,
      );
    assert.equal(characterSeries(original).text, "Alpha (+1 more)");
    // Recovery must not even require the current membership tables to exist.
    db.exec("DROP VIEW effective_character_franchises");
    assert.deepEqual(loadRollCharacterSnapshot(db, roll.rollId), original);
    if (mystery)
      assert.deepEqual(
        selectedMysteryCharacter(db, getMysterySession(db, roll.sessionId)),
        original,
      );
  });

test("historical v1 stored roll and mystery snapshots recover without live franchise enrichment", (t) => {
  const { db } = fixture(t);
  const roll = reserve(db, "100", {
    eventChannelId: "10",
    selectEvent: () => ({ eventId: "doors", durationMs: 60000, state: {} }),
  });
  const { franchise_names, ...legacy } = { ...roll.character, version: 1 };
  db.prepare(
    "UPDATE character_rolls SET character_snapshot_json=? WHERE id=?",
  ).run(JSON.stringify(legacy), roll.rollId);
  const session = getMysterySession(db, roll.sessionId);
  const state = { ...JSON.parse(session.stateJson), characterSnapshot: legacy };
  db.prepare("UPDATE mystery_sessions SET state_json=? WHERE id=?").run(
    JSON.stringify(state),
    roll.sessionId,
  );
  db.exec(
    "UPDATE franchises SET display_name='Renamed'; DROP VIEW effective_character_franchises",
  );
  assert.deepEqual(loadRollCharacterSnapshot(db, roll.rollId), legacy);
  assert.deepEqual(
    selectedMysteryCharacter(db, getMysterySession(db, roll.sessionId)),
    legacy,
  );
  assert.equal(
    characterSeries(loadRollCharacterSnapshot(db, roll.rollId)).text,
    "Unknown anime",
  );
});

test("Siren pending escape captures fallback before rename and delivers frozen names", async (t) => {
  const { db, id } = fixture(t);
  marryCharacter(db, "1", id, "101");
  const result = sirensCall.execute({
    db,
    guildId: "1",
    userId: "102",
    channelId: "10",
    args: ["<@101>"],
    random: () => 0,
    now: 10000,
  });
  assert.equal(result.success, true);
  const original = loadRollCharacterSnapshot(
    db,
    result.escapeAttempt.pendingRollId,
  );
  db.exec(
    "UPDATE franchises SET display_name='Renamed'; DELETE FROM character_franchise_memberships",
  );
  const sent = [];
  const delivered = await startForcedEscape({
    db,
    guildId: "1",
    channelId: "10",
    ...result.escapeAttempt,
    now: () => 10000,
    setTimer: () => ({ unref() {} }),
    clearTimer() {},
    channel: {
      send: async (payload) => {
        sent.push(serialize(payload));
        return { id: "500", edit: async () => {} };
      },
    },
  });
  assert.equal(delivered.status, "started");
  assert.deepEqual(delivered.character, original);
  assert.match(sent[0], /Alpha \(\+1 more\)/);
  assert.doesNotMatch(sent[0], /Renamed/);
});

test("v1 exact keys stay valid and unenriched; v2 requires exact, valid frozen names", () => {
  const current = captureCharacterSnapshot({
    id: 1,
    name_full: "Historical Hero",
    rank: 1,
    favourites: 0,
    anime_titles: "[]",
    franchise_names: '["Original"]',
  });
  const { franchise_names, ...legacy } = { ...current, version: 1 };
  assert.deepEqual(validateCharacterSnapshot(legacy), legacy);
  assert.deepEqual(captureCharacterSnapshot(legacy), legacy);
  assert.equal(characterSeries(legacy).text, "Unknown anime");
  const legacyAnime = {
    ...legacy,
    anime_titles: '["First Anime","Second Anime"]',
  };
  assert.equal(characterSeries(legacyAnime).text, "First Anime");
  assert.match(serialize(rollCard(legacyAnime, null, 6)), /First Anime/);
  assert.doesNotMatch(serialize(rollCard(legacyAnime, null, 6)), /more/);
  assert.throws(
    () => validateCharacterSnapshot({ ...legacy, franchise_names }),
    /snapshot/,
  );
  for (const bad of [null, "null", "{}", "[null]", '[""]', "bad"]) {
    assert.throws(
      () => validateCharacterSnapshot({ ...current, franchise_names: bad }),
      /snapshot/,
    );
  }
  assert.throws(
    () => validateCharacterSnapshot({ ...current, extra: true }),
    /snapshot/,
  );
  const { franchise_names: omitted, ...missing } = current;
  assert.throws(() => validateCharacterSnapshot(missing), /snapshot/);
});
