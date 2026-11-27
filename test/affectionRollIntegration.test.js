import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFinalCatalog,
  openFinalCatalog,
  transaction,
} from "../lib/catalogDb.js";
import {
  confirmSoulmate,
  earnReclaimInTransaction,
  earnRollerReclaimInTransaction,
  getAffectionTotal,
} from "../lib/characterAffection.js";
import {
  reserveRoll,
  publishRoll,
  claimRoll,
  getRollStatus,
  cleanupRolls,
} from "../lib/characterRolls.js";
import { addActiveBuff, addCharacterLock } from "../lib/itemStorage.js";
import { getConfigView, saveConfigSection } from "../lib/gameConfig.js";

const now = Date.parse("2026-11-04T02:00:00Z");
function fixture(t) {
  const path = mkdtempSync(join(tmpdir(), "affection-roll-"));
  const dbPath = join(path, "synthetic.sqlite");
  const db = createFinalCatalog(dbPath);
  t.after(() => {
    db.close();
    rmSync(path, { recursive: true, force: true });
  });
  const id = "12345678-1234-4123-8123-123456789abc";
  db.prepare(
    "INSERT INTO character_identities(id,creation_method) VALUES(?,'manual')",
  ).run(id);
  db.prepare(
    "INSERT INTO characters(id,rank,favourites,tie_order,likes_source,name_full,gender) VALUES(?,1,0,1,'generated','Owned','Female')",
  ).run(id);
  db.prepare(
    "INSERT INTO marriages(guild_id,character_id,owner_id,married_at) VALUES(?,?,?,?)",
  ).run("1", id, "101", new Date(now).toISOString());
  return { db, id, dbPath };
}
function roll(db, message, userId = "101", time = now, random = () => 0.99) {
  return reserveRoll(db, {
    guildId: "1",
    channelId: "10",
    userId,
    commandMessageId: message,
    pool: "w",
    now: time,
    random,
  });
}

test("own appearances are nonclaimable, skip Misfire, and earn once only after publication", (t) => {
  const { db, id } = fixture(t);
  confirmSoulmate(db, { guildId: "1", userId: "101", characterId: id, now });
  addActiveBuff(db, "1", "101", "cupids_misfire", "{}", null, 1);
  const r = roll(db, "100");
  assert.equal(r.ownAppearance, true);
  assert.equal(r.escapeOwnerId, null);
  assert.equal(getAffectionTotal(db, "1", "101", id), 0);
  assert.equal(publishRoll(db, r.rollId, "500", now + 1), true);
  assert.equal(getAffectionTotal(db, "1", "101", id), 100);
  assert.equal(
    claimRoll(db, {
      guildId: "1",
      channelId: "10",
      messageId: "500",
      userId: "202",
      now: now + 2,
    }).status,
    "closed",
  );
  assert.equal(
    db
      .prepare(
        "SELECT count(*) n FROM active_user_buffs WHERE buff_id='cupids_misfire'",
      )
      .get().n,
    1,
  );
  assert.equal(publishRoll(db, r.rollId, "500", now + 3), false);
  assert.equal(getAffectionTotal(db, "1", "101", id), 100);
  cleanupRolls(db, now + 4 * 3_600_000);
  assert.equal(roll(db, "100", "101", now + 4 * 3_600_000).status, "duplicate");
});

test("soulbound characters are eligible only for their owner", (t) => {
  const { db, id } = fixture(t);
  addCharacterLock(db, "1", id, "soulbind", null);
  assert.equal(roll(db, "100", "202").status, "empty");
  assert.equal(roll(db, "101").ownAppearance, true);
});

test("a pending roll keeps its configured appearance gain after reopening the catalog", (t) => {
  const { db, id, dbPath } = fixture(t);
  const set = (ownAppearance) =>
    saveConfigSection(db, {
      guildId: "1",
      section: "affection",
      expectedRevision: getConfigView(db).revision,
      values: { "affection.ownAppearance": ownAppearance },
    });
  set(175);
  const pending = roll(db, "100");
  set(35);
  const reopened = openFinalCatalog(dbPath);
  try {
    assert.equal(publishRoll(reopened, pending.rollId, "500", now + 1), true);
    assert.equal(getAffectionTotal(reopened, "1", "101", id), 175);
    const next = roll(reopened, "101", "101", now + 2);
    assert.equal(publishRoll(reopened, next.rollId, "501", now + 3), true);
    assert.equal(getAffectionTotal(reopened, "1", "101", id), 210);
  } finally {
    reopened.close();
  }
});

test("new reclaims use server gains and saved awards replay after the server changes them", (t) => {
  const { db, id } = fixture(t);
  confirmSoulmate(db, { guildId: "1", userId: "101", characterId: id, now });
  const set = (owner, roller) =>
    saveConfigSection(db, {
      guildId: "1",
      section: "affection",
      expectedRevision: getConfigView(db).revision,
      values: {
        "affection.ownerReclaim": owner,
        "affection.rollerReclaim": roller,
      },
    });
  const options = {
    guildId: "1",
    channelId: "10",
    userId: "101",
    characterId: id,
    now,
  };
  const owner = (sourceKey) =>
    transaction(
      db,
      () => earnReclaimInTransaction(db, { ...options, sourceKey }).awards,
    );
  const roller = (sourceKey) =>
    transaction(
      db,
      () =>
        earnRollerReclaimInTransaction(db, { ...options, sourceKey }).awards,
    );
  set(37, 11);
  assert.equal(owner("owner")[0].amount, 37);
  assert.equal(roller("roller")[0].amount, 11);
  set(0, 0);
  assert.equal(owner("owner")[0].amount, 37);
  assert.equal(roller("roller")[0].amount, 11);
  assert.deepEqual(owner("owner-disabled"), []);
  assert.deepEqual(roller("roller-disabled"), []);
});

test("Windfall saves a valid roll cost and can trigger on consecutive explicit requests", (t) => {
  const { db, id } = fixture(t);
  db.prepare("INSERT INTO character_affection VALUES(?,?,?,?,?)").run(
    "1",
    "101",
    id,
    100,
    now,
  );
  confirmSoulmate(db, { guildId: "1", userId: "101", characterId: id, now });
  const first = roll(db, "100", "101", now, () => 0);
  assert.equal(first.remaining, 7);
  publishRoll(db, first.rollId, "500", now + 1);
  const second = roll(db, "101", "101", now + 2, () => 0);
  // The first appearance crossed the normal +1 capacity milestone.
  assert.equal(second.remaining, 8);
  assert.equal(getRollStatus(db, "1", "101", now + 3).remaining, 8);
});
