import assert from "node:assert/strict";
import test from "node:test";
import { openCatalog } from "../lib/catalogDb.js";
import { MAIN_FRANCHISE_DDL } from "../lib/catalogFinalSchema.js";
import { addItemToInventory } from "../lib/itemStorage.js";
import { marryCharacter, getMarriage } from "../lib/characterMarriage.js";
import { createItemAction, activateItemAction } from "../lib/itemActions.js";
import {
  getItemDefinition,
  getResolvedItemDefinition,
} from "../lib/itemRoster.js";
import {
  initGameConfig,
  getConfigView,
  saveConfigSection,
  getGameConfig,
} from "../lib/gameConfig.js";
import { publishThreadbreakerReveal } from "../lib/threadbreakerReveal.js";
import { aegisOfFidelity } from "../lib/items/aegisOfFidelity.js";

function setup(t) {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  db.exec(`INSERT INTO franchises(id,display_name,created_at) VALUES(10,'Test','now');
    INSERT INTO anime(id,title_romaji,fetched_at) VALUES(100,'Test','now');
    INSERT INTO franchise_anime(franchise_id,anime_id) VALUES(10,100);`);
  for (let id = 1; id <= 4; id++) {
    db.prepare(
      "INSERT INTO characters(id,rank,favourites,name_full) VALUES(?,?,1,?)",
    ).run(id, id, `C${id}`);
    db.prepare(
      "INSERT INTO character_anime(character_id,anime_id) VALUES(?,100)",
    ).run(id);
    marryCharacter(db, "1", id, id >= 3 ? "101" : "202");
  }
  db.exec(
    MAIN_FRANCHISE_DDL.replace("character_id TEXT", "character_id INTEGER"),
  );
  db.exec(
    "INSERT INTO character_main_franchises VALUES(1,10),(2,10),(3,10),(4,10)",
  );
  const item = addItemToInventory(db, "1", "101", "threadbreaker", 1).item;
  const action = createItemAction(db, {
    guildId: "1",
    actorId: "101",
    channelId: "10",
    inventoryId: item.id,
    now: 1000,
    selections: { franchise: { id: 10, name: "Test" } },
  });
  return { db, action };
}
test("Threadbreaker stops the entire descending chain on same-owner survival and replays without RNG", (t) => {
  const { db, action } = setup(t);
  const result = activateItemAction(db, {
    actionId: action.id,
    guildId: "1",
    actorId: "101",
    now: 1001,
    random: () => 0.9,
  });
  assert.deepEqual(
    result.visited.map((c) => [c.characterId, c.divorced]),
    [
      [4, true],
      [3, false],
    ],
  );
  assert.equal(getMarriage(db, "1", 4), null);
  assert.ok(getMarriage(db, "1", 3));
  assert.ok(getMarriage(db, "1", 2));
  assert.deepEqual(
    activateItemAction(db, {
      actionId: action.id,
      guildId: "1",
      actorId: "101",
      now: 1002,
      random: () => {
        throw Error("reroll");
      },
    }),
    result,
  );
});
test("Threadbreaker rechecks assignments and preserves an effective-only marriage", (t) => {
  const { db, action } = setup(t);
  db.exec("DELETE FROM character_main_franchises WHERE character_id=4");
  const result = activateItemAction(db, {
    actionId: action.id,
    guildId: "1",
    actorId: "101",
    now: 1001,
    random: () => 0,
  });
  assert.equal(result.visited[0].characterId, 3);
  assert.ok(getMarriage(db, "1", 4));
});

test("Threadbreaker description preserves emphasis and resolves the configured chance", () => {
  const config = structuredClone(getGameConfig());
  config.itemEffects.threadbreaker.divorceChance = 0.25;
  assert.equal(getItemDefinition("threadbreaker").maxCharges, 1);
  const item = getResolvedItemDefinition(null, null, "threadbreaker", config);
  assert.match(item.description, /\*\*highest rank \*number\*\*\*/);
  assert.match(item.description, /25%/);
});
test("Threadbreaker reveals suspense, edits verdicts, then sends the exact ending", async (t) => {
  const { db, action } = setup(t);
  action.result = {
    franchise: { name: "Test" },
    visited: [
      { characterId: 4, rank: 4, name: "C4", ownerId: "101", divorced: true },
      { characterId: 3, rank: 3, name: "C3", ownerId: "101", divorced: false },
    ],
  };
  const events = [];
  const messages = new Map();
  let saved;
  const channel = {
    messages: { fetch: async (id) => messages.get(id) },
    send: async (data) => {
      const id = String(messages.size + 1);
      const m = { id, edit: async (data) => events.push(["edit", data]) };
      messages.set(id, m);
      events.push(["send", data]);
      return m;
    },
  };
  await publishThreadbreakerReveal({
    db,
    action,
    channel,
    saveProgress: (p) => (saved = p),
    wait: async (ms) => events.push(["wait", ms]),
  });
  assert.deepEqual(
    events.map((e) => e[0]),
    [
      "send",
      "wait",
      "send",
      "wait",
      "edit",
      "wait",
      "send",
      "wait",
      "edit",
      "send",
    ],
  );
  assert.ok(events.filter((e) => e[0] === "wait").every((e) => e[1] === 3000));
  assert.match(JSON.stringify(events.at(-1)), /## The chain ended!/);
  assert.equal(saved.stage, "done");
});

for (const chance of [0, 1])
  test(`configured divorce chance ${chance} applies at confirmation`, (t) => {
    const { db, action } = setup(t);
    initGameConfig(db);
    saveConfigSection(db, {
      guildId: "1",
      section: "itemEffects",
      expectedRevision: getConfigView(db, "1").revision,
      values: { "itemEffects.threadbreaker.divorceChance": chance },
    });
    const result = activateItemAction(db, {
      actionId: action.id,
      guildId: "1",
      actorId: "101",
      now: 1001,
      random: () => 0.4,
    });
    assert.equal(result.divorceChance, chance);
    assert.deepEqual(
      result.visited.map((c) => [c.characterId, c.divorced]),
      chance === 0
        ? [
            [4, true],
            [3, false],
          ]
        : [
            [4, true],
            [3, true],
            [2, true],
            [1, true],
          ],
    );
  });

for (const now of [1999, 2000])
  test(`Threadbreaker honors Aegis deadline at ${now}`, (t) => {
    const { db, action } = setup(t);
    saveConfigSection(db, {
      guildId: "1",
      section: "itemEffects",
      expectedRevision: getConfigView(db, "1").revision,
      values: { "itemEffects.aegis_of_fidelity.protectionMs": 1_000 },
    });
    assert.equal(
      aegisOfFidelity.execute({
        db,
        guildId: "1",
        userId: "101",
        args: ["C4"],
        now: 1_000,
      }).success,
      true,
    );
    const result = activateItemAction(db, {
      actionId: action.id,
      guildId: "1",
      actorId: "101",
      now,
      random: () => 0,
    });
    assert.deepEqual(
      result.visited.map((row) => row.characterId),
      now < 2_000 ? [3, 2, 1] : [4, 3, 2, 1],
    );
  });
