import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFinalCatalog } from "../lib/catalogDb.js";
import {
  reserveRoll,
  loadRollCharacterSnapshot as legacySnapshot,
} from "../lib/characterRolls.js";
import { getMysterySession as legacySession } from "../lib/characterRolls.js";
import { transaction } from "../lib/catalogDb.js";
import {
  loadRollDelivery,
  captureRollDelivery as legacyCapture,
} from "../lib/rollDelivery.js";
import { getRollStatus } from "../features/rolls/rollAllowanceService.js";

const characterId = "12345678-1234-4123-8123-123456789abc";
const now = 1_800_000_000_000;

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "roll-lifecycle-dependencies-"));
  const db = createFinalCatalog(join(directory, "catalog.sqlite"));
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  db.prepare(
    "INSERT INTO character_identities(id,creation_method) VALUES (?,'manual')",
  ).run(characterId);
  db.prepare(
    `INSERT INTO characters(id,rank,favourites,tie_order,likes_source,name_full,gender)
    VALUES (?,1,2000,1,'generated','Original','female')`,
  ).run(characterId);
  return db;
}

function reserve(db) {
  return reserveRoll(db, {
    guildId: "1",
    channelId: "10",
    commandMessageId: "100",
    userId: "101",
    pool: "w",
    now,
    random: () => 0,
  });
}

test("snapshot imports preserve captured terms and reject corrupt terms after catalog edits", async (t) => {
  const { loadRollCharacterSnapshot } =
    await import("../features/rolls/rollSnapshot.js");
  const db = fixture(t);
  const result = reserve(db);
  assert.equal(result.status, "reserved");
  db.prepare("UPDATE characters SET name_full='Edited' WHERE id=?").run(
    characterId,
  );
  assert.equal(
    loadRollCharacterSnapshot(db, result.rollId).name_full,
    "Original",
  );
  assert.deepEqual(
    loadRollCharacterSnapshot(db, result.rollId),
    legacySnapshot(db, result.rollId),
  );
  db.prepare(
    "UPDATE character_rolls SET character_snapshot_json='{}' WHERE id=?",
  ).run(result.rollId);
  assert.throws(
    () => loadRollCharacterSnapshot(db, result.rollId),
    /snapshot/i,
  );
  assert.throws(() => legacySnapshot(db, result.rollId), /snapshot/i);
});

test("mystery terminal settlement participates in the caller transaction and is repeatable", async (t) => {
  const { getMysterySession, finishMystery } =
    await import("../lib/mysterySessionState.js");
  const db = fixture(t);
  const result = reserveRoll(db, {
    guildId: "1",
    channelId: "10",
    commandMessageId: "100",
    userId: "101",
    pool: "w",
    now,
    random: () => 0,
    mystery: {
      eventChannelId: "20",
      selectEvent: () => ({
        eventId: "doors",
        state: { winningDoor: 1 },
        durationMs: 60_000,
      }),
    },
  });
  assert.equal(result.status, "mystery");
  assert.throws(
    () =>
      transaction(db, () => {
        assert.equal(
          finishMystery(db, result.sessionId, "failed", now + 1),
          true,
        );
        assert.equal(getMysterySession(db, result.sessionId).state, "failed");
        throw new Error("outer rollback");
      }),
    /outer rollback/,
  );
  assert.equal(legacySession(db, result.sessionId).state, "reserved");
  assert.equal(
    transaction(db, () =>
      finishMystery(db, result.sessionId, "failed", now + 2),
    ),
    true,
  );
  assert.deepEqual(
    getMysterySession(db, result.sessionId),
    legacySession(db, result.sessionId),
  );
  assert.equal(getMysterySession(db, result.sessionId).outcome, "failed");
  assert.equal(
    transaction(db, () =>
      finishMystery(db, result.sessionId, "claimed", now + 3),
    ),
    false,
  );
  assert.equal(getMysterySession(db, result.sessionId).outcome, "failed");
});

test("delivery capture rolls back with reservation and obeys an existing outer transaction", async (t) => {
  const { hasRollDelivery, captureRollDelivery } =
    await import("../features/rolls/rollDeliveryCapture.js");
  const db = fixture(t);
  assert.equal(hasRollDelivery(db), true);
  db.exec(`CREATE TEMP TRIGGER reject_capture BEFORE INSERT ON roll_delivery
    BEGIN SELECT RAISE(ABORT,'capture rejected'); END`);
  assert.throws(() => reserve(db), /capture rejected/);
  assert.equal(getRollStatus(db, "1", "101", now).remaining, 7);
  db.exec("DROP TRIGGER reject_capture");
  const result = reserve(db);
  const captured = loadRollDelivery(db, result.rollId);
  assert.equal(captured.remaining, 6);
  db.prepare("DELETE FROM roll_delivery WHERE roll_id=?").run(result.rollId);
  const input = {
    rollId: result.rollId,
    userId: "101",
    remaining: 6,
    characterSnapshot: legacySnapshot(db, result.rollId),
  };
  assert.throws(
    () =>
      transaction(db, () => {
        assert.equal(captureRollDelivery(db, input), true);
        throw new Error("outer rollback");
      }),
    /outer rollback/,
  );
  assert.equal(loadRollDelivery(db, result.rollId), null);
  assert.equal(
    transaction(db, () => legacyCapture(db, input)),
    true,
  );
  assert.equal(
    loadRollDelivery(db, result.rollId).logical_delivery_id,
    captured.logical_delivery_id,
  );
});
