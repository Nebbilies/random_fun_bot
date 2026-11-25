import { test } from "node:test";
import assert from "node:assert/strict";
import { openCatalog } from "../lib/catalogDb.js";
import {
  reserveRoll,
  getRollStatus as legacyRollStatus,
} from "../lib/characterRolls.js";
import {
  getRollStatus,
  setMaxRolls,
  claimDailyRolls,
  nextRollReset,
  nextClaimReset,
  getClaimStatus,
  getClaimAvailability,
  addGlobalRolls,
  resetGlobalClaims,
} from "../features/rolls/rollAllowanceService.js";
import { getConfigView, saveConfigSection } from "../lib/gameConfig.js";
import { addActiveBuff } from "../lib/itemStorage.js";

const midnight = Date.parse("2026-10-15T17:00:00Z");

test("feature allowances and legacy roll reservations share usage and daily refills", (t) => {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  db.exec(
    "INSERT INTO characters(id,rank,favourites,name_full,gender) VALUES(1,1,100,'Hero','female')",
  );
  setMaxRolls(db, "1", 4);
  const request = {
    guildId: "1",
    channelId: "2",
    commandMessageId: "3",
    userId: "4",
    pool: "w",
    now: midnight,
    random: () => 0,
  };
  assert.equal(reserveRoll(db, request).status, "reserved");
  assert.deepEqual(getRollStatus(db, "1", "4", midnight), {
    remaining: 3,
    resetAt: midnight + 3_600_000,
  });
  assert.deepEqual(legacyRollStatus(db, "1", "4", midnight), {
    remaining: 3,
    resetAt: midnight + 3_600_000,
  });
  assert.equal(reserveRoll(db, request).status, "duplicate");
  assert.equal(getRollStatus(db, "1", "4", midnight).remaining, 3);
  assert.deepEqual(claimDailyRolls(db, "1", "4", midnight), {
    status: "refilled",
    remaining: 4,
    resetAt: midnight + 86_400_000,
  });
  assert.deepEqual(claimDailyRolls(db, "1", "4", midnight + 1), {
    status: "claimed",
    resetAt: midnight + 86_400_000,
  });
});

test("reset boundaries retain defaults and configured offsets that do not divide an interval", (t) => {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  assert.equal(nextRollReset(midnight - 1), midnight);
  assert.equal(nextRollReset(midnight), midnight + 3_600_000);
  assert.equal(nextClaimReset(midnight - 1), midnight);
  assert.equal(nextClaimReset(midnight), midnight + 10_800_000);
  saveConfigSection(db, {
    guildId: "1",
    section: "schedules",
    expectedRevision: getConfigView(db).revision,
    activateSchedule: true,
    values: {
      "schedules.rollIntervalMs": 2_700_000,
      "schedules.timezoneOffsetMinutes": 10,
    },
  });
  assert.equal(nextRollReset(2_099_999, db, "1"), 2_100_000);
  assert.equal(nextRollReset(2_100_000, db, "1"), 4_800_000);
});

test("legacy daily eligibility survives schedule activation until its original deadline", (t) => {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  claimDailyRolls(db, "1", "4", midnight);
  db.exec("UPDATE daily_roll_claims SET reset_at=NULL");
  saveConfigSection(db, {
    guildId: "1",
    section: "schedules",
    expectedRevision: getConfigView(db).revision,
    activateSchedule: true,
    values: { "schedules.dailyIntervalMs": 3_600_000 },
  });
  assert.deepEqual(claimDailyRolls(db, "1", "4", midnight + 86_399_999), {
    status: "claimed",
    resetAt: midnight + 86_400_000,
  });
  assert.deepEqual(claimDailyRolls(db, "1", "4", midnight + 86_400_000), {
    status: "refilled",
    remaining: 7,
    resetAt: midnight + 90_000_000,
  });
});

test("normal claim status and token availability stay distinct on a query-only connection", (t) => {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  const now = midnight + 1_800_000;
  db.prepare("INSERT INTO claim_allowances VALUES(?,?,?)").run(
    "1",
    "4",
    Math.floor((now + 25_200_000) / 10_800_000),
  );
  db.prepare("INSERT INTO claim_events VALUES(?,?,?)").run("1", "4", now);
  addActiveBuff(db, "1", "4", "pinata_claim_token", null, null, 1);
  addActiveBuff(db, "1", "4", "double_date", null, null, 0);
  const before = db.prepare("SELECT total_changes() n").get().n;
  db.exec("PRAGMA query_only=ON");
  assert.deepEqual(getClaimStatus(db, "1", "4", now), {
    canClaim: false,
    resetAt: midnight + 10_800_000,
  });
  assert.deepEqual(getClaimAvailability(db, "1", "4", now), {
    canClaim: true,
    resetAt: midnight + 10_800_000,
  });
  assert.equal(db.prepare("SELECT total_changes() n").get().n, before);
});

test("global credits clamp reduced capacity and preserve stale periods and daily eligibility", (t) => {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  claimDailyRolls(db, "1", "4", midnight);
  const period = Math.floor(midnight / 3_600_000);
  db.prepare("INSERT OR REPLACE INTO roll_allowances VALUES(?,?,?,?)").run(
    "1",
    "4",
    period,
    7,
  );
  db.prepare("INSERT INTO roll_allowances VALUES(?,?,?,?)").run(
    "1",
    "5",
    period - 1,
    7,
  );
  setMaxRolls(db, "1", 3);
  assert.deepEqual(addGlobalRolls(db, 1, midnight), { updated: 1 });
  assert.equal(getRollStatus(db, "1", "4", midnight).remaining, 1);
  assert.equal(getRollStatus(db, "1", "5", midnight).remaining, 3);
  assert.deepEqual(resetGlobalClaims(db), { updated: 0 });
  assert.equal(claimDailyRolls(db, "1", "4", midnight + 1).status, "claimed");
  for (const amount of [0, -1, 1.5, "3", null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => addGlobalRolls(db, amount, midnight),
      /Invalid roll amount/,
    );
    assert.throws(() => setMaxRolls(db, "1", amount), /Invalid roll maximum/);
  }
});
