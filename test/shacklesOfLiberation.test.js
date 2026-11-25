import assert from "node:assert/strict";
import { test } from "node:test";
import { openCatalog } from "../lib/catalogDb.js";
import { addItemToInventory, addCharacterLock } from "../lib/itemStorage.js";
import { getItemAction } from "../lib/itemActionStorage.js";
import {
  activateItemAction,
  cancelItemAction,
  createItemAction,
  getShacklesTargets,
  recoverItemActions,
  updateItemSelection,
} from "../lib/itemActions.js";
import {
  registerPendingTransfer,
  unregisterPendingTransfer,
} from "../lib/characterAvailability.js";
import {
  startItemAction,
  onItemActionInteraction,
  recoverItemActionRuntime,
} from "../lib/itemActionRuntime.js";
import { shacklesOfLiberation } from "../lib/items/shacklesOfLiberation.js";

function fixture(t) {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  const now = Date.now();
  function marry(id = 1, ownerId = "202", guildId = "1") {
    db.prepare(
      "INSERT OR IGNORE INTO characters(id,rank,favourites,name_full) VALUES(?,?,0,?)",
    ).run(id, id, `Same name ${id}`);
    const result = db
      .prepare(
        "INSERT INTO marriages(guild_id,character_id,owner_id,married_at) VALUES(?,?,?,?)",
      )
      .run(guildId, id, ownerId, new Date(now).toISOString());
    addCharacterLock(db, guildId, id, "soulbind", null);
    return {
      characterId: id,
      marriageId: Number(result.lastInsertRowid),
      ownerId,
    };
  }
  // The parent owns roster/expiry wiring. Seed via an existing Legendary then
  // change its ID so this focused suite works independently of that wiring.
  function source(charges = 1) {
    const item = addItemToInventory(
      db,
      "1",
      "101",
      "aegis_of_fidelity",
      charges,
    ).item;
    db.prepare("UPDATE user_inventory SET item_id=? WHERE id=?").run(
      shacklesOfLiberation.id,
      item.id,
    );
    return item.id;
  }
  function start(target, inventoryId = source()) {
    return createItemAction(db, {
      guildId: "1",
      actorId: "101",
      channelId: "10",
      inventoryId,
      selections: { unbindTarget: target },
      now,
    });
  }
  const activate = (action) =>
    activateItemAction(db, {
      actionId: action.id,
      guildId: "1",
      actorId: "101",
      now: now + 1,
    });
  const lock = () =>
    db
      .prepare(
        "SELECT * FROM character_protection_locks WHERE guild_id='1' AND character_id=1",
      )
      .get();
  return { db, now, marry, source, start, activate, lock };
}

for (const owner of ["101", "202"])
  test(`Shackles unbinds owner ${owner} without ownership loss, defense consumption or rebinding delay`, (t) => {
    const f = fixture(t);
    const target = f.marry(1, owner);
    const shield = addItemToInventory(
      f.db,
      "1",
      owner,
      "mirror_shield",
      3,
    ).item;
    f.db
      .prepare("INSERT INTO counterfeit_crowns VALUES(?,?,?,?,?)")
      .run("1", owner, 1, target.marriageId, "generation");
    const before = f.db.prepare("SELECT * FROM marriages").all();
    f.db.exec(`CREATE TABLE IF NOT EXISTS character_ownership_losses (
    guild_id TEXT, former_owner_id TEXT, character_id INTEGER, lost_at INTEGER);
    CREATE TRIGGER record_test_loss AFTER DELETE ON marriages BEGIN
      INSERT INTO character_ownership_losses VALUES(OLD.guild_id,OLD.owner_id,OLD.character_id,1); END;`);
    const losses = f.db
      .prepare("SELECT * FROM character_ownership_losses")
      .all();
    const inventoryId = f.source(2);
    const action = f.start(target, inventoryId);
    assert.equal(f.lock().lock_type, "soulbind"); // selection does not spend or unbind
    const result = f.activate(action);
    assert.equal(result.status, "resolved");
    assert.equal(f.lock(), undefined);
    assert.deepEqual(f.db.prepare("SELECT * FROM marriages").all(), before);
    assert.deepEqual(
      f.db.prepare("SELECT * FROM character_ownership_losses").all(),
      losses,
    );
    assert.equal(
      f.db
        .prepare("SELECT charges FROM user_inventory WHERE id=?")
        .get(shield.id).charges,
      3,
    );
    assert.equal(
      f.db.prepare("SELECT generation_id FROM counterfeit_crowns").get()
        .generation_id,
      "generation",
    );
    assert.equal(
      f.db
        .prepare("SELECT charges FROM user_inventory WHERE id=?")
        .get(inventoryId).charges,
      1,
    );
    assert.deepEqual(f.activate(action), result); // committed result replay
    assert.equal(
      f.db
        .prepare("SELECT charges FROM user_inventory WHERE id=?")
        .get(inventoryId).charges,
      1,
    );
    addCharacterLock(f.db, "1", 1, "soulbind", null);
    assert.equal(f.lock().lock_type, "soulbind");
    assert.deepEqual(f.activate(action), result); // replay cannot remove a new soulbind
    assert.equal(f.lock().lock_type, "soulbind");
  });

for (const change of [
  "unowned",
  "owner",
  "marriage",
  "no-lock",
  "temporary",
  "other-permanent",
  "expired-soulbind",
  "missing-item",
  "missing-selection",
]) {
  test(`Shackles revalidates ${change} without cost or deleting replacement protection`, (t) => {
    const f = fixture(t);
    const target = f.marry();
    const source = f.source();
    const action = f.start(
      change === "missing-selection" ? undefined : target,
      source,
    );
    if (change === "unowned") f.db.exec("DELETE FROM marriages");
    if (change === "owner") f.db.exec("UPDATE marriages SET owner_id='303'");
    if (change === "marriage") f.db.exec("UPDATE marriages SET id=id+100");
    if (change === "no-lock")
      f.db.exec("DELETE FROM character_protection_locks");
    if (change === "temporary")
      addCharacterLock(f.db, "1", 1, "theft", f.now + 10000);
    if (change === "other-permanent")
      addCharacterLock(f.db, "1", 1, "unrelated", null);
    if (change === "expired-soulbind")
      addCharacterLock(f.db, "1", 1, "soulbind", f.now - 1);
    if (change === "missing-item") {
      f.db
        .prepare("DELETE FROM item_use_reservations WHERE inventory_id=?")
        .run(source);
      f.db.prepare("DELETE FROM user_inventory WHERE id=?").run(source);
    }
    const before = f.lock();
    assert.equal(f.activate(action).status, "invalid");
    assert.deepEqual(f.lock(), before);
    assert.equal(getItemAction(f.db, action.id).state, "canceled");
    if (change !== "missing-item")
      assert.equal(
        f.db
          .prepare("SELECT charges FROM user_inventory WHERE id=?")
          .get(source).charges,
        1,
      );
    assert.equal(
      f.db.prepare("SELECT count(*) AS n FROM item_use_reservations").get().n,
      0,
    );
  });
}

test("Shackles can target and remove an active timed Aegis soulbind", (t) => {
  const f = fixture(t);
  const target = f.marry();
  addCharacterLock(f.db, "1", 1, "soulbind", f.now + 10_000);
  const source = f.source();
  const action = f.start(target, source);
  assert.equal(getShacklesTargets(f.db, action, f.now).length, 1);
  assert.equal(f.activate(action).status, "resolved");
  assert.equal(f.lock(), undefined);
});

for (const busy of ["escape", "pending-escape", "trade", "reservation"])
  test(`Shackles rejects busy ${busy} at confirmation without cost`, (t) => {
    const f = fixture(t);
    const target = f.marry();
    const source = f.source();
    const action = f.start(target, source);
    if (busy === "trade") {
      registerPendingTransfer(f.db, "trade", "1", [1]);
      t.after(() => unregisterPendingTransfer(f.db, "trade"));
    } else if (busy === "reservation") {
      f.db
        .prepare("INSERT INTO item_character_reservations VALUES(?,?,?,?,?)")
        .run("1", 1, "challenge", target.ownerId, target.marriageId);
    } else {
      f.db
        .prepare(
          `INSERT INTO character_rolls(guild_id,channel_id,command_message_id,character_id,character_name,state,expires_at,escape_marriage_id)
      VALUES('1','10','escape-command',1,'Target',?,?,?)`,
        )
        .run(
          busy === "escape" ? "open" : "pending",
          f.now + 10000,
          target.marriageId,
        );
    }
    assert.deepEqual(getShacklesTargets(f.db, action, f.now), []);
    assert.equal(f.activate(action).status, "invalid");
    assert.equal(f.lock().lock_type, "soulbind");
    assert.equal(
      f.db.prepare("SELECT charges FROM user_inventory WHERE id=?").get(source)
        .charges,
      1,
    );
  });

for (const ending of ["cancel", "expire"])
  test(`Shackles ${ending} releases source without consumption`, (t) => {
    const f = fixture(t);
    const target = f.marry();
    const source = f.source();
    const action = f.start(target, source);
    if (ending === "cancel")
      assert.equal(cancelItemAction(f.db, action.id, "1", "101"), true);
    else recoverItemActions(f.db, action.expires_at);
    assert.notEqual(f.activate(action).status, "resolved");
    assert.equal(f.lock().lock_type, "soulbind");
    assert.equal(
      f.db.prepare("SELECT charges FROM user_inventory WHERE id=?").get(source)
        .charges,
      1,
    );
  });

test("Shackles competing confirmations spend only once for one soulbind", (t) => {
  const f = fixture(t);
  const target = f.marry();
  const first = f.start(target);
  assert.equal(f.start(target, first.inventory_id).status, "invalid"); // durable source hold
  const secondSource = f.source();
  const second = f.start(target, secondSource);
  assert.equal(f.activate(first).status, "resolved");
  assert.equal(f.activate(second).status, "invalid");
  assert.equal(
    f.db
      .prepare("SELECT charges FROM user_inventory WHERE id=?")
      .get(secondSource).charges,
    1,
  );
});

test("Shackles reserved use survives inventory expiry but a new expired start is rejected", (t) => {
  const f = fixture(t);
  const target = f.marry();
  const source = f.source(2);
  f.db
    .prepare("UPDATE user_inventory SET expires_at=? WHERE id=?")
    .run(f.now + 1, source);
  const action = f.start(target, source);
  recoverItemActions(f.db, f.now + 2);
  assert.equal(
    activateItemAction(f.db, {
      actionId: action.id,
      guildId: "1",
      actorId: "101",
      now: f.now + 2,
    }).status,
    "resolved",
  );
  assert.equal(
    f.db.prepare("SELECT charges FROM user_inventory WHERE id=?").get(source)
      .charges,
    1,
  );
  assert.equal(
    createItemAction(f.db, {
      guildId: "1",
      actorId: "101",
      channelId: "10",
      inventoryId: source,
      now: f.now + 2,
    }).status,
    "invalid",
  );
});

test("Shackles rollback restores lock and charge; recovery can retry the same confirmation", (t) => {
  const f = fixture(t);
  const target = f.marry();
  const source = f.source();
  const action = f.start(target, source);
  f.db.exec(
    "CREATE TRIGGER fail_shackles BEFORE UPDATE OF result_json ON item_actions BEGIN SELECT RAISE(ABORT,'delivery persistence failed'); END",
  );
  assert.throws(() => f.activate(action), /delivery persistence failed/);
  assert.equal(f.lock().lock_type, "soulbind");
  assert.equal(
    f.db.prepare("SELECT charges FROM user_inventory WHERE id=?").get(source)
      .charges,
    1,
  );
  assert.equal(getItemAction(f.db, action.id).state, "confirming");
  f.db.exec("DROP TRIGGER fail_shackles");
  recoverItemActions(f.db, f.now + 1);
  assert.equal(f.activate(action).status, "resolved");
});

test("Shackles picker scopes owned soulbinds to the guild and commits only the exact selected marriage", (t) => {
  const f = fixture(t);
  const first = f.marry(1, "101");
  const second = f.marry(2, "202");
  f.db.exec(
    "UPDATE characters SET name_full='Identical name' WHERE id IN (1,2)",
  );
  f.marry(3, "303", "other-guild");
  f.marry(4, "404");
  f.db.exec("DELETE FROM marriages WHERE character_id=4");
  const action = f.start(undefined);
  assert.deepEqual(
    getShacklesTargets(f.db, action).map((row) => row.characterId),
    [1, 2],
  );
  assert.equal(
    updateItemSelection(f.db, action.id, "1", "101", { unbindTarget: second }),
    true,
  );
  assert.equal(f.activate(action).status, "resolved");
  assert.ok(
    f.db
      .prepare("SELECT 1 FROM character_protection_locks WHERE character_id=?")
      .get(first.characterId),
  );
  assert.equal(
    f.db
      .prepare("SELECT 1 FROM character_protection_locks WHERE character_id=2")
      .get(),
    undefined,
  );
});

function controls(message) {
  const found = [];
  function walk(c) {
    if (c.custom_id) found.push(c);
    for (const child of c.components ?? []) walk(child);
  }
  for (const c of message.payload.components) walk(c.toJSON());
  return found;
}

test("Shackles exact paged UI rejects forged/unauthorized selections and recovers failed publication without extra use", async (t) => {
  const f = fixture(t);
  for (let id = 1; id <= 26; id++) f.marry(id, id === 26 ? "101" : "202");
  let serial = 0;
  const messages = new Map();
  const channel = {
    id: "10",
    messages: { fetch: async (id) => messages.get(id) },
    send: async (payload) => {
      const message = {
        id: String(++serial),
        payload,
        edit: async (next) => {
          message.payload = next;
        },
      };
      messages.set(message.id, message);
      return message;
    },
  };
  const client = { channels: { fetch: async () => channel } };
  const message = {
    guildId: "1",
    channelId: "10",
    author: { id: "101" },
    channel,
    client,
    reply: channel.send,
  };
  const source = f.source(2);
  const action = await startItemAction({
    db: f.db,
    message,
    inventoryId: source,
  });
  const prompt = messages.get(action.message_id);
  async function click(verb, values = [], user = "101") {
    const interaction = {
      customId: `item:${action.id}:${verb}`,
      guildId: "1",
      channelId: "10",
      user: { id: user },
      message: prompt,
      values,
      client,
      reply: async () => {},
      followUp: async () => {},
      deferUpdate: async () => {},
      editReply: async (payload) => {
        prompt.payload = payload;
      },
    };
    return onItemActionInteraction(f.db, interaction);
  }
  const menu = () =>
    controls(prompt).find((c) => c.custom_id.endsWith(":unbind-character"));
  assert.equal(menu().options.length, 25);
  assert.equal(
    controls(prompt).find((c) => c.custom_id.endsWith(":confirm")).disabled,
    true,
  );
  const value = menu().options[0].value;
  await click("unbind-character", [value], "202");
  await click("character", [value]);
  await click("unbind-character", ["26.26"]); // off-page cannot be forged
  assert.equal(
    getItemAction(f.db, action.id).selections.unbindTarget,
    undefined,
  );
  await click("next");
  assert.equal(menu().options.length, 1);
  await click("unbind-character", [menu().options[0].value]);
  assert.equal(
    getItemAction(f.db, action.id).selections.unbindTarget.characterId,
    26,
  );
  assert.match(JSON.stringify(prompt.payload), /Ownership stays unchanged/);
  const edit = prompt.edit;
  prompt.edit = async () => {
    throw Error("Discord unavailable");
  };
  await click("confirm");
  assert.equal(getItemAction(f.db, action.id).state, "resolved");
  assert.equal(getItemAction(f.db, action.id).delivery_pending, 1);
  assert.equal(
    f.db.prepare("SELECT charges FROM user_inventory WHERE id=?").get(source)
      .charges,
    1,
  );
  prompt.edit = edit;
  const runtime = await recoverItemActionRuntime(f.db, client);
  t.after(runtime.stop);
  assert.equal(getItemAction(f.db, action.id).delivery_pending, 0);
  assert.equal(
    f.db.prepare("SELECT charges FROM user_inventory WHERE id=?").get(source)
      .charges,
    1,
  );
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM marriages").get().n, 26);
  assert.deepEqual(prompt.payload.allowedMentions, {
    parse: [],
    repliedUser: false,
  });
});
