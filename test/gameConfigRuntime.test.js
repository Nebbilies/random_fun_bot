import assert from "node:assert/strict";
import { test } from "node:test";
import { openCatalog } from "../lib/catalogDb.js";
import { getConfigView, saveConfigSection } from "../lib/gameConfig.js";
import {
  reserveRoll,
  publishRoll,
  getRoll,
  getRollStatus,
  claimDailyRolls,
  getMaxRolls,
  setMaxRolls,
} from "../lib/characterRolls.js";
import { addWish, getWishes } from "../lib/characterWishlist.js";
import { getGuildRates, setGuildRates } from "../lib/guildRates.js";

function save(db, section, values, guildId = "1", extra = {}) {
  return saveConfigSection(db, {
    section,
    values,
    guildId,
    expectedRevision: getConfigView(db).revision,
    ...extra,
  });
}
function catalog() {
  const db = openCatalog(":memory:");
  db.prepare(
    "INSERT INTO characters(id,name_full,rank,favourites,gender) VALUES(1,'Hero',100,100,'female')",
  ).run();
  return db;
}
test("roll reservation freezes claim and escape windows across config saves", () => {
  const db = catalog();
  save(db, "windows", { "windows.claimMs": 120000 });
  const reserved = reserveRoll(db, {
    guildId: "1",
    channelId: "2",
    commandMessageId: "3",
    userId: "4",
    pool: "w",
    now: 1000,
    random: () => 0,
  });
  save(db, "windows", { "windows.claimMs": 10000 });
  assert.equal(publishRoll(db, reserved.rollId, "5", 2000), true);
  assert.equal(getRoll(db, "1", "2", "5").expiresAt, 122000);
  db.close();
});
test("schedule activation gives fresh roll allowance but retains daily next eligibility", () => {
  const db = catalog();
  const now = 100000;
  const first = claimDailyRolls(db, "1", "4", now);
  reserveRoll(db, {
    guildId: "1",
    channelId: "2",
    commandMessageId: "3",
    userId: "4",
    pool: "w",
    now,
    random: () => 0,
  });
  assert.equal(getRollStatus(db, "1", "4", now).remaining, 6);
  save(
    db,
    "schedules",
    {
      "schedules.rollIntervalMs": 1800000,
      "schedules.dailyIntervalMs": 3600000,
    },
    "1",
    { activateSchedule: true },
  );
  assert.equal(getRollStatus(db, "1", "4", now).remaining, 7);
  assert.deepEqual(claimDailyRolls(db, "1", "4", now + 1), {
    status: "claimed",
    resetAt: first.resetAt,
  });
  db.close();
});
test("capacity reductions retain wishes and block new additions", () => {
  const db = catalog();
  addWish(db, { guildId: "1", userId: "4", characterId: 1 });
  save(db, "capacity", { "capacity.wishlist": 1 });
  assert.equal(
    addWish(db, { guildId: "1", userId: "4", characterId: 2 }).status,
    "full",
  );
  assert.equal(getWishes(db, { guildId: "1", userId: "4" }).length, 1);
  db.close();
});
test("legacy Discord setters and web overrides resolve from same model without cache", () => {
  const db = catalog();
  setMaxRolls(db, "1", 11);
  assert.equal(getMaxRolls(db, "1"), 11);
  save(db, "rolls", { "rolls.maxRolls": 9 });
  assert.equal(getMaxRolls(db, "1"), 9);
  setGuildRates(db, "1", { vaultRate: 0.2 });
  assert.equal(getGuildRates(db, "1").vaultRate, 0.2);
  save(db, "vault", { "vault.dropRate": 0.3 });
  assert.equal(getGuildRates(db, "1").vaultRate, 0.3);
  db.close();
});
