import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCatalog } from "../lib/catalogDb.js";
import {
  addItemToInventory,
  getInventory,
  addCharacterLock,
} from "../lib/itemStorage.js";
import {
  getItemAction,
  setCounterfeitCrown,
} from "../lib/itemActionStorage.js";
import {
  createItemAction,
  activateItemAction,
  cancelItemAction,
  confirmHostageDelivery,
  resolveHostage,
  recoverItemActions,
} from "../lib/itemActions.js";
import { marryCharacter, getMarriage } from "../lib/characterMarriage.js";
import { startGift, startTrade, onTradeAnswer } from "../lib/tradeRuntime.js";
import { claimRoll } from "../lib/characterRolls.js";
import { isCharacterPendingTransfer } from "../lib/characterAvailability.js";

function setup(t, path = ":memory:") {
  const db = openCatalog(path);
  t.after(() => db.close());
  return db;
}
function own(db, id, ownerId, guildId = "1") {
  db.prepare(
    "INSERT OR IGNORE INTO characters(id,rank,favourites,name_full) VALUES(?,?,1,?)",
  ).run(id, id, `C${id}`);
  const m = marryCharacter(db, guildId, id, ownerId).marriage;
  return { characterId: id, marriageId: m.id, ownerId };
}
function action(
  db,
  kind = "kaimetsu",
  selections = {},
  actorId = "101",
  now = 1000,
) {
  const item = addItemToInventory(db, "1", actorId, kind, 1).item;
  return createItemAction(db, {
    guildId: "1",
    actorId,
    channelId: "10",
    inventoryId: item.id,
    selections,
    now,
  });
}
function activate(db, a, extra = {}) {
  return activateItemAction(db, {
    actionId: a.id,
    guildId: "1",
    actorId: a.actor_id,
    now: 1001,
    random: () => 0,
    ...extra,
  });
}
function escape(db, row, message = "999") {
  db.prepare(
    `INSERT INTO character_rolls(guild_id,channel_id,command_message_id,message_id,character_id,character_name,state,
    escape_marriage_id,escape_owner_id,expires_at,protected_until) VALUES('1','10',?,?,?,'C','open',?,?,999999,0)`,
  ).run(
    `escape:${message}`,
    message,
    row.characterId,
    row.marriageId,
    row.ownerId,
  );
}

test("Kaimetsu uses current stored guild pools, floor half, soulbind only, and uniform no-replacement selection", (t) => {
  const db = setup(t);
  const a = action(db);
  for (let id = 1; id <= 10; id++) own(db, id, "101");
  addCharacterLock(db, "1", 1, "soulbound", null);
  addCharacterLock(db, "1", 2, "soulbound", null);
  addCharacterLock(db, "1", 3, "temporary", 999999);
  setCounterfeitCrown(db, "1", "101", {
    characterId: 3,
    marriageId: getMarriage(db, "1", 3).id,
  });
  const shield = addItemToInventory(db, "1", "101", "mirror_shield").item;
  for (let id = 11; id <= 13; id++) own(db, id, "909");
  own(db, 14, "808");
  for (let id = 15; id <= 16; id++) own(db, id, "707", "2");
  const result = activate(db, a);
  assert.equal(result.totalDivorced, 5);
  assert.equal(result.affectedOwners, 2);
  for (const id of [3, 4, 5, 6, 11])
    assert.equal(getMarriage(db, "1", id), null);
  for (const id of [1, 2, 7, 8, 9, 10, 12, 13, 14])
    assert.ok(getMarriage(db, "1", id));
  assert.ok(getMarriage(db, "2", 15));
  assert.deepEqual(getInventory(db, "1", "101"), [shield]);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM counterfeit_crowns").get().n,
    0,
  );
  assert.deepEqual(
    activate(db, a, {
      random: () => {
        throw Error("replay rerolled");
      },
    }),
    result,
  );
  assert.equal(getItemAction(db, a.id).delivery_pending, 1);
});

test("Kaimetsu protects only soulbinds active at its resolution time", (t) => {
  const db = setup(t);
  const a = action(db, "kaimetsu", {}, "101", 1_000);
  for (let id = 1; id <= 4; id++) own(db, id, "101");
  addCharacterLock(db, "1", 1, "soulbind", 2_000);
  addCharacterLock(db, "1", 2, "soulbind", 1_001);
  const result = activate(db, a, { now: 1_001, random: () => 0 });
  assert.equal(result.totalDivorced, 1);
  assert.ok(getMarriage(db, "1", 1), "active Aegis remains immune");
  assert.equal(
    getMarriage(db, "1", 2),
    null,
    "a soulbind expires at its deadline",
  );
});

test("cancellation, expiry, unauthorized confirmation and zero loss never spend", (t) => {
  const db = setup(t);
  own(db, 1, "101");
  const a = action(db);
  assert.equal(activate(db, a, { actorId: "202" }).status, "invalid");
  assert.equal(cancelItemAction(db, a.id, "1", "101"), true);
  assert.equal(activate(db, a).status, "canceled");
  const b = action(db);
  assert.equal(activate(db, b, { now: b.expires_at }).status, "expired");
  const c = action(db);
  const result = activate(db, c);
  assert.equal(result.noCost, true);
  own(db, 2, "101");
  assert.deepEqual(activate(db, c), result);
  assert.equal(getInventory(db, "1", "101").length, 3);
});

test("selected escapes and Hostage challenges close atomically; consumed Notes stay spent; stale controls cannot affect remarriage", (t) => {
  const db = setup(t);
  const first = own(db, 1, "101");
  own(db, 2, "101");
  const target = own(db, 3, "202");
  own(db, 4, "202");
  const hostage = action(db, "hostage_note", { own: first, targets: [target] });
  assert.equal(activate(db, hostage).status, "awaiting_delivery");
  confirmHostageDelivery(db, hostage.id, "888", 1001);
  escape(db, first);
  const unrelated = own(db, 5, "303");
  escape(db, unrelated, "998");
  const a = action(db);
  activate(db, a);
  assert.equal(getItemAction(db, hostage.id).state, "canceled");
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM item_character_reservations").get().n,
    0,
  );
  assert.equal(
    db.prepare("SELECT state FROM character_rolls WHERE message_id='999'").get()
      .state,
    "closed",
  );
  assert.equal(
    db.prepare("SELECT state FROM character_rolls WHERE message_id='998'").get()
      .state,
    "open",
  );
  assert.equal(getInventory(db, "1", "101").length, 0);
  const replacement = marryCharacter(db, "1", 1, "101").marriage;
  assert.notEqual(replacement.id, first.marriageId);
  assert.equal(
    resolveHostage(db, {
      actionId: hostage.id,
      guildId: "1",
      userId: "202",
      choice: "exchange",
    }).status,
    "canceled",
  );
  assert.equal(
    claimRoll(db, {
      guildId: "1",
      channelId: "10",
      messageId: "999",
      userId: "404",
      now: 1002,
    }).status,
    "closed",
  );
  recoverItemActions(db, 9999999);
  assert.equal(getMarriage(db, "1", 1).id, replacement.id);
});

async function transfer(db, kind, owner, recipient, id, channelId) {
  const channel = {
    id: channelId,
    send: async () => ({ edit: async () => {} }),
  };
  const message = {
    guildId: "1",
    channelId,
    channel,
    author: { id: owner },
    guild: { members: { cache: new Map([[recipient, {}]]) } },
    reply: channel.send,
  };
  await (kind === "gift" ? startGift : startTrade)({
    yoshiko: { catalogDb: db },
    message,
    args: [kind, recipient],
  });
  await onTradeAnswer(db, { ...message, content: `C${id}` });
  return { ...message, author: { id: recipient }, content: "yes" };
}

test("rollback preserves live trades/gifts, escapes, Hostages and inventory; commit invalidates only selected interactions", async (t) => {
  const db = setup(t);
  const first = own(db, 1, "101");
  own(db, 2, "101");
  own(db, 3, "202");
  own(db, 4, "202");
  own(db, 5, "303");
  own(db, 6, "505"); // A trade partner must have a harem before starting.
  const gift = await transfer(db, "gift", "101", "404", 1, "10");
  const trade = await transfer(db, "trade", "202", "505", 3, "20");
  const unrelated = await transfer(db, "gift", "303", "606", 5, "30");
  escape(db, first);
  const a = action(db);
  db.exec(
    "CREATE TRIGGER reject_loss BEFORE DELETE ON marriages WHEN OLD.character_id=3 BEGIN SELECT RAISE(ABORT,'failed loss'); END",
  );
  assert.throws(() => activate(db, a), /failed loss/);
  assert.equal(getItemAction(db, a.id).state, "confirming");
  assert.equal(getInventory(db, "1", "101").length, 1);
  assert.ok(getMarriage(db, "1", 1));
  assert.equal(
    db.prepare("SELECT state FROM character_rolls").get().state,
    "open",
  );
  // The offer registration survives rollback as well as the session itself.
  assert.equal(isCharacterPendingTransfer(db, "1", 1), true);
  assert.equal(isCharacterPendingTransfer(db, "1", 3), true);
  db.exec("DROP TRIGGER reject_loss");
  activate(db, a);
  assert.equal(await onTradeAnswer(db, gift), false);
  assert.equal(await onTradeAnswer(db, trade), false);
  assert.equal(await onTradeAnswer(db, unrelated), true);
  assert.equal(getMarriage(db, "1", 5).ownerId, "606");
});

test("committed undelivered Kaimetsu replays after database reopen with no reroll or charge", () => {
  const dir = mkdtempSync(join(tmpdir(), "kaimetsu-"));
  let db;
  try {
    const file = join(dir, "db.sqlite");
    db = openCatalog(file);
    own(db, 1, "101");
    own(db, 2, "101");
    const a = action(db);
    const result = activate(db, a);
    db.close();
    db = openCatalog(file);
    recoverItemActions(db, 1002);
    assert.deepEqual(
      activate(db, a, {
        random: () => {
          throw Error("reroll");
        },
      }),
      result,
    );
    assert.equal(getItemAction(db, a.id).delivery_pending, 1);
    assert.equal(getInventory(db, "1", "101").length, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM marriages").get().n, 1);
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
