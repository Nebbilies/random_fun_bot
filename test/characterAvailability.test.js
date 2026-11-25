import assert from "node:assert/strict";
import { test } from "node:test";
import { openCatalog } from "../lib/catalogDb.js";
import {
  marryCharacter,
  divorceCharacter,
  getMarriage,
} from "../lib/characterMarriage.js";
import {
  reserveRoll,
  failRoll,
  publishRoll,
  claimRoll,
} from "../lib/characterRolls.js";
import { startForcedEscape } from "../lib/characterRollRuntime.js";
import { wishUponAStar } from "../lib/items/wishUponAStar.js";
import { bloodPact } from "../lib/items/bloodPact.js";
import {
  startGift,
  onTradeAnswer,
  cancelTransfer,
} from "../lib/tradeRuntime.js";
import { aegisOfFidelity } from "../lib/items/aegisOfFidelity.js";
import { transferCharacter } from "../lib/characterTrade.js";
import {
  isCharacterBusy,
  isCharacterHeld,
  registerPendingTransfer,
  unregisterPendingTransfer,
} from "../lib/characterAvailability.js";

function fixture(t) {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  // Parent supplies these tables in the migration; allow this focused suite to run during integration.
  db.exec(`CREATE TABLE IF NOT EXISTS item_character_reservations (
    guild_id TEXT, character_id INTEGER, action_id TEXT, owner_id TEXT, marriage_id INTEGER,
    PRIMARY KEY(guild_id, character_id));
    CREATE TABLE IF NOT EXISTS counterfeit_crowns (
    guild_id TEXT, user_id TEXT, character_id INTEGER, marriage_id INTEGER, generation_id TEXT,
    PRIMARY KEY(guild_id, user_id));
    INSERT INTO characters (id, rank, favourites, name_full) VALUES (1, 1, 100, 'One'), (2, 2, 90, 'Two');`);
  return db;
}

function stake(db, characterId = 1) {
  const marriage = getMarriage(db, "1", characterId);
  db.prepare(
    "INSERT INTO item_character_reservations VALUES (?, ?, ?, ?, ?)",
  ).run(
    "1",
    characterId,
    "hostage",
    marriage?.ownerId ?? "101",
    marriage?.id ?? 1,
  );
}

test("Hostage stakes block ownership changes without blocking unrelated characters", (t) => {
  const db = fixture(t);
  const marriage = marryCharacter(db, "1", 1, "101").marriage;
  marryCharacter(db, "1", 2, "101");
  stake(db);
  assert.equal(isCharacterBusy(db, "1", 1, 100), true);
  assert.equal(isCharacterBusy(db, "1", 1, 100, "hostage"), false);
  assert.equal(isCharacterBusy(db, "2", 1, 100), false);
  assert.equal(divorceCharacter(db, "1", 1, "101", marriage.id), false);
  assert.notEqual(
    transferCharacter(db, {
      guildId: "1",
      characterId: 1,
      fromOwnerId: "101",
      toOwnerId: "102",
      now: 100,
    }).status,
    "transferred",
  );
  assert.equal(
    transferCharacter(db, {
      guildId: "1",
      characterId: 2,
      fromOwnerId: "101",
      toOwnerId: "102",
      now: 100,
    }).status,
    "transferred",
  );
  assert.equal(getMarriage(db, "1", 1).ownerId, "101");
});

test("selected transfer offers and pending/live escapes are busy only in their scope and lifetime", (t) => {
  const db = fixture(t);
  registerPendingTransfer(db, "trade:1", "1", [1], 200);
  assert.equal(isCharacterBusy(db, "1", 1, 100), true);
  assert.equal(isCharacterBusy(db, "1", 1, 100, "trade:1"), false);
  assert.equal(isCharacterBusy(db, "1", 1, 200), false);
  unregisterPendingTransfer(db, "trade:1");
  assert.equal(isCharacterBusy(db, "1", 1, 100), false);
  marryCharacter(db, "1", 1, "101");
  const roll = reserveRoll(db, {
    guildId: "1",
    channelId: "10",
    commandMessageId: "100",
    userId: "101",
    pool: "w",
    now: 100,
    random: () => 0,
  });
  assert.equal(isCharacterBusy(db, "1", 1, 100), true);
  assert.equal(isCharacterHeld(db, "1", 1, 100), true);
  publishRoll(db, roll.rollId, "500", 100);
  const { expires_at: deadline } = db
    .prepare("SELECT expires_at FROM character_rolls WHERE id = ?")
    .get(roll.rollId);
  assert.equal(isCharacterBusy(db, "1", 1, deadline), false);
  assert.equal(isCharacterHeld(db, "1", 1, deadline), false);
  failRoll(db, roll.rollId);
});

test("reserved characters cannot escape or gain soulbinding while other rolls continue", async (t) => {
  const db = fixture(t);
  marryCharacter(db, "1", 1, "101");
  stake(db);
  const result = reserveRoll(db, {
    guildId: "1",
    channelId: "10",
    commandMessageId: "100",
    userId: "101",
    pool: "w",
    now: 100,
    random: () => 0,
  });
  assert.equal(result.character.id, 2);
  const forced = await startForcedEscape({
    db,
    guildId: "1",
    channelId: "10",
    ownerId: "101",
    characterId: 1,
    now: () => 100,
    channel: {
      send() {
        throw new Error("must not send");
      },
    },
  });
  assert.notEqual(forced.status, "started");
  assert.equal(
    aegisOfFidelity.execute({
      db,
      guildId: "1",
      userId: "101",
      args: ["One"],
      now: 100,
    }).success,
    false,
  );
});

test("forced escape rejects stale marriage snapshots and clears pending state on delivery failure", async (t) => {
  const db = fixture(t);
  const marriage = marryCharacter(db, "1", 1, "101").marriage;
  const request = {
    db,
    guildId: "1",
    channelId: "10",
    ownerId: "101",
    characterId: 1,
    marriageId: marriage.id,
    now: () => 100,
    channel: {
      async send() {
        throw new Error("offline");
      },
    },
  };
  const stale = await startForcedEscape({
    ...request,
    marriageId: marriage.id + 1,
  });
  assert.equal(stale.status, "unknown");
  await assert.rejects(startForcedEscape(request), /offline/);
  assert.equal(isCharacterBusy(db, "1", 1, 100), false);
  await assert.rejects(startForcedEscape(request), /offline/);
  assert.equal(isCharacterBusy(db, "1", 1, 100), false);
});

test("ended gift controls cannot resurrect an offer or move ownership", async (t) => {
  const db = fixture(t);
  marryCharacter(db, "1", 1, "101");
  const collectors = [];
  const channel = {
    async send() {
      return {
        async edit() {},
        createMessageComponentCollector() {
          const handlers = {};
          collectors.push(handlers);
          return {
            on(name, callback) {
              handlers[name] = callback;
            },
          };
        },
      };
    },
  };
  const message = {
    guildId: "1",
    channelId: "10",
    author: { id: "101" },
    channel,
    guild: { members: { cache: new Map([["102", {}]]) } },
    reply: (payload) => channel.send(payload),
  };
  const ctx = { yoshiko: { catalogDb: db }, message, args: ["give", "102"] };
  await startGift(ctx);
  await onTradeAnswer(db, { ...message, content: "One" });
  assert.equal(isCharacterBusy(db, "1", 1), true);
  const confirmation = collectors.at(-1);
  await cancelTransfer(ctx);
  assert.equal(isCharacterBusy(db, "1", 1), false);
  let rejected = false;
  await confirmation.collect({
    user: { id: "102" },
    guildId: "1",
    customId: "xfer:confirm",
    async reply() {
      rejected = true;
    },
    async deferUpdate() {},
  });
  assert.equal(rejected, true);
  assert.equal(getMarriage(db, "1", 1).ownerId, "101");
});

test("summons leave held prizes alone and Blood Pact rejects a busy sacrifice", (t) => {
  const db = fixture(t);
  db.exec(`INSERT INTO franchises (id, display_name, created_at) VALUES (1, 'Show', 'fixture');
    INSERT INTO anime (id, title_romaji, fetched_at) VALUES (10, 'Show', 'fixture');
    INSERT INTO franchise_anime (franchise_id, anime_id) VALUES (1, 10);
    INSERT INTO character_anime (character_id, anime_id) VALUES (1, 10), (2, 10);`);
  const roll = reserveRoll(db, {
    guildId: "1",
    channelId: "10",
    commandMessageId: "100",
    userId: "101",
    pool: "w",
    now: 100,
    random: () => 0,
  });
  assert.equal(roll.character.id, 1);
  const wish = wishUponAStar.execute({
    db,
    guildId: "1",
    userId: "101",
    args: ["Show"],
    now: 100,
    random: () => 0,
  });
  assert.equal(wish.success, true);
  assert.equal(wish.character.id, 2);
  failRoll(db, roll.rollId);
  marryCharacter(db, "1", 1, "101");
  stake(db);
  const pact = bloodPact.execute({
    db,
    guildId: "1",
    userId: "101",
    args: ["One", "Two", "Missing"],
    now: 100,
  });
  assert.equal(pact.success, false);
  assert.equal(getMarriage(db, "1", 1).ownerId, "101");
});

test("Blood Pact skips a held best-ranked replacement rather than taking a roll prize", (t) => {
  const db = fixture(t);
  db.exec(`INSERT INTO characters (id, rank, favourites, name_full) VALUES
    (3, 3, 80, 'Three'), (4, 4, 70, 'Four'), (5, 5, 60, 'Five');
    INSERT INTO franchises (id, display_name, created_at) VALUES (1, 'Show', 'fixture');
    INSERT INTO anime (id, fetched_at) VALUES (10, 'fixture');
    INSERT INTO franchise_anime (franchise_id, anime_id) VALUES (1, 10);
    INSERT INTO character_anime (character_id, anime_id) VALUES (1, 10), (2, 10), (3, 10), (4, 10), (5, 10);`);
  for (const id of [3, 4, 5]) marryCharacter(db, "1", id, "101");
  reserveRoll(db, {
    guildId: "1",
    channelId: "10",
    commandMessageId: "100",
    userId: "101",
    pool: "w",
    now: 100,
    random: () => 0,
  });
  const result = bloodPact.execute({
    db,
    guildId: "1",
    userId: "101",
    args: ["Three", "Four", "Five"],
    now: 100,
  });
  assert.equal(result.success, true);
  assert.equal(result.character.id, 2);
  assert.equal(getMarriage(db, "1", 1), null);
  assert.equal(getMarriage(db, "1", 2).ownerId, "101");
});

test("claims cannot move a stake reserved after card publication", (t) => {
  const db = fixture(t);
  const roll = reserveRoll(db, {
    guildId: "1",
    channelId: "10",
    commandMessageId: "100",
    userId: "101",
    pool: "w",
    now: 100,
    random: () => 0,
  });
  publishRoll(db, roll.rollId, "500", 100);
  stake(db);
  const result = claimRoll(db, {
    guildId: "1",
    channelId: "10",
    messageId: "500",
    userId: "101",
    now: 101,
  });
  assert.equal(result.status, "closed");
  assert.equal(getMarriage(db, "1", 1), null);
});

test("active mystery holds survive gaps between prize card states", (t) => {
  const db = fixture(t);
  const roll = reserveRoll(db, {
    guildId: "1",
    channelId: "10",
    commandMessageId: "100",
    userId: "101",
    pool: "w",
    now: 100,
    random: () => 0,
  });
  db.prepare(
    `INSERT INTO mystery_sessions (guild_id, origin_roll_id, event_id, character_id,
    rank_snapshot, roller_id, event_channel_id, state, state_json, started_at, deadline_at)
    VALUES ('1', ?, 'test', 1, 1, '101', '10', 'countdown', '{}', 100, 200)`,
  ).run(roll.rollId);
  db.prepare("UPDATE character_rolls SET state = 'closed' WHERE id = ?").run(
    roll.rollId,
  );
  assert.equal(isCharacterHeld(db, "1", 1, 150), true);
  assert.equal(isCharacterHeld(db, "2", 1, 150), false);
  db.prepare("UPDATE mystery_sessions SET state = 'completed'").run();
  assert.equal(isCharacterHeld(db, "1", 1, 150), false);
});

test("Crown ends permanently on ownership loss, including in-place gift updates", (t) => {
  const db = fixture(t);
  const marriage = marryCharacter(db, "1", 1, "101").marriage;
  db.prepare("INSERT INTO counterfeit_crowns VALUES (?, ?, ?, ?, ?)").run(
    "1",
    "101",
    1,
    marriage.id,
    "generation",
  );
  transferCharacter(db, {
    guildId: "1",
    characterId: 1,
    fromOwnerId: "101",
    toOwnerId: "102",
    now: 100,
  });
  transferCharacter(db, {
    guildId: "1",
    characterId: 1,
    fromOwnerId: "102",
    toOwnerId: "101",
    now: 101,
  });
  assert.equal(db.prepare("SELECT 1 FROM counterfeit_crowns").get(), undefined);
});
