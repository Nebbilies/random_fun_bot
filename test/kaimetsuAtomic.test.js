import assert from "node:assert/strict";
import { test } from "node:test";
import { openCatalog } from "../lib/catalogDb.js";
import { addItemToInventory, getInventory } from "../lib/itemStorage.js";
import { getItemAction } from "../lib/itemActionStorage.js";
import {
  createItemAction,
  activateItemAction,
  confirmHostageDelivery,
} from "../lib/itemActions.js";

function fixture(t) {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  for (let i = 1; i <= 4; i++) {
    db.prepare("INSERT INTO characters(id,rank,favourites) VALUES(?,?,1)").run(
      i,
      i,
    );
    db.prepare(
      "INSERT INTO marriages(guild_id,character_id,owner_id,married_at) VALUES('1',?,?,'now')",
    ).run(i, i <= 2 ? "101" : "202");
  }
  const choice = (id) => {
    const m = db
      .prepare("SELECT * FROM marriages WHERE character_id=?")
      .get(id);
    return { marriageId: m.id, characterId: id, ownerId: m.owner_id };
  };
  const create = (kind, selections = {}) => {
    const item = addItemToInventory(db, "1", "101", kind, 1).item;
    return createItemAction(db, {
      guildId: "1",
      actorId: "101",
      channelId: "10",
      inventoryId: item.id,
      selections,
      now: 100,
    });
  };
  const activate = (a, random = () => 0) =>
    activateItemAction(db, {
      actionId: a.id,
      guildId: "1",
      actorId: "101",
      now: 101,
      random,
    });
  return { db, choice, create, activate };
}

for (const delivered of [false, true])
  test(`Hostage cancellation rolls back with effect; delivered=${delivered}`, (t) => {
    const { db, choice, create, activate } = fixture(t);
    const note = create("hostage_note", {
      own: choice(1),
      targets: [choice(3)],
    });
    activate(note);
    if (delivered) confirmHostageDelivery(db, note.id, "999", 101);
    const a = create("kaimetsu");
    const inventory = getInventory(db, "1", "101");
    db.exec(`CREATE TRIGGER fail_finish BEFORE UPDATE ON item_actions
    WHEN OLD.kind='kaimetsu' BEGIN SELECT RAISE(ABORT,'finish failed'); END`);
    assert.throws(() => activate(a), /finish failed/);
    assert.equal(
      getItemAction(db, note.id).state,
      delivered ? "active" : "awaiting_delivery",
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM item_character_reservations").get()
        .n,
      2,
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM marriages").get().n, 4);
    assert.deepEqual(getInventory(db, "1", "101"), inventory);
    db.exec("DROP TRIGGER fail_finish");
    activate(a);
    assert.equal(getItemAction(db, note.id).state, "canceled");
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM item_action_costs").get().n,
      0,
    );
    assert.equal(
      getInventory(db, "1", "101").some(
        (row) => row.item_id === "hostage_note",
      ),
      !delivered,
    );
  });

test("archived marriages count; high random values select distinct end-of-pool entries", (t) => {
  const { db, create, activate } = fixture(t);
  db.prepare("DELETE FROM characters WHERE id IN (2,4)").run();
  const result = activate(create("kaimetsu"), () => 0.999999);
  assert.equal(result.totalDivorced, 2);
  assert.deepEqual(
    db
      .prepare("SELECT character_id FROM marriages ORDER BY character_id")
      .all()
      .map((r) => r.character_id),
    [1, 3],
  );
});
