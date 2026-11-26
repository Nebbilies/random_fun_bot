import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installEmptyFinalCatalog } from "../lib/catalogFinalSchema.js";
import {
  reserveRoll,
  publishRoll,
  claimRoll,
  getRollAffectionFeedback,
} from "../lib/characterRolls.js";
import {
  confirmSoulmate,
  getAffectionTotal,
  earnRollerReclaimInTransaction,
} from "../lib/characterAffection.js";
import { acknowledgeRollDelivery } from "../lib/rollDelivery.js";

const now = Date.parse("2026-11-06T08:00:00Z");
const first = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";
const foreign = "33333333-3333-4333-8333-333333333333";
function fixture(t, { select = true, total = 0 } = {}) {
  const db = new DatabaseSync(":memory:");
  installEmptyFinalCatalog(db);
  t.after(() => db.close());
  for (const [i, id] of [first, second, foreign].entries()) {
    db.prepare(
      "INSERT INTO character_identities(id,name_full) VALUES(?,?)",
    ).run(id, `Character ${i + 1}`);
    db.prepare(
      "INSERT INTO characters(id,rank,tie_order,favourites,likes_source,name_full,gender) VALUES(?,?,?,0,'generated',?,'female')",
    ).run(id, i + 1, i + 1, `Character ${i + 1}`);
    db.prepare(
      "INSERT INTO marriages(guild_id,character_id,owner_id,married_at) VALUES('1',?,?,?)",
    ).run(id, id === foreign ? "202" : "101", new Date(now).toISOString());
  }
  if (total)
    db.prepare("INSERT INTO character_affection VALUES('1','101',?,?,?)").run(
      first,
      total,
      now,
    );
  if (select)
    confirmSoulmate(db, {
      guildId: "1",
      userId: "101",
      characterId: first,
      now: now - 43_200_001,
    });
  return db;
}
function reserve(db) {
  const result = reserveRoll(db, {
    guildId: "1",
    channelId: "10",
    userId: "101",
    commandMessageId: "100",
    pool: "w",
    now,
    random: () => 0.99,
  });
  assert.equal(result.character.id, foreign);
  return result;
}
function reclaim(db, random = () => 0.99, time = now + 2) {
  return claimRoll(db, {
    guildId: "1",
    channelId: "10",
    messageId: "500",
    userId: "202",
    now: time,
    random,
  });
}
function publish(db, rolled) {
  acknowledgeRollDelivery(db, rolled.rollId, "500", now + 1);
  publishRoll(db, rolled.rollId, "500", now + 1);
}

test("successful owner reclaim awards five to the roller soulmate without a franchise match", (t) => {
  const db = fixture(t),
    rolled = reserve(db);
  publish(db, rolled);
  const result = reclaim(db);
  assert.equal(result.status, "reclaimed");
  assert.equal(getAffectionTotal(db, "1", "202", foreign), 20);
  assert.equal(getAffectionTotal(db, "1", "101", first), 5);
  assert.deepEqual(
    result.affection.awards.map((a) => [
      a.userId,
      a.characterId,
      a.base,
      a.amount,
    ]),
    [
      ["202", foreign, 20, 20],
      ["101", first, 5, 5],
    ],
  );
});

for (const base of [8, 5])
  test(`stored base-${base} roller reclaim replays verbatim after soulmate selection changes`, (t) => {
    const db = fixture(t);
    const options = {
      sourceKey: "reclaim:historical",
      guildId: "1",
      channelId: "10",
      userId: "101",
      now,
    };
    db.exec("BEGIN");
    let original;
    if (base === 8) {
      // Historical Bond receipt: preserve its doubled amount and saved unlocks, not today's base.
      const milestones = [
        { key: "historical", threshold: 25, itemId: "four_leaf_clover" },
      ];
      db.prepare(
        "INSERT INTO character_affection VALUES('1','101',?,36,?)",
      ).run(first, now);
      db.prepare(
        "INSERT INTO affection_awards VALUES(?,'1','101',?,8,16,36,?,?)",
      ).run(options.sourceKey, first, JSON.stringify(milestones), now);
      original = earnRollerReclaimInTransaction(db, options);
      assert.equal(original.awards[0].amount, 16);
      assert.deepEqual(original.awards[0].milestones, milestones);
    } else {
      original = earnRollerReclaimInTransaction(db, options);
      assert.equal(original.awards[0].base, 5);
      assert.equal(original.awards[0].amount, 5);
    }
    db.exec("COMMIT");
    assert.equal(
      confirmSoulmate(db, {
        guildId: "1",
        userId: "101",
        characterId: second,
        now: now + 1,
      }).status,
      "selected",
    );
    const before = Object.fromEntries(
      [
        "affection_awards",
        "character_affection",
        "affection_decisions",
        "affection_entitlements",
      ].map((table) => [
        table,
        db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ]),
    );
    db.exec("BEGIN");
    assert.deepEqual(
      earnRollerReclaimInTransaction(db, {
        ...options,
        now: now + 2,
        random: () => {
          throw new Error("must not draw");
        },
      }),
      original,
    );
    db.exec("COMMIT");
    for (const [table, rows] of Object.entries(before))
      assert.deepEqual(
        db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
        rows,
      );
    assert.equal(getAffectionTotal(db, "1", "101", second), 0);
  });

test("appearance franchise affection and reclaim bonus are independent permanent awards", (t) => {
  const db = fixture(t);
  db.exec(
    "INSERT INTO franchises(id,display_name,created_at) VALUES(1,'Shared','d')",
  );
  for (const id of [first, foreign])
    db.prepare("INSERT INTO character_main_franchises VALUES(?,1)").run(id);
  const rolled = reserve(db);
  assert.equal(rolled.soulmateReclaimVersion, 1);
  publish(db, rolled);
  assert.equal(getAffectionTotal(db, "1", "101", first), 12);
  reclaim(db);
  assert.equal(getAffectionTotal(db, "1", "101", first), 17);
  assert.deepEqual(
    getRollAffectionFeedback(db, rolled.rollId)
      .filter((a) => a.userId === "101")
      .map((a) => a.amount),
    [12, 5],
  );
});

test("new bonus follows current selection while earlier appearance affection stays with its character", (t) => {
  const db = fixture(t);
  db.exec(
    "INSERT INTO franchises(id,display_name,created_at) VALUES(1,'Shared','d')",
  );
  for (const id of [first, foreign])
    db.prepare("INSERT INTO character_main_franchises VALUES(?,1)").run(id);
  const rolled = reserve(db);
  publish(db, rolled);
  assert.equal(
    confirmSoulmate(db, {
      guildId: "1",
      userId: "101",
      characterId: second,
      now: now + 1,
    }).status,
    "selected",
  );
  reclaim(db);
  assert.equal(getAffectionTotal(db, "1", "101", first), 12);
  assert.equal(getAffectionTotal(db, "1", "101", second), 5);
});

test("selecting a first soulmate after rolling qualifies at reclaim time", (t) => {
  const db = fixture(t, { select: false }),
    rolled = reserve(db);
  publish(db, rolled);
  confirmSoulmate(db, {
    guildId: "1",
    userId: "101",
    characterId: second,
    now: now + 1,
  });
  reclaim(db);
  assert.equal(getAffectionTotal(db, "1", "101", second), 5);
});

for (const state of ["none", "lost"])
  test(`owner still reclaims when roller soulmate is ${state}`, (t) => {
    const db = fixture(t, { select: state !== "none" }),
      rolled = reserve(db);
    publish(db, rolled);
    if (state === "lost")
      db.prepare(
        "DELETE FROM marriages WHERE guild_id='1' AND character_id=?",
      ).run(first);
    assert.equal(reclaim(db).status, "reclaimed");
    assert.equal(getAffectionTotal(db, "1", "202", foreign), 20);
    assert.equal(getAffectionTotal(db, "1", "101", first), 0);
    // A later selection and duplicate reaction cannot reopen the no-bonus outcome.
    confirmSoulmate(db, {
      guildId: "1",
      userId: "101",
      characterId: second,
      now: now + 3,
    });
    assert.equal(reclaim(db, () => 0, now + 4).status, "closed");
    assert.equal(getAffectionTotal(db, "1", "101", second), 0);
  });

test("Bond uses the current pre-award chance and cannot be rerolled or redirected", (t) => {
  const db = fixture(t, { total: 200 }),
    rolled = reserve(db);
  publish(db, rolled);
  const result = reclaim(db, () => 0);
  assert.equal(
    result.affection.awards.find((a) => a.userId === "101").amount,
    10,
  );
  assert.equal(getAffectionTotal(db, "1", "101", first), 210);
  confirmSoulmate(db, {
    guildId: "1",
    userId: "101",
    characterId: second,
    now: now + 3,
  });
  assert.equal(
    reclaim(
      db,
      () => {
        throw new Error("must not draw");
      },
      now + 4,
    ).status,
    "closed",
  );
  assert.equal(getAffectionTotal(db, "1", "101", second), 0);
});

test("crossing the first Bond checkpoint does not double its own award", (t) => {
  const db = fixture(t, { total: 196 }),
    rolled = reserve(db);
  publish(db, rolled);
  const award = reclaim(db, () => 0).affection.awards.find(
    (a) => a.userId === "101",
  );
  assert.equal(award.amount, 5);
  assert.equal(award.total, 201);
  assert.equal(
    award.checkpoints.find((c) => c.effect === "unbroken_bond").threshold,
    200,
  );
});

test("a roller award failure rolls back the owner award and successful reclaim together", (t) => {
  const db = fixture(t, { total: 200 }),
    rolled = reserve(db);
  publish(db, rolled);
  const decisions = db
    .prepare("SELECT * FROM affection_decisions ORDER BY rowid")
    .all();
  assert.throws(() => reclaim(db, () => NaN), /random/i);
  assert.equal(
    db
      .prepare("SELECT state FROM character_rolls WHERE id=?")
      .get(rolled.rollId).state,
    "open",
  );
  assert.equal(getAffectionTotal(db, "1", "202", foreign), 0);
  assert.equal(getAffectionTotal(db, "1", "101", first), 200);
  assert.deepEqual(
    db.prepare("SELECT * FROM affection_decisions ORDER BY rowid").all(),
    decisions,
  );
  assert.equal(reclaim(db).status, "reclaimed");
});

test("both recipients earn milestone entitlements atomically and credited amounts respect the cap", (t) => {
  const db = fixture(t, { total: 95 });
  db.prepare("INSERT INTO character_affection VALUES('1','202',?,95,?)").run(
    foreign,
    now,
  );
  const rolled = reserve(db);
  publish(db, rolled);
  const result = reclaim(db);
  assert.deepEqual(
    result.affection.awards.map((a) => [a.userId, a.total, a.milestones]),
    [
      ["202", 115, [{ key: "normal_100", threshold: 100, tier: "common" }]],
      ["101", 100, [{ key: "normal_100", threshold: 100, tier: "common" }]],
    ],
  );
  assert.deepEqual(
    db
      .prepare(
        "SELECT user_id,state FROM affection_entitlements ORDER BY user_id",
      )
      .all()
      .map((r) => [r.user_id, r.state]),
    [
      ["101", "selected"],
      ["202", "selected"],
    ],
  );
  const capped = fixture(t, { total: 2097 }),
    otherRoll = reserve(capped);
  publish(capped, otherRoll);
  const cappedAward = reclaim(capped, () => 0).affection.awards.find(
    (a) => a.userId === "101",
  );
  assert.equal(cappedAward.amount, 3);
  assert.equal(cappedAward.total, 2100);
});

test("pre-feature pending rolls retain owner-only affection after publication", (t) => {
  const db = fixture(t),
    rolled = reserve(db);
  const terms = JSON.parse(
    db
      .prepare("SELECT rules_json FROM character_rolls WHERE id=?")
      .get(rolled.rollId).rules_json,
  );
  delete terms.soulmateReclaimVersion;
  delete rolled.soulmateReclaimVersion;
  db.prepare("UPDATE character_rolls SET rules_json=? WHERE id=?").run(
    JSON.stringify(terms),
    rolled.rollId,
  );
  db.prepare(
    "UPDATE affection_requests SET outcome_json=? WHERE source_key='roll:1:100'",
  ).run(JSON.stringify(rolled));
  publish(db, rolled);
  assert.equal(reclaim(db).status, "reclaimed");
  assert.equal(getAffectionTotal(db, "1", "101", first), 0);
  assert.equal(getAffectionTotal(db, "1", "202", foreign), 20);
});

for (const corruption of [
  "missing-request-marker",
  "missing-roll-marker",
  "unknown-version",
  "wrong-owner",
  "wrong-roller",
  "incomplete-appearance",
  "missing-roll-id",
  "wrong-delivery",
]) {
  test(`corrupt marked reclaim fails atomically: ${corruption}`, (t) => {
    const db = fixture(t),
      rolled = reserve(db);
    publish(db, rolled);
    const rollId = rolled.rollId;
    const terms = JSON.parse(
      db
        .prepare("SELECT rules_json FROM character_rolls WHERE id=?")
        .get(rolled.rollId).rules_json,
    );
    if (corruption === "missing-request-marker")
      delete rolled.soulmateReclaimVersion;
    if (corruption === "missing-roll-marker")
      delete terms.soulmateReclaimVersion;
    if (corruption === "unknown-version") terms.soulmateReclaimVersion = 2;
    if (corruption === "wrong-owner") rolled.escapeOwnerId = "999";
    if (corruption === "missing-roll-id") delete rolled.rollId;
    if (corruption === "wrong-delivery")
      db.exec("UPDATE roll_delivery SET message_id='999'");
    if (corruption === "wrong-roller")
      db.exec("UPDATE affection_requests SET user_id='999'");
    if (corruption === "incomplete-appearance")
      db.exec(
        "UPDATE affection_contexts SET state='captured',completed_at=NULL",
      );
    db.prepare("UPDATE character_rolls SET rules_json=? WHERE id=?").run(
      JSON.stringify(terms),
      rollId,
    );
    db.prepare(
      "UPDATE affection_requests SET outcome_json=? WHERE source_key='roll:1:100'",
    ).run(JSON.stringify(rolled));
    assert.throws(() => reclaim(db), /reclaim|affection|delivery/i);
    assert.equal(
      db.prepare("SELECT state FROM character_rolls WHERE id=?").get(rollId)
        .state,
      "open",
    );
    assert.equal(getAffectionTotal(db, "1", "101", first), 0);
    assert.equal(getAffectionTotal(db, "1", "202", foreign), 0);
    assert.equal(
      db.prepare("SELECT count(*) n FROM affection_entitlements").get().n,
      0,
    );
  });
}

for (const ending of ["expired", "canceled", "protected"])
  test(`${ending} escape earns no reclaim bonus`, (t) => {
    const db = fixture(t),
      rolled = reserve(db);
    publish(db, rolled);
    if (ending === "canceled")
      db.prepare(
        "DELETE FROM marriages WHERE guild_id='1' AND character_id=?",
      ).run(foreign);
    const result = claimRoll(db, {
      guildId: "1",
      channelId: "10",
      messageId: "500",
      userId: ending === "protected" ? "303" : "202",
      now: ending === "expired" ? now + 120_002 : now + 2,
    });
    assert.notEqual(result.status, "reclaimed");
    assert.equal(getAffectionTotal(db, "1", "101", first), 0);
  });
