import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFinalCatalog } from "../lib/catalogDb.js";
import { addItemToInventory } from "../lib/itemStorage.js";
import { executeItemUseById } from "../lib/itemActivation.js";
import { armCupidsMisfire } from "../lib/items/cupidsMisfire.js";
import {
  reserveBinocularsUse,
  settleBinocularsUse,
  recoverBinocularsUses,
} from "../lib/binocularsUse.js";

export function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "affection-items-"));
  const db = createFinalCatalog(join(dir, "synthetic.sqlite"));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return db;
}
export function soulmate(db, userId, total = 2100, index = 1) {
  const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  db.prepare("INSERT INTO character_identities(id) VALUES(?)").run(id);
  db.prepare(
    "INSERT INTO characters(id,rank,favourites,tie_order,likes_source,name_full) VALUES(?,?,1,?,'generated',?)",
  ).run(id, index, index, `Character ${index}`);
  db.prepare(
    "INSERT INTO marriages(guild_id,character_id,owner_id,married_at) VALUES('1',?,?,'2026')",
  ).run(id, userId);
  db.prepare("INSERT INTO character_affection VALUES('1',?,?,?,0)").run(
    userId,
    id,
    total,
  );
  db.prepare("INSERT INTO player_soulmates VALUES('1',?,?,0,0,1)").run(
    userId,
    id,
  );
  return id;
}
const charges = (db, id) =>
  db.prepare("SELECT charges FROM user_inventory WHERE id=?").get(id)
    ?.charges ?? 0;

test("manual conserved use has a permanent invocation; a separate explicit use is independent", (t) => {
  const db = fixture(t);
  soulmate(db, "101");
  const source = addItemToInventory(db, "1", "101", "love_letter", 2, {
    now: 100,
  }).item;
  const options = {
    now: 100,
    channelId: "10",
    commandMessageId: "first",
    random: () => 0,
  };
  const first = executeItemUseById(db, "1", "101", source.id, [], options);
  assert.equal(first.success, true);
  assert.equal(first.actualDebit, 0);
  assert.equal(charges(db, source.id), 2);
  assert.deepEqual(
    executeItemUseById(db, "1", "101", source.id, [], {
      ...options,
      random: () => {
        throw Error("replay drew");
      },
    }),
    first,
  );
  const next = executeItemUseById(db, "1", "101", source.id, [], {
    ...options,
    commandMessageId: "second",
    random: () => 0.99,
  });
  assert.equal(next.actualDebit, 1);
  assert.equal(charges(db, source.id), 1);
});

test("manual receipt wins over spent inventory and rejects conflicting immutable scope", (t) => {
  const db = fixture(t);
  const source = addItemToInventory(db, "1", "101", "love_letter", 1, {
    now: 100,
  }).item;
  const options = { now: 100, channelId: "10", commandMessageId: "spent" };
  const first = executeItemUseById(db, "1", "101", source.id, [], options);
  assert.equal(charges(db, source.id), 0);
  assert.deepEqual(
    executeItemUseById(db, "1", "101", source.id, [], options),
    first,
  );
  assert.throws(
    () => executeItemUseById(db, "1", "202", source.id, [], options),
    /scope/i,
  );
});

test("standalone Misfire conserves activation and replays after the source disappears", (t) => {
  const db = fixture(t);
  soulmate(db, "101");
  const source = addItemToInventory(db, "1", "101", "cupids_misfire", 1, {
    now: 100,
  }).item;
  const options = {
    guildId: "1",
    userId: "101",
    inventoryId: source.id,
    invocationId: "misfire",
    now: 100,
    random: () => 0,
  };
  const first = armCupidsMisfire(db, options);
  assert.equal(first.actualDebit, 0);
  assert.equal(charges(db, source.id), 1);
  db.prepare("DELETE FROM user_inventory WHERE id=?").run(source.id);
  assert.deepEqual(armCupidsMisfire(db, options), first);
  assert.match(first.message, /own.*(skip|armed)|skip.*own/i);
});

for (const delivered of [false, true, "ambiguous"])
  test(`Binoculars captures before DM and settles ${delivered} without using current soulmate`, (t) => {
    const db = fixture(t);
    soulmate(db, "101");
    const source = addItemToInventory(db, "1", "101", "binoculars", 2, {
      now: 100,
    }).item;
    const id = reserveBinocularsUse(db, {
      guildId: "1",
      userId: "101",
      channelId: "10",
      inventoryId: source.id,
      sessionId: null,
      now: 100,
      random: () => 0,
    });
    db.prepare(
      "UPDATE player_soulmates SET character_id=NULL WHERE user_id='101'",
    ).run();
    if (delivered === "ambiguous") assert.equal(recoverBinocularsUses(db), 1);
    else assert.equal(settleBinocularsUse(db, id, delivered), true);
    assert.equal(charges(db, source.id), 2);
    assert.equal(
      db.prepare("SELECT count(*) n FROM item_use_reservations").get().n,
      0,
    );
    assert.equal(settleBinocularsUse(db, id, true), false);
  });
