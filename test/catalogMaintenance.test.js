import test from "node:test";
import assert from "node:assert/strict";
import { openCatalog, setMeta } from "../lib/catalogDb.js";
import { reserveRoll, publishRoll, claimRoll } from "../lib/characterRolls.js";
import { createItemAction } from "../lib/itemActions.js";
import {
  catalogDrainStatus,
  isNewGameActionCommand,
} from "../lib/catalogMaintenance.js";

test("drain refuses new rolls/items without charges but permits published claims", (t) => {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  db.exec(
    "INSERT INTO characters(id,rank,favourites,name_full) VALUES(1,1,100,'Prize')",
  );
  const args = {
    guildId: "1",
    channelId: "10",
    commandMessageId: "100",
    userId: "101",
    pool: "w",
    now: 1000,
    random: () => 0.5,
  };
  const roll = reserveRoll(db, args);
  assert.equal(roll.status, "reserved");
  publishRoll(db, roll.rollId, "500", 1100);
  setMeta(db, "game_maintenance", "drain");
  const before = db.prepare("SELECT * FROM roll_allowances").all();
  assert.throws(
    () => reserveRoll(db, { ...args, commandMessageId: "102" }),
    /draining/,
  );
  assert.throws(
    () =>
      createItemAction(db, {
        guildId: "1",
        actorId: "101",
        channelId: "10",
        inventoryId: 1,
      }),
    /draining/,
  );
  assert.deepEqual(db.prepare("SELECT * FROM roll_allowances").all(), before);
  assert.equal(catalogDrainStatus(db).persistedActionsDrained, false);
  assert.equal(
    claimRoll(db, {
      guildId: "1",
      channelId: "10",
      messageId: "500",
      userId: "101",
      now: 1200,
    }).status,
    "married",
  );
  assert.equal(catalogDrainStatus(db).persistedActionsDrained, true);
  for (const name of ["trade", "give", "use", "w", "divorce"])
    assert.equal(isNewGameActionCommand(name), true);
  for (const name of ["cancel", "char", "wl"])
    assert.equal(isNewGameActionCommand(name), false);
});
