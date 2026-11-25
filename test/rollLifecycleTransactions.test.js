import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { transaction } from "../lib/catalogDb.js";
import { installEmptyFinalCatalog } from "../lib/catalogFinalSchema.js";
import {
  reserveRoll,
  publishMysteryIntro,
  advanceMysterySession,
  openMysteryClaim,
} from "../lib/characterRolls.js";
import { getMysterySession } from "../lib/mysterySessionState.js";
import {
  claimRoll,
  claimRollInTransaction,
  publishRoll,
  getRoll,
} from "../features/rolls/rollLifecycleService.js";
import {
  getClaimStatus,
  claimPeriod,
} from "../features/rolls/rollAllowanceService.js";
import { addActiveBuff, getActiveBuffs } from "../lib/itemStorage.js";
import { getMarriage } from "../lib/characterMarriage.js";
import {
  confirmSoulmate,
  getAffectionTotal,
} from "../lib/characterAffection.js";

const characterId = "11111111-1111-4111-8111-111111111111";
const now = 1_800_000_000_000;

function fixture(t) {
  const db = new DatabaseSync(":memory:");
  installEmptyFinalCatalog(db);
  t.after(() => db.close());
  db.prepare("INSERT INTO character_identities(id,name_full) VALUES(?,?)").run(
    characterId,
    "Hero",
  );
  db.prepare(
    `INSERT INTO characters(id,rank,tie_order,favourites,likes_source,name_full,gender)
    VALUES(?,1,1,100,'generated','Hero','female')`,
  ).run(characterId);
  return db;
}

/** @param {Parameters<typeof reserveRoll>[1]['mystery']} [mystery] */
function reserve(db, mystery = null) {
  return reserveRoll(db, {
    guildId: "1",
    channelId: "10",
    commandMessageId: "100",
    userId: "101",
    pool: "w",
    now,
    random: () => 0.99,
    mystery,
  });
}

test("outer claim rollback restores ownership, open state, and the bypass charge", (t) => {
  const db = fixture(t);
  db.prepare("INSERT INTO claim_allowances VALUES(?,?,?)").run(
    "1",
    "102",
    claimPeriod(db, "1", now),
  );
  db.prepare("INSERT INTO claim_events VALUES(?,?,?)").run("1", "102", now);
  const rolled = reserve(db);
  publishRoll(db, rolled.rollId, "500", now);
  addActiveBuff(db, "1", "102", "crown_of_the_sovereign", null, null, 1);
  const request = {
    guildId: "1",
    channelId: "10",
    messageId: "500",
    userId: "102",
    now: now + 1,
    random: () => 0.99,
  };
  assert.throws(
    () =>
      transaction(db, () => {
        assert.equal(claimRollInTransaction(db, request).status, "married");
        assert.equal(getActiveBuffs(db, "1", "102", now + 1).length, 0);
        assert.equal(db.isTransaction, true);
        throw new Error("outer rollback");
      }),
    /outer rollback/,
  );
  assert.equal(db.isTransaction, false);
  assert.equal(getMarriage(db, "1", characterId), null);
  assert.equal(getRoll(db, "1", "10", "500").state, "open");
  assert.equal(getActiveBuffs(db, "1", "102", now + 1)[0].remaining_rolls, 1);
  assert.equal(
    transaction(db, () => claimRollInTransaction(db, request)).status,
    "married",
  );
  assert.equal(getActiveBuffs(db, "1", "102", now + 1).length, 0);
  assert.equal(claimRoll(db, request).status, "closed");
  assert.equal(getClaimStatus(db, "1", "102", now + 1).canClaim, false);
});

test("failed mystery settlement rolls back marriage, allowance, and both lifecycle states", (t) => {
  const db = fixture(t);
  const rolled = reserve(db, {
    eventChannelId: "20",
    selectEvent: () => ({
      eventId: "doors",
      state: { winningDoor: 1 },
      durationMs: 60_000,
    }),
  });
  assert.equal(rolled.status, "mystery");
  publishMysteryIntro(db, rolled.sessionId, "900", now);
  let session = getMysterySession(db, rolled.sessionId);
  advanceMysterySession(db, {
    sessionId: rolled.sessionId,
    expectedState: "reserved",
    expectedStateJson: session.stateJson,
    stateJson: undefined,
    state: "running",
    now: now + 5_000,
  });
  session = getMysterySession(db, rolled.sessionId);
  advanceMysterySession(db, {
    sessionId: rolled.sessionId,
    expectedState: "running",
    // The legacy function infers null from its default despite accepting Discord IDs.
    expectedStateJson: session.stateJson,
    stateJson: undefined,
    state: "countdown",
    winnerId: /** @type {any} */ ("102"),
    now: now + 6_000,
  });
  assert.equal(
    openMysteryClaim(db, {
      sessionId: rolled.sessionId,
      messageId: "500",
      now: now + 11_000,
    }).status,
    "open",
  );
  const request = {
    guildId: "1",
    channelId: "20",
    messageId: "500",
    userId: "102",
    now: now + 11_001,
    random: () => 0.99,
  };
  assert.equal(
    claimRoll(db, { ...request, userId: "103" }).status,
    "protected",
  );
  db.exec(`CREATE TEMP TRIGGER reject_mystery_settlement BEFORE UPDATE ON mystery_sessions
    WHEN NEW.state='completed' BEGIN SELECT RAISE(ABORT,'settlement rejected'); END`);
  assert.throws(() => claimRoll(db, request), /settlement rejected/);
  assert.equal(getMarriage(db, "1", characterId), null);
  assert.equal(getClaimStatus(db, "1", "102", request.now).canClaim, true);
  assert.equal(getRoll(db, "1", "20", "500").state, "open");
  assert.equal(getMysterySession(db, rolled.sessionId).state, "claim_open");
  db.exec("DROP TRIGGER reject_mystery_settlement");
  assert.equal(claimRoll(db, request).status, "married");
  assert.equal(getMysterySession(db, rolled.sessionId).outcome, "claimed");
  assert.equal(getClaimStatus(db, "1", "102", request.now).canClaim, false);
});

test("publication award failure restores pending own appearance and can be retried once", (t) => {
  const db = fixture(t);
  db.prepare(
    "INSERT INTO marriages(guild_id,character_id,owner_id,married_at) VALUES('1',?,'101','original')",
  ).run(characterId);
  confirmSoulmate(db, {
    guildId: "1",
    userId: "101",
    characterId,
    expectedRevision: undefined,
    now,
  });
  const rolled = reserve(db);
  assert.equal(rolled.ownAppearance, true);
  db.exec(`CREATE TEMP TRIGGER reject_appearance_award BEFORE INSERT ON affection_awards
    BEGIN SELECT RAISE(ABORT,'award rejected'); END`);
  assert.throws(
    () => publishRoll(db, rolled.rollId, "500", now + 1),
    /award rejected/,
  );
  assert.equal(getRoll(db, "1", "10", "500"), null);
  assert.equal(getAffectionTotal(db, "1", "101", characterId), 0);
  db.exec("DROP TRIGGER reject_appearance_award");
  assert.equal(publishRoll(db, rolled.rollId, "500", now + 1), true);
  assert.equal(getRoll(db, "1", "10", "500").state, "closed");
  assert.equal(getAffectionTotal(db, "1", "101", characterId), 100);
  assert.equal(publishRoll(db, rolled.rollId, "500", now + 2), false);
  assert.equal(getAffectionTotal(db, "1", "101", characterId), 100);
});
