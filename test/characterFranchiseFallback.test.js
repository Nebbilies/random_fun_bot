import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { openCatalog } from "../lib/catalogDb.js";
import { MAIN_FRANCHISE_DDL } from "../lib/catalogFinalSchema.js";
import { migrateCharacterIdentities } from "../lib/characterIdentityMigration.js";
import { initializeCatalogReleaseSchema } from "../lib/catalogReleaseSchema.js";
import {
  previewManualCharacterCreation,
  confirmManualCharacterCreation,
} from "../lib/manualCharacterMutations.js";
import {
  characterMainFranchises,
  withCharacterMainFranchises,
} from "../lib/characterSeries.js";
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
    "INSERT INTO franchises(id,display_name,created_at) VALUES(1,'Zulu','now'),(2,'Alpha','now'),(3,'Zebra Main','now'),(4,'Alpha Main','now')",
  );
  migrateCharacterIdentities(db, { dryRun: false, targetVersion: 11 });
  initializeCatalogReleaseSchema(db);
  db.exec(MAIN_FRANCHISE_DDL);
  const auth = { account: "editor", role: "moderator" };
  const preview = previewManualCharacterCreation(db, {
    ...auth,
    rank: 1,
    now: 1000,
    input: {
      name: "Manual Hero",
      gender: "female",
      franchiseIds: [1, 2],
      mainFranchiseIds: [3, 4],
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

test("character cards use assigned main franchises when anime and direct memberships differ", async (t) => {
  const { db, id } = fixture(t);
  db.prepare("UPDATE characters SET anime_titles=? WHERE id=?").run(
    '["Original Anime"]',
    id,
  );

  const detail = context(db, ["char", "#1"]);
  await charCommand(detail.ctx);
  const card = serialize(detail.sent[0]);
  assert.match(card, /\*\*Franchises:\*\* Alpha Main, Zebra Main/);
  assert.doesNotMatch(card, /Original Anime|Zulu/);
});

test("main franchise display sorts names and counts only titles that do not fit", () => {
  assert.equal(
    characterMainFranchises({
      anime_titles: '["Anime"]',
      franchise_names: '["Effective"]',
    }),
    null,
  );
  const character = {
    main_franchise_names: '["Zulu","Alpha","Alpha","Gamma Long"]',
  };
  assert.deepEqual(characterMainFranchises(character), {
    label: "Franchises",
    text: "Alpha, Gamma Long, Zulu",
  });
  assert.equal(characterMainFranchises(character, 16).text, "Alpha (+2 more)");
  assert.equal(
    characterMainFranchises({ main_franchise_names: '["Long Series","X"]' }, 14)
      .text,
    "Long Series, X",
  );
});

test("new roll snapshots preserve the main franchise names across a later rename", (t) => {
  const { db } = fixture(t);

  const roll = reserve(db);
  assert.equal(roll.status, "reserved");
  assert.equal(roll.character.version, 3);
  assert.equal(
    roll.character.main_franchise_names,
    '["Alpha Main","Zebra Main"]',
  );

  db.exec("UPDATE franchises SET display_name='Renamed' WHERE id=3");
  const saved = loadRollCharacterSnapshot(db, roll.rollId);
  assert.deepEqual(saved, roll.character);
  assert.match(serialize(rollCard(saved, null, 6)), /Alpha Main, Zebra Main/);
  assert.doesNotMatch(serialize(rollCard(saved, null, 6)), /Renamed|Zulu/);
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
  assert.equal(
    characterMainFranchises(index[0]).text,
    "Alpha Main, Zebra Main",
  );
  marryCharacter(db, "1", id, "101");
  assert.equal(
    characterMainFranchises(listMarriages(db, "1", "101")[0]).text,
    "Alpha Main, Zebra Main",
  );
  assert.equal(
    characterMainFranchises(topCharacters(db)[0]).text,
    "Alpha Main, Zebra Main",
  );
  const roll = reserve(db);
  assert.equal(roll.status, "reserved");
  assert.equal(roll.character.version, 3);
  assert.equal(
    characterMainFranchises(roll.character).text,
    "Alpha Main, Zebra Main",
  );
  assert.match(
    serialize(rollCard(roll.character, null, 6)),
    /Alpha Main, Zebra Main/,
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
  assert.equal(characterMainFranchises(loadCharacterIndex(db)[0]), null);
});

test("char detail/chooser and individual harem cards use main assignments and correct label", async (t) => {
  const { db, id } = fixture(t);
  const detail = context(db, ["char", "#1"]);
  await charCommand(detail.ctx);
  assert.match(
    serialize(detail.sent[0]),
    /\*\*Franchises:\*\* Alpha Main, Zebra Main/,
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
  assert.match(serialize(chooser.sent[0]), /Alpha Main, Zebra Main/);
  marryCharacter(db, "1", id, "101");
  const harem = context(db, ["mmi"]);
  await mmCommand(harem.ctx);
  assert.match(
    serialize(harem.sent[0]),
    /\*\*Franchises:\*\* Alpha Main, Zebra Main/,
  );
});

test("Masquerade production reveal shows assigned main franchise names", async (t) => {
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
  assert.match(sent.at(-1), /Alpha Main, Zebra Main/);
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
    assert.equal(
      characterMainFranchises(original).text,
      "Alpha Main, Zebra Main",
    );
    // Recovery must not even require the current membership tables to exist.
    db.exec("DROP VIEW effective_character_franchises");
    assert.deepEqual(loadRollCharacterSnapshot(db, roll.rollId), original);
    if (mystery)
      assert.deepEqual(
        selectedMysteryCharacter(db, getMysterySession(db, roll.sessionId)),
        original,
      );
  });

for (const version of [1, 2]) {
  test(`v${version} recovery can render current main franchises without changing the saved snapshot`, (t) => {
    const { db } = fixture(t);
    const roll = reserve(db, "100", {
      eventChannelId: "10",
      selectEvent: () => ({ eventId: "doors", durationMs: 60000, state: {} }),
    });
    const { main_franchise_names, ...base } = roll.character;
    const legacy = {
      ...base,
      version,
      ...(version === 2 ? { franchise_names: '["Old effective"]' } : {}),
    };
    db.prepare(
      "UPDATE character_rolls SET character_snapshot_json=? WHERE id=?",
    ).run(JSON.stringify(legacy), roll.rollId);
    const session = getMysterySession(db, roll.sessionId);
    const state = {
      ...JSON.parse(session.stateJson),
      characterSnapshot: legacy,
    };
    db.prepare("UPDATE mystery_sessions SET state_json=? WHERE id=?").run(
      JSON.stringify(state),
      roll.sessionId,
    );

    db.exec("UPDATE franchises SET display_name='Current Main' WHERE id=3");
    const saved = loadRollCharacterSnapshot(db, roll.rollId);
    assert.deepEqual(saved, legacy);
    assert.deepEqual(
      selectedMysteryCharacter(db, getMysterySession(db, roll.sessionId)),
      legacy,
    );
    const render = withCharacterMainFranchises(db, saved);
    assert.equal(
      characterMainFranchises(render).text,
      "Alpha Main, Current Main",
    );
    assert.deepEqual(loadRollCharacterSnapshot(db, roll.rollId), legacy);
  });
}

test("an explicitly empty published main-franchise list stays empty", (t) => {
  const { db, id } = fixture(t);
  db.prepare("DELETE FROM character_main_franchises WHERE character_id=?").run(
    id,
  );
  const roll = reserve(db);
  db.prepare("INSERT INTO character_main_franchises VALUES (?,3)").run(id);
  assert.equal(roll.character.main_franchise_names, "[]");
  assert.equal(
    characterMainFranchises(withCharacterMainFranchises(db, roll.character)),
    null,
  );
});

test("Siren pending escape captures main franchises before rename and delivers frozen names", async (t) => {
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
  assert.match(sent[0], /Alpha Main, Zebra Main/);
  assert.doesNotMatch(sent[0], /Renamed/);
});

test("published snapshots validate their own exact versioned franchise fields", () => {
  const current = captureCharacterSnapshot({
    id: 1,
    name_full: "Historical Hero",
    rank: 1,
    favourites: 0,
    anime_titles: '["Original Anime"]',
    main_franchise_names: '["Original Main"]',
  });
  const { main_franchise_names, ...base } = current;
  const first = { ...base, version: 1 };
  const second = {
    ...base,
    version: 2,
    franchise_names: '["Original Effective"]',
  };
  for (const snapshot of [first, second, current]) {
    assert.deepEqual(validateCharacterSnapshot(snapshot), snapshot);
    assert.deepEqual(captureCharacterSnapshot(snapshot), snapshot);
    assert.throws(
      () => validateCharacterSnapshot({ ...snapshot, extra: true }),
      /snapshot/,
    );
  }
  assert.doesNotMatch(serialize(rollCard(first, null, 6)), /Original Anime/);
  assert.doesNotMatch(
    serialize(rollCard(second, null, 6)),
    /Original Effective/,
  );
  assert.match(serialize(rollCard(current, null, 6)), /Original Main/);
  assert.throws(
    () => validateCharacterSnapshot({ ...first, main_franchise_names }),
    /snapshot/,
  );
  assert.throws(
    () => validateCharacterSnapshot({ ...second, main_franchise_names }),
    /snapshot/,
  );
  assert.throws(() => validateCharacterSnapshot({ ...base }), /snapshot/);
  for (const bad of [null, "null", "{}", "[null]", '[""]', "bad"])
    assert.throws(
      () =>
        validateCharacterSnapshot({ ...current, main_franchise_names: bad }),
      /snapshot/,
    );
});
