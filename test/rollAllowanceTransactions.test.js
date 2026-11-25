import { test } from "node:test";
import assert from "node:assert/strict";
import { openCatalog } from "../lib/catalogDb.js";
import {
  reserveRoll,
  publishRoll,
  claimRoll,
  getRoll,
} from "../lib/characterRolls.js";
import {
  getRollStatus,
  getClaimStatus,
} from "../features/rolls/rollAllowanceService.js";
import { addActiveBuff, getActiveBuffs } from "../lib/itemStorage.js";
import { getMarriage } from "../lib/characterMarriage.js";

const now = Date.parse("2026-10-15T17:00:00Z");

function fixture(t) {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  db.exec(
    "INSERT INTO characters(id,rank,favourites,name_full,gender) VALUES(1,1,2000,'Hero','female')",
  );
  const request = {
    guildId: "1",
    channelId: "2",
    commandMessageId: "3",
    userId: "4",
    pool: "w",
    now,
    random: () => 0,
  };
  return { db, request };
}

test("failed roll persistence rolls back refunds, debits, and buff spending together", (t) => {
  const { db, request } = fixture(t);
  db.prepare("INSERT INTO roll_allowances VALUES(?,?,?,?)").run(
    "1",
    "4",
    Math.floor(now / 3_600_000),
    2,
  );
  addActiveBuff(
    db,
    "1",
    "4",
    "rolling_fever",
    JSON.stringify({ favouritesThreshold: 1000, refundRolls: 2 }),
    null,
    1,
  );
  db.exec(`CREATE TEMP TRIGGER reject_roll BEFORE INSERT ON character_rolls
    BEGIN SELECT RAISE(ABORT, 'injected roll persistence failure'); END`);
  assert.throws(
    () => reserveRoll(db, request),
    /injected roll persistence failure/,
  );
  assert.equal(db.isTransaction, false);
  assert.equal(getRollStatus(db, "1", "4", now).remaining, 5);
  assert.equal(getActiveBuffs(db, "1", "4", now)[0].remaining_rolls, 1);
  db.exec("DROP TRIGGER reject_roll");
  const result = reserveRoll(db, request);
  assert.equal(result.status, "reserved");
  // The refund happens before the debit: usage falls from two to zero, then to one.
  assert.equal(getRollStatus(db, "1", "4", now).remaining, 6);
  assert.equal(reserveRoll(db, request).status, "duplicate");
  assert.equal(getRollStatus(db, "1", "4", now).remaining, 6);
});

test("claim-history failure rolls back ownership and allowance usage in the caller transaction", (t) => {
  const { db, request } = fixture(t);
  const rolled = reserveRoll(db, request);
  assert.equal(rolled.status, "reserved");
  assert.equal(publishRoll(db, rolled.rollId, "5", now), true);
  db.exec(`CREATE TEMP TRIGGER reject_claim BEFORE INSERT ON claim_events
    BEGIN SELECT RAISE(ABORT, 'injected claim history failure'); END`);
  const claim = {
    guildId: "1",
    channelId: "2",
    messageId: "5",
    userId: "4",
    now: now + 1,
    random: () => 0,
  };
  assert.throws(() => claimRoll(db, claim), /injected claim history failure/);
  assert.equal(db.isTransaction, false);
  assert.equal(getMarriage(db, "1", 1), null);
  assert.equal(getClaimStatus(db, "1", "4", now + 1).canClaim, true);
  assert.equal(getRoll(db, "1", "2", "5").state, "open");
  db.exec("DROP TRIGGER reject_claim");
  assert.equal(claimRoll(db, claim).status, "married");
  assert.equal(getClaimStatus(db, "1", "4", now + 1).canClaim, false);
  assert.equal(getMarriage(db, "1", 1)?.ownerId, "4");
});
