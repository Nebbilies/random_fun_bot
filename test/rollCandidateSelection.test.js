import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { mkdtempSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import { createMessageHandler } from "../app/events/messageCreate.js";
import { getCatalogCache } from "../lib/catalogCache.js";
import { installEmptyFinalCatalog } from "../lib/catalogFinalSchema.js";
import { registerPendingTransfer } from "../lib/characterAvailability.js";
import { reserveRoll } from "../lib/characterRolls.js";
import {
  addActiveBuff,
  getActiveBuffs,
  getGuildBuffs,
} from "../lib/itemStorage.js";

const first = "00000000-0000-4000-8000-000000000001";
const second = "00000000-0000-4000-8000-000000000002";
const shared = "00000000-0000-4000-8000-000000000003";
const added = "00000000-0000-4000-8000-000000000004";
const guildId = "1";
const channelId = "10";
const userId = "101";

function addCharacter(db, id, rank, name, gender) {
  db.prepare(
    "INSERT INTO character_identities(id,name_full,creation_method) VALUES(?,?,'manual')",
  ).run(id, name);
  db.prepare(
    `INSERT INTO characters(id,rank,favourites,tie_order,likes_source,name_full,gender,image_url)
    VALUES(?,?,0,?,'generated',?,?,'https://example.test/portrait.png')`,
  ).run(id, rank, rank, name, gender);
}

function fixture(t, path = ":memory:") {
  const db = new DatabaseSync(path);
  t.after(() => db.close());
  db.exec("PRAGMA foreign_keys=ON");
  installEmptyFinalCatalog(db);
  addCharacter(db, first, 1, "First", " FEMALE ");
  addCharacter(db, second, 2, "Second", "Male");
  addCharacter(db, shared, 3, "Shared", null);
  const cache = getCatalogCache(db);
  cache.warmRollPools?.();
  const queries = [];
  const prepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    queries.push(sql.replace(/\s+/g, " ").trim());
    return prepare(sql);
  };
  return { db, cache, queries };
}

const poolScans = (queries) =>
  queries.filter(
    (sql) =>
      sql.startsWith("SELECT c.id FROM characters AS c WHERE NOT EXISTS") &&
      sql.endsWith("ORDER BY c.id"),
  );

function reserve({ db, cache }, extra = {}) {
  return reserveRoll(db, {
    guildId,
    channelId,
    userId,
    commandMessageId: "100",
    pool: "w",
    now: 1000,
    random: () => 0,
    getRollPool: cache.getRollPool,
    ...extra,
  });
}

test("normal !w and !h messages reserve and publish using indexed eligibility", async (t) => {
  const { db, cache, queries } = fixture(t);
  t.mock.method(Math, "random", () => 0.25);
  const sent = [];
  const cards = new Map();
  const channel = {
    id: channelId,
    guildId,
    send: async (payload) => {
      sent.push(payload);
      const card = { id: String(500 + sent.length), react: async () => {} };
      cards.set(card.id, card);
      return card;
    },
    messages: { fetch: async (id) => cards.get(id) },
  };
  const handle = createMessageHandler({
    yoshiko: {
      catalogDb: db,
      catalogCache: cache,
      client: {},
      config: { prefix: "!" },
      mysteryEnabled: false,
      imagePicker: { pick: async (_guild, _id, _tag, url) => ({ url }) },
    },
    isReady: () => true,
    handleLandmine: () => assert.fail("Expected a game command"),
  });
  for (const [cmd, id] of [
    ["w", "100"],
    ["h", "101"],
  ]) {
    await handle({
      id,
      content: "!" + cmd,
      guild: { id: guildId },
      guildId,
      channelId,
      channel,
      author: { id: userId },
      reply: async () => assert.fail("Expected durable roll delivery"),
    });
  }
  assert.deepEqual(
    db
      .prepare("SELECT character_id FROM character_rolls ORDER BY id")
      .all()
      .map((row) => row.character_id),
    [first, second],
  );
  assert.equal(sent.length, 2);
  assert.equal(
    poolScans(queries).length,
    0,
    "Both ordinary rolls should skip the full pool scan",
  );
  assert.equal(
    queries.filter(
      (sql) =>
        sql.startsWith("SELECT c.id FROM characters AS c WHERE NOT EXISTS") &&
        sql.endsWith("AND c.id = ?"),
    ).length,
    2,
  );
});

test("live transfer and a prior reservation reject a drawn ID before the retry or exact fallback", (t) => {
  const x = fixture(t);
  registerPendingTransfer(x.db, "trade", guildId, [first], 2000);
  const draws = [0, 0.75];
  const rolled = reserve(x, { random: () => draws.shift() ?? 0 });
  assert.equal(rolled.status, "reserved");
  assert.equal(rolled.character.id, shared);
  assert.equal(poolScans(x.queries).length, 0);

  let attempts = 0;
  assert.equal(
    reserve(x, {
      commandMessageId: "101",
      random: () => {
        attempts++;
        return 0;
      },
    }).status,
    "empty",
  );
  assert.equal(attempts, 8);
  assert.equal(poolScans(x.queries).length, 1);

  attempts = 0;
  const fallback = reserve(x, {
    commandMessageId: "102",
    now: 2000,
    random: () => {
      attempts++;
      return 0.75;
    },
  });
  assert.equal(fallback.character.id, first);
  assert.ok(attempts >= 9);
  assert.equal(poolScans(x.queries).length, 2);
});

test("point checks preserve the Soulbind owner exception and durable item reservations", (t) => {
  const x = fixture(t);
  x.db
    .prepare(
      "INSERT INTO marriages(guild_id,character_id,owner_id,married_at) VALUES(?,?,?,'now')",
    )
    .run(guildId, first, userId);
  x.db
    .prepare(
      "INSERT INTO character_protection_locks VALUES(?,?,'soulbind',NULL)",
    )
    .run(guildId, first);
  x.db
    .prepare(
      "INSERT INTO item_character_reservations VALUES(?,?,'hostage','102',1)",
    )
    .run(guildId, shared);
  assert.equal(reserve(x, { userId: "102" }).status, "empty");
  const result = reserve(x, { commandMessageId: "101" });
  assert.equal(result.character.id, first);
  assert.equal(result.ownAppearance, true);
  assert.equal(poolScans(x.queries).length, 1);
});

test("Passport uses effective franchise membership ahead of Clover and Piñata", (t) => {
  const x = fixture(t);
  x.db.exec(
    "INSERT INTO franchises(id,display_name,name_source,created_at) VALUES(1,'Saga','manual','now')",
  );
  x.db
    .prepare("INSERT INTO character_franchise_memberships VALUES(?,?)")
    .run(shared, 1);
  x.cache.warmRollPools();
  addActiveBuff(x.db, guildId, "", "pinata", '{"maxRank":1}', null, 3);
  addActiveBuff(
    x.db,
    guildId,
    userId,
    "four_leaf_clover",
    '{"maxRank":1}',
    null,
    3,
  );
  addActiveBuff(
    x.db,
    guildId,
    userId,
    "franchise_passport",
    '{"franchiseId":1}',
    null,
    3,
  );

  assert.equal(reserve(x).character.id, shared);
  assert.equal(poolScans(x.queries).length, 0);
  assert.deepEqual(
    getActiveBuffs(x.db, guildId, userId, 1000).map(
      (row) => row.remaining_rolls,
    ),
    [3, 2],
  );
  assert.equal(getGuildBuffs(x.db, guildId, 1000)[0].remaining_rolls, 3);
});

test("another connection publishes an addition and gender correction before the next reservation", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "roll-pool-"));
  const file = join(dir, "catalog.sqlite");
  const x = fixture(t, file);
  const writer = new DatabaseSync(file);
  t.after(() => {
    writer.close();
    rmSync(file, { force: true });
    rmdirSync(dir);
  });
  writer.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
  writer.prepare("UPDATE characters SET gender='Male' WHERE id=?").run(first);
  writer
    .prepare("UPDATE characters SET gender='Female' WHERE id=?")
    .run(second);
  addCharacter(writer, added, 4, "Added", "Female");
  writer.exec("UPDATE catalog_state SET revision=revision+1; COMMIT");

  assert.equal(reserve(x, { random: () => 0.99 }).character.id, added);
  assert.equal(poolScans(x.queries).length, 1);
  await tick();
  assert.equal(reserve(x, { commandMessageId: "101" }).character.id, second);
  assert.equal(
    poolScans(x.queries).length,
    1,
    "The refresh must include the gender correction",
  );
});

test("published rank and franchise changes replace constrained pools from the same revision", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "roll-pool-"));
  const file = join(dir, "catalog.sqlite");
  const x = fixture(t, file);
  const writer = new DatabaseSync(file);
  t.after(() => {
    writer.close();
    rmSync(file, { force: true });
    rmdirSync(dir);
  });
  writer.exec(
    "PRAGMA foreign_keys=ON; INSERT INTO franchises(id,display_name,name_source,created_at) VALUES(1,'Saga','manual','now')",
  );
  writer
    .prepare("INSERT INTO character_franchise_memberships VALUES(?,?)")
    .run(first, 1);
  x.cache.warmRollPools();
  writer.exec("BEGIN IMMEDIATE");
  writer.prepare("UPDATE characters SET rank=4 WHERE id=?").run(first);
  writer.prepare("UPDATE characters SET rank=1 WHERE id=?").run(shared);
  writer.prepare("UPDATE characters SET rank=3 WHERE id=?").run(first);
  writer
    .prepare(
      "UPDATE character_franchise_memberships SET character_id=? WHERE franchise_id=1",
    )
    .run(shared);
  writer.exec("UPDATE catalog_state SET revision=revision+1; COMMIT");
  addActiveBuff(
    x.db,
    guildId,
    userId,
    "four_leaf_clover",
    '{"maxRank":1}',
    null,
    3,
  );
  const clover = reserve(x);
  assert.equal(clover.character.id, shared);
  assert.equal(poolScans(x.queries).length, 1);
  x.db
    .prepare("UPDATE character_rolls SET state='failed' WHERE id=?")
    .run(clover.rollId);
  await tick();
  assert.equal(reserve(x, { commandMessageId: "101" }).character.id, shared);
  x.db.exec("UPDATE character_rolls SET state='failed'");
  addActiveBuff(
    x.db,
    guildId,
    userId,
    "franchise_passport",
    '{"franchiseId":1}',
    null,
    3,
  );
  assert.equal(reserve(x, { commandMessageId: "102" }).character.id, shared);
  assert.equal(poolScans(x.queries).length, 1);
});

test("failed refresh keeps exact selection available and retries after the backoff", async (t) => {
  const x = fixture(t);
  let clock = 1000;
  t.mock.method(Date, "now", () => clock);
  const log = t.mock.method(console, "error", () => {});
  x.db.exec("UPDATE catalog_state SET revision=revision+1");
  const prepare = x.db.prepare;
  let fail = true;
  x.db.prepare = (sql) => {
    if (fail && sql.startsWith("SELECT c.id, c.rank,"))
      throw new Error("Synthetic refresh failure");
    return prepare(sql);
  };

  assert.equal(reserve(x).character.id, first);
  await tick();
  assert.equal(log.mock.callCount(), 1);
  assert.equal(reserve(x, { commandMessageId: "101" }).character.id, shared);
  await tick();
  assert.equal(log.mock.callCount(), 1);
  assert.equal(poolScans(x.queries).length, 2);

  fail = false;
  clock += 15_000;
  assert.equal(reserve(x, { commandMessageId: "102" }).status, "empty");
  await tick();
  assert.equal(
    reserve(x, { commandMessageId: "103", pool: "h" }).character.id,
    second,
  );
  assert.equal(poolScans(x.queries).length, 3);
});

for (const [item, owner] of [
  ["four_leaf_clover", userId],
  ["pinata", ""],
]) {
  test(`${item} samples its rank prefix and preserves its charge rules on an empty pool`, (t) => {
    const x = fixture(t);
    addActiveBuff(x.db, guildId, owner, item, '{"maxRank":1}', null, 3);
    assert.equal(reserve(x, { random: () => 0.9 }).character.id, first);
    assert.equal(poolScans(x.queries).length, 0);

    assert.equal(reserve(x, { commandMessageId: "101" }).character.id, shared);
    assert.equal(poolScans(x.queries).length, 2);
    const buffs = owner
      ? getActiveBuffs(x.db, guildId, owner, 1000)
      : getGuildBuffs(x.db, guildId, 1000);
    assert.equal(buffs[0].remaining_rolls, owner ? 2 : 1);
  });
}
