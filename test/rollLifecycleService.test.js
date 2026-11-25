import test from "node:test";
import assert from "node:assert/strict";
import { openCatalog } from "../lib/catalogDb.js";
import {
  reserveRoll,
  publishRoll as legacyPublish,
  claimRoll as legacyClaim,
} from "../lib/characterRolls.js";
import { getMarriage } from "../lib/characterMarriage.js";
import { getClaimStatus } from "../features/rolls/rollAllowanceService.js";

const now = 1_800_000_000_000;

function fixture(t, owned = false) {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  db.exec(
    "INSERT INTO characters(id,rank,favourites,name_full,gender) VALUES(1,1,100,'Hero','female')",
  );
  if (owned)
    db.exec(
      "INSERT INTO marriages(guild_id,character_id,owner_id,married_at) VALUES('1',1,'101','original')",
    );
  const rolled = reserveRoll(db, {
    guildId: "1",
    channelId: "10",
    commandMessageId: "100",
    userId: "101",
    pool: "w",
    now,
    random: () => 0,
  });
  assert.equal(rolled.status, "reserved");
  return { db, rolled };
}

test("direct and compatibility imports publish once and allow only one player to marry", async (t) => {
  const { publishRoll, claimRoll, getRoll, markClaimNotice } =
    await import("../features/rolls/rollLifecycleService.js");
  const { db, rolled } = fixture(t);
  assert.equal(publishRoll(db, rolled.rollId, "500", now), true);
  assert.equal(legacyPublish(db, rolled.rollId, "501", now + 1), false);
  assert.equal(getRoll(db, "1", "10", "501"), null);
  assert.equal(
    claimRoll(db, {
      guildId: "1",
      channelId: "10",
      messageId: "500",
      userId: "102",
      now: now + 2,
      random: () => 0,
    }).status,
    "married",
  );
  assert.equal(
    legacyClaim(db, {
      guildId: "1",
      channelId: "10",
      messageId: "500",
      userId: "103",
      now: now + 2,
      random: () => 0,
    }).status,
    "closed",
  );
  assert.equal(getMarriage(db, "1", 1)?.ownerId, "102");
  assert.equal(getClaimStatus(db, "1", "102", now + 2).canClaim, false);
  assert.equal(getClaimStatus(db, "1", "103", now + 2).canClaim, true);
  assert.equal(markClaimNotice(db, rolled.rollId, "103"), true);
  assert.equal(markClaimNotice(db, rolled.rollId, "103"), false);
});

test("ordinary expiry leaves the card open and reportability retains its separate deadline", async (t) => {
  const { publishRoll, claimRoll, getRoll, getReportableRoll, failRoll } =
    await import("../features/rolls/rollLifecycleService.js");
  const { db, rolled } = fixture(t);
  assert.equal(publishRoll(db, rolled.rollId, "500", now), true);
  assert.equal(
    claimRoll(db, {
      guildId: "1",
      channelId: "10",
      messageId: "500",
      userId: "102",
      now: now + 60_000,
    }).status,
    "expired",
  );
  assert.equal(getRoll(db, "1", "10", "500").state, "open");
  assert.equal(getClaimStatus(db, "1", "102", now + 60_000).canClaim, true);
  assert.ok(getReportableRoll(db, "1", "10", "500", now + 3_599_999));
  assert.equal(getReportableRoll(db, "1", "10", "500", now + 3_600_000), null);
  assert.equal(failRoll(db, rolled.rollId), true);
  assert.equal(failRoll(db, rolled.rollId), false);
  assert.equal(getRoll(db, "1", "10", "500").state, "failed");
  assert.equal(getRoll(db, "", "10", "500"), null);
});

test("publication refusal commits cancellation when the original escape owner changes", async (t) => {
  const { publishRoll, getRoll, claimRoll } =
    await import("../features/rolls/rollLifecycleService.js");
  const { db, rolled } = fixture(t, true);
  db.exec("UPDATE marriages SET owner_id='104'");
  assert.equal(publishRoll(db, rolled.rollId, "500", now), false);
  assert.equal(db.isTransaction, false);
  assert.equal(getRoll(db, "1", "10", "500").escapeOutcome, "canceled");
  assert.equal(getRoll(db, "1", "10", "500").state, "closed");
  assert.equal(
    claimRoll(db, {
      guildId: "1",
      channelId: "10",
      messageId: "500",
      userId: "101",
      now: now + 1,
    }).status,
    "closed",
  );
  assert.equal(getMarriage(db, "1", 1)?.ownerId, "104");
});
