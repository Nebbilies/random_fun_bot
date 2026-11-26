import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openFinalCatalog } from "../lib/catalogDb.js";
import { installEmptyFinalCatalog } from "../lib/catalogFinalSchema.js";
import {
  reserveRoll,
  getRollAffectionFeedback,
} from "../lib/characterRolls.js";
import {
  confirmSoulmate,
  getAffectionTotal,
} from "../lib/characterAffection.js";
import { deliverReservedRoll } from "../lib/rollDelivery.js";
import {
  startEscapeUpdates,
  startForcedEscape,
  onRollReaction,
  runRoll,
  recoverOpenEscapes,
} from "../lib/characterRollRuntime.js";
import { recoverSelectedAffectionRewards } from "../lib/affectionRewards.js";
import { resolveAffectionDecisionInTransaction } from "../lib/affectionPerks.js";
import { addItemToInventory } from "../lib/itemStorage.js";
import { activateItem } from "../lib/itemActivation.js";
import {
  reservePaidVaultSession,
  drawVaultSessionOutcome,
} from "../lib/vaultSessions.js";
import { revealVaultReward, decideVaultReward } from "../lib/vaultRewards.js";
import { recoverVaultRewards } from "../lib/vaultRuntime.js";

const own = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const now = Date.now();
function fixture(t, { total = 0, otherOwner = "202" } = {}) {
  const db = new DatabaseSync(":memory:");
  installEmptyFinalCatalog(db);
  t.after(() => db.close());
  for (const [id, rank, gender, owner] of [
    [own, 1, "Male", "101"],
    [other, 2, "Female", otherOwner],
  ]) {
    db.prepare(
      "INSERT INTO character_identities(id,creation_method) VALUES(?,'manual')",
    ).run(id);
    db.prepare(
      "INSERT INTO characters(id,rank,favourites,tie_order,likes_source,name_full,gender) VALUES(?,?,0,?,'generated',?,?)",
    ).run(id, rank, rank, `Character ${rank}`, gender);
    if (owner)
      db.prepare(
        "INSERT INTO marriages(guild_id,character_id,owner_id,married_at) VALUES(?,?,?,?)",
      ).run("1", id, owner, new Date(now).toISOString());
  }
  confirmSoulmate(db, { guildId: "1", userId: "101", characterId: own, now });
  if (total)
    db.prepare("INSERT INTO character_affection VALUES('1','101',?,?,?)").run(
      own,
      total,
      now,
    );
  return db;
}
const json = (value) => JSON.stringify(value);
function transport() {
  const messages = new Map(),
    sent = [];
  const channel = {
    id: "10",
    guildId: "1",
    messages: { fetch: async (id) => messages.get(id) },
    send: async (payload) => {
      const message = {
        id: String(500 + messages.size),
        guildId: "1",
        channelId: "10",
        channel,
        components: payload.components,
        payload,
        react: async () => {},
        edit: async (change) => {
          message.payload = { ...message.payload, ...change };
          if (change.components) message.components = change.components;
          return message;
        },
      };
      messages.set(message.id, message);
      sent.push(message);
      return message;
    },
  };
  const client = {
    channels: {
      fetch: async (id) => {
        assert.equal(id, "10");
        return channel;
      },
    },
  };
  return { channel, client, messages, sent };
}

for (const sharedGenres of [false, true]) {
  test(`unrelated rolls give no soulmate affection or feedback with ${sharedGenres ? "shared" : "missing"} genres`, async (t) => {
    const db = fixture(t),
      io = transport();
    if (sharedGenres) {
      db.exec(
        `INSERT INTO anime(id,genres,fetched_at) VALUES(1,'["Action"]','d')`,
      );
      for (const id of [own, other])
        db.prepare("INSERT INTO character_anime VALUES(?,1)").run(id);
    }
    const roll = reserveRoll(db, {
      guildId: "1",
      channelId: "10",
      userId: "101",
      commandMessageId: "100",
      pool: "w",
      now,
      random: () => 0.99,
    });
    await deliverReservedRoll(db, io.client, {
      rollId: roll.rollId,
      channel: io.channel,
      now: () => now + 1,
    });
    assert.equal(getAffectionTotal(db, "1", "101", own), 0);
    assert.deepEqual(getRollAffectionFeedback(db, roll.rollId), []);
    assert.doesNotMatch(
      json(io.messages.get("500").payload),
      /affection|Soulmate/,
    );
    await deliverReservedRoll(db, io.client, {
      rollId: roll.rollId,
      channel: io.channel,
      now: () => now + 2,
    });
    assert.equal(getAffectionTotal(db, "1", "101", own), 0);
  });
}

test("escape refresh retains the roller gain and adds the reclaim owner gain without duplicate notices", async (t) => {
  const db = fixture(t),
    io = transport();
  db.exec(
    "INSERT INTO franchises(id,display_name,created_at) VALUES(1,'Shared','d')",
  );
  for (const id of [own, other])
    db.prepare("INSERT INTO character_main_franchises VALUES(?,1)").run(id);
  const roll = reserveRoll(db, {
    guildId: "1",
    channelId: "10",
    userId: "101",
    commandMessageId: "100",
    pool: "w",
    now,
    random: () => 0.99,
  });
  await deliverReservedRoll(db, io.client, {
    rollId: roll.rollId,
    channel: io.channel,
    now: () => now + 1,
  });
  const message = io.messages.get("500");
  assert.match(json(message.payload), /\+12/);
  const updates = startEscapeUpdates({
    db,
    message,
    character: roll.character,
    image: null,
    remaining: roll.remaining,
    now: () => now + 2,
    setTimer: () => 0,
    clearTimer: () => {},
  });
  t.after(() => updates.stop());
  await updates.refresh();
  assert.match(json(message.payload), /Character 1/);
  assert.match(json(message.payload), /\+12/);
  await onRollReaction(
    { catalogDb: db, client: io.client },
    { emoji: { name: "❤️" }, message },
    { id: "202", bot: false },
  );
  const text = json(message.payload);
  assert.match(text, /Reclaimed/);
  assert.match(text, /\+20/);
  assert.match(text, /Character 1/);
  assert.match(text, /<@101>/);
  assert.match(text, /<@202>/);
  assert.equal(io.sent.length, 1);
  assert.equal(getAffectionTotal(db, "1", "202", other), 20);
  assert.equal(getAffectionTotal(db, "1", "101", own), 17);
  assert.match(text, /\+17/);
});

test("checkpoint-only reclaim is recorded and announced once", async (t) => {
  const db = fixture(t, { total: 140 }),
    io = transport();
  // Roll the soulmate from another player's request, yielding +20 to its owner on reclaim.
  const r = reserveRoll(db, {
    guildId: "1",
    channelId: "10",
    userId: "202",
    commandMessageId: "100",
    pool: "h",
    now,
    random: () => 0.99,
  });
  await deliverReservedRoll(db, io.client, {
    rollId: r.rollId,
    channel: io.channel,
    now: () => now + 1,
  });
  const message = io.messages.get("500");
  await onRollReaction(
    { catalogDb: db, client: io.client },
    { emoji: { name: "❤️" }, message },
    { id: "101", bot: false },
  );
  assert.match(json(io.sent), /Item Conservation · 8%/);
  assert.equal(
    getRollAffectionFeedback(db, r.rollId).find((a) => a.userId === "101")
      .checkpoints[0].threshold,
    150,
  );
  assert.equal(getAffectionTotal(db, "1", "101", own), 160);
  const count = io.sent.length;
  await onRollReaction(
    { catalogDb: db, client: io.client },
    { emoji: { name: "❤️" }, message },
    { id: "101", bot: false },
  );
  assert.equal(io.sent.length, count);
});

test("automatic Whistle reclaim reports affection and publishes its milestone reward immediately", async (t) => {
  const db = fixture(t, { total: 95 }),
    io = transport();
  addItemToInventory(db, "1", "101", "golden_whistle", 1, { now });
  const result = await startForcedEscape({
    db,
    channel: io.channel,
    guildId: "1",
    channelId: "10",
    commandMessageId: "siren:test",
    ownerId: "101",
    characterId: own,
    now: () => now + 1,
    setTimer: () => 0,
    clearTimer: () => {},
  });
  assert.equal(result.status, "sealed");
  assert.equal(getAffectionTotal(db, "1", "101", own), 115);
  assert.match(json(io.sent), /Golden Whistle/);
  assert.match(json(io.sent), /\+20/);
  assert.match(json(io.sent), /Affection reward/);
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) n FROM vault_rewards WHERE delivered_at IS NOT NULL",
      )
      .get().n,
    1,
  );
});

test("saved marriage claim has a positive notice and keeps the claim available", async (t) => {
  const db = fixture(t, { total: 2100, otherOwner: null }),
    io = transport();
  const r = reserveRoll(db, {
    guildId: "1",
    channelId: "10",
    userId: "101",
    commandMessageId: "100",
    pool: "w",
    now,
    random: () => 0.99,
  });
  await deliverReservedRoll(db, io.client, {
    rollId: r.rollId,
    channel: io.channel,
    now: () => now + 1,
  });
  db.exec("BEGIN");
  resolveAffectionDecisionInTransaction(db, {
    sourceKey: "marriage:1:100",
    guildId: "1",
    userId: "101",
    effect: "claim_conservation",
    chance: 0.2,
    now: now + 2,
    random: () => 0,
  });
  db.exec("COMMIT");
  await onRollReaction(
    { catalogDb: db, client: io.client },
    { emoji: { name: "❤️" }, message: io.messages.get("500") },
    { id: "101", bot: false },
  );
  assert.match(json(io.sent), /Claim Conservation · no claim spent/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM claim_events").get().n, 0);
});

test("checkpoint feedback retains the triggering soulmate identity after selection changes", async (t) => {
  const db = fixture(t, { total: 140, otherOwner: "101" }),
    io = transport();
  const r = reserveRoll(db, {
    guildId: "1",
    channelId: "10",
    userId: "101",
    commandMessageId: "100",
    pool: "h",
    now,
    random: () => 0.99,
  });
  await deliverReservedRoll(db, io.client, {
    rollId: r.rollId,
    channel: io.channel,
    now: () => now + 1,
  });
  const before = getRollAffectionFeedback(db, r.rollId);
  assert.equal(before[0].checkpoints[0].threshold, 150);
  confirmSoulmate(db, {
    guildId: "1",
    userId: "101",
    characterId: other,
    now: now + 43200001,
  });
  assert.deepEqual(getRollAffectionFeedback(db, r.rollId), before);
});

test("reclaim milestone items publish during the reaction with an affection source label", async (t) => {
  const db = fixture(t, { total: 95 }),
    io = transport();
  const r = reserveRoll(db, {
    guildId: "1",
    channelId: "10",
    userId: "202",
    commandMessageId: "100",
    pool: "h",
    now,
    random: () => 0.99,
  });
  await deliverReservedRoll(db, io.client, {
    rollId: r.rollId,
    channel: io.channel,
    now: () => now + 1,
  });
  await onRollReaction(
    { catalogDb: db, client: io.client },
    { emoji: { name: "❤️" }, message: io.messages.get("500") },
    { id: "101", bot: false },
  );
  assert.equal(db.prepare("SELECT COUNT(*) n FROM user_inventory").get().n, 1);
  assert.match(json(io.sent), /Affection reward/);
  assert.match(json(io.sent), /1 item reward/);
});

test("manual reclaim immediately delivers milestone items to both owner and roller", async (t) => {
  const db = fixture(t, { total: 95 }),
    io = transport();
  db.prepare("INSERT INTO character_affection VALUES('1','202',?,95,?)").run(
    other,
    now,
  );
  const r = reserveRoll(db, {
    guildId: "1",
    channelId: "10",
    userId: "101",
    commandMessageId: "100",
    pool: "w",
    now,
    random: () => 0.99,
  });
  await deliverReservedRoll(db, io.client, {
    rollId: r.rollId,
    channel: io.channel,
    now: () => now + 1,
  });
  await onRollReaction(
    { catalogDb: db, client: io.client },
    { emoji: { name: "❤️" }, message: io.messages.get("500") },
    { id: "202", bot: false },
  );
  assert.deepEqual(
    db
      .prepare("SELECT user_id FROM user_inventory ORDER BY user_id")
      .all()
      .map((r) => r.user_id),
    ["101", "202"],
  );
  assert.equal(getAffectionTotal(db, "1", "101", own), 100);
  const feedback = json(io.sent);
  assert.match(feedback, /<@101>/);
  assert.match(feedback, /<@202>/);
  assert.match(feedback, /\+5/);
  assert.match(feedback, /\+20/);
});

test("live Golden Whistle awards the roller, delivers both milestone items, and spends once", async (t) => {
  const db = fixture(t, { total: 95 }),
    io = transport();
  db.prepare("INSERT INTO character_affection VALUES('1','202',?,95,?)").run(
    other,
    now,
  );
  addItemToInventory(db, "1", "202", "golden_whistle", 1, { now });
  const ctx = {
    yoshiko: {
      catalogDb: db,
      client: io.client,
      mysteryEnabled: false,
      vaultEnabled: false,
      imagePicker: { pick: async () => null },
    },
    message: {
      id: "100",
      guildId: "1",
      channelId: "10",
      author: { id: "101" },
      channel: io.channel,
      reply: (p) => io.channel.send(p),
    },
  };
  await runRoll(ctx, "w", () => 0.99, {
    now: () => now + 1,
    setTimer: () => 0,
    clearTimer: () => {},
  });
  assert.equal(getAffectionTotal(db, "1", "101", own), 100);
  assert.equal(getAffectionTotal(db, "1", "202", other), 115);
  assert.deepEqual(
    db
      .prepare(
        `SELECT i.user_id FROM user_inventory i JOIN affection_entitlements e
    ON e.guild_id=i.guild_id AND e.user_id=i.user_id AND e.item_id=i.item_id
    WHERE e.milestone_key='normal_100' AND e.tier='common' ORDER BY i.user_id`,
      )
      .all()
      .map((r) => r.user_id),
    ["101", "202"],
  );
  const text = json(io.sent);
  assert.match(text, /Golden Whistle/);
  assert.match(text, /<@101>/);
  assert.match(text, /<@202>/);
  const sent = io.sent.length;
  await onRollReaction(
    { catalogDb: db, client: io.client },
    { emoji: { name: "❤️" }, message: io.messages.get("500") },
    { id: "202", bot: false },
  );
  assert.equal(io.sent.length, sent);
  assert.equal(
    db.prepare("SELECT count(*) n FROM affection_awards WHERE base=5").get().n,
    1,
  );
});

test("Siren Whistle reclaim retains owner rewards and never grants instigator soulmate affection", async (t) => {
  const db = fixture(t, { total: 20 }),
    io = transport();
  addItemToInventory(db, "1", "202", "golden_whistle", 1, { now });
  const result = await startForcedEscape({
    db,
    channel: io.channel,
    guildId: "1",
    channelId: "10",
    commandMessageId: "siren:101:test",
    ownerId: "202",
    characterId: other,
    now: () => now + 1,
    setTimer: () => 0,
    clearTimer: () => {},
  });
  assert.equal(result.status, "sealed");
  assert.equal(getAffectionTotal(db, "1", "101", own), 20);
  assert.equal(getAffectionTotal(db, "1", "202", other), 20);
  assert.equal(
    db
      .prepare("SELECT count(*) n FROM affection_awards WHERE base IN (5,8)")
      .get().n,
    0,
  );
});

test("failed roller award rolls back Whistle reclaim, both awards, and the item charge", async (t) => {
  const db = fixture(t, { total: 200 }),
    io = transport();
  addItemToInventory(db, "1", "202", "golden_whistle", 1, { now });
  t.mock.method(Math, "random", () => NaN);
  t.mock.method(console, "error", () => {});
  const ctx = {
    yoshiko: {
      catalogDb: db,
      client: io.client,
      mysteryEnabled: false,
      vaultEnabled: false,
      imagePicker: { pick: async () => null },
    },
    message: {
      id: "100",
      guildId: "1",
      channelId: "10",
      author: { id: "101" },
      channel: io.channel,
      reply: (p) => io.channel.send(p),
    },
  };
  await runRoll(ctx, "w", () => 0.99, {
    now: () => now + 1,
    setTimer: () => 0,
    clearTimer: () => {},
  });
  assert.equal(getAffectionTotal(db, "1", "101", own), 200);
  assert.equal(getAffectionTotal(db, "1", "202", other), 0);
  assert.equal(
    db
      .prepare(
        "SELECT charges FROM user_inventory WHERE user_id='202' AND item_id='golden_whistle'",
      )
      .get().charges,
    1,
  );
  assert.equal(
    db
      .prepare(
        "SELECT state FROM character_rolls WHERE command_message_id='100'",
      )
      .get().state,
    "open",
  );
  assert.equal(
    db.prepare("SELECT count(*) n FROM affection_entitlements").get().n,
    0,
  );
});

test("a restored open escape awards both users once and reward recovery never repeats it", async (t) => {
  const db = fixture(t, { total: 95 }),
    io = transport();
  db.prepare("INSERT INTO character_affection VALUES('1','202',?,95,?)").run(
    other,
    now,
  );
  const r = reserveRoll(db, {
    guildId: "1",
    channelId: "10",
    userId: "101",
    commandMessageId: "100",
    pool: "w",
    now,
    random: () => 0.99,
  });
  await deliverReservedRoll(db, io.client, {
    rollId: r.rollId,
    channel: io.channel,
    now: () => now + 1,
  });
  const dir = mkdtempSync(join(tmpdir(), "reclaim-restart-")),
    path = join(dir, "copy.sqlite");
  db.prepare("VACUUM INTO ?").run(path);
  const reopened = openFinalCatalog(path);
  try {
    await recoverOpenEscapes(reopened, io.client, {
      now: () => now + 2,
      setTimer: () => 0,
      clearTimer: () => {},
    });
    const reaction = { emoji: { name: "❤️" }, message: io.messages.get("500") };
    await onRollReaction({ catalogDb: reopened, client: io.client }, reaction, {
      id: "202",
      bot: false,
    });
    assert.equal(getAffectionTotal(reopened, "1", "101", own), 100);
    assert.equal(getAffectionTotal(reopened, "1", "202", other), 115);
    const count = io.sent.length;
    recoverSelectedAffectionRewards(reopened);
    await recoverVaultRewards(reopened, io.client);
    await onRollReaction({ catalogDb: reopened, client: io.client }, reaction, {
      id: "202",
      bot: false,
    });
    assert.equal(io.sent.length, count);
    assert.equal(
      reopened.prepare("SELECT count(*) n FROM user_inventory").get().n,
      2,
    );
  } finally {
    reopened.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("failed reclaim reward announcements recover both recipients without repeating affection or items", async (t) => {
  const db = fixture(t, { total: 95 }),
    io = transport();
  db.prepare("INSERT INTO character_affection VALUES('1','202',?,95,?)").run(
    other,
    now,
  );
  const r = reserveRoll(db, {
    guildId: "1",
    channelId: "10",
    userId: "101",
    commandMessageId: "100",
    pool: "w",
    now,
    random: () => 0.99,
  });
  await deliverReservedRoll(db, io.client, {
    rollId: r.rollId,
    channel: io.channel,
    now: () => now + 1,
  });
  const send = io.channel.send;
  io.channel.send = async () => {
    throw new Error("Discord unavailable");
  };
  t.mock.method(console, "error", () => {});
  await onRollReaction(
    { catalogDb: db, client: io.client },
    { emoji: { name: "❤️" }, message: io.messages.get("500") },
    { id: "202", bot: false },
  );
  io.channel.send = send;
  recoverSelectedAffectionRewards(db);
  await recoverVaultRewards(db, io.client);
  assert.equal(getAffectionTotal(db, "1", "101", own), 100);
  assert.equal(getAffectionTotal(db, "1", "202", other), 115);
  assert.deepEqual(
    db
      .prepare("SELECT user_id FROM user_inventory ORDER BY user_id")
      .all()
      .map((r) => r.user_id),
    ["101", "202"],
  );
  assert.equal(
    db
      .prepare(
        "SELECT count(*) n FROM vault_rewards WHERE delivered_at IS NOT NULL AND message_id IS NOT NULL",
      )
      .get().n,
    2,
  );
});

test("Windfall and Bond feedback use the saved decisions without spending or earning again", async (t) => {
  const db = fixture(t, { total: 200 }),
    io = transport();
  const r = reserveRoll(db, {
    guildId: "1",
    channelId: "10",
    userId: "101",
    commandMessageId: "100",
    pool: "h",
    now,
    random: () => 0,
  });
  await deliverReservedRoll(db, io.client, {
    rollId: r.rollId,
    channel: io.channel,
    now: () => now + 1,
  });
  assert.match(
    json(io.messages.get("500").payload),
    /Windfall · no roll spent/,
  );
  assert.match(json(io.messages.get("500").payload), /Unbroken Bond/);
  assert.equal(db.prepare("SELECT used FROM roll_allowances").get().used, 0);
  const total = getAffectionTotal(db, "1", "101", own),
    count = io.sent.length;
  await deliverReservedRoll(db, io.client, {
    rollId: r.rollId,
    channel: io.channel,
    now: () => now + 2,
  });
  assert.equal(getAffectionTotal(db, "1", "101", own), total);
  assert.equal(io.sent.length, count);
});

test("conserved manual item use tells both command and custom inventory notification callers", async (t) => {
  const db = fixture(t, { total: 2100 }),
    io = transport();
  const source = addItemToInventory(db, "1", "101", "love_letter", 2, {
    now,
  }).item;
  let notice;
  const result = await activateItem({
    db,
    inventoryId: source.id,
    message: {
      guildId: "1",
      channelId: "10",
      id: "101",
      author: { id: "101" },
    },
    options: { now, random: () => 0 },
    notify: async (value) => {
      notice = value.message;
    },
  });
  assert.equal(result.conserved, true);
  assert.match(notice, /Item Conservation · no item charge spent/);
  assert.equal(
    db.prepare("SELECT charges FROM user_inventory WHERE id=?").get(source.id)
      .charges,
    2,
  );
});

test("conserved lost gamble never claims that the saved item was consumed", async (t) => {
  const db = fixture(t, { total: 2100 }),
    io = transport();
  const source = addItemToInventory(db, "1", "101", "double_or_nothing", 1, {
    now,
  }).item;
  const session = reservePaidVaultSession(db, {
    guildId: "1",
    userId: "101",
    channelId: "10",
    now,
  });
  const scope = {
    vaultId: session.vaultId,
    guildId: "1",
    userId: "101",
    channelId: "10",
    messageId: "500",
  };
  revealVaultReward(db, {
    ...scope,
    outcome: drawVaultSessionOutcome(session, () => 0),
    now: now + 1,
  });
  let draws = 0;
  decideVaultReward(db, {
    ...scope,
    action: "gamble",
    now: now + 2,
    random: () => (++draws === 1 ? 0 : 0.99),
  });
  await recoverVaultRewards(db, io.client, { now: () => now + 3 });
  assert.match(json(io.sent), /gambled and lost the reward/);
  assert.match(json(io.sent), /Item Conservation/);
  assert.doesNotMatch(
    json(io.sent),
    /charge was spent|Double or Nothing and the original reward are gone/,
  );
  assert.equal(
    db.prepare("SELECT charges FROM user_inventory WHERE id=?").get(source.id)
      .charges,
    1,
  );
});

test("Favor upgrades and Echo copies are identified on their distinct reward cards", async (t) => {
  const db = fixture(t, { total: 2100 }),
    io = transport();
  const session = reservePaidVaultSession(db, {
    guildId: "1",
    userId: "101",
    channelId: "10",
    now,
  });
  revealVaultReward(db, {
    vaultId: session.vaultId,
    guildId: "1",
    userId: "101",
    channelId: "10",
    outcome: drawVaultSessionOutcome(session, () => 0),
    now: now + 1,
    random: () => 0,
  });
  await recoverVaultRewards(db, io.client, { now: () => now + 2 });
  assert.equal(io.sent.length, 2);
  assert.match(json(io.sent), /Fortune's Favor · common → rare/);
  assert.match(json(io.sent), /Echo bonus/);
});
