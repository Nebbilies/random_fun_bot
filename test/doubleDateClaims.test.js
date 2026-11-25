import assert from "node:assert/strict";
import { test } from "node:test";
import { openCatalog } from "../lib/catalogDb.js";
import {
  claimRoll,
  getClaimAvailability,
  publishRoll,
  reserveRoll,
} from "../lib/characterRolls.js";
import { doubleDate } from "../lib/items/doubleDate.js";
import { addActiveBuff } from "../lib/itemStorage.js";
import { getConfigView, saveConfigSection } from "../lib/gameConfig.js";
import { getResolvedItemDefinition } from "../lib/itemRoster.js";

const now = Date.parse("2026-10-15T17:30:00Z");
function fixture(t, cooldown = true) {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  for (let id = 1; id <= 4; id++)
    db.prepare(
      "INSERT INTO characters(id,rank,favourites,name_full,gender) VALUES(?,?,?,?,?)",
    ).run(id, id, 100 - id, `Character ${id}`, "Female");
  if (cooldown) {
    db.prepare("INSERT INTO claim_allowances VALUES(?,?,?)").run(
      "1",
      "101",
      Math.floor((now + 7 * 3600000) / (3 * 3600000)),
    );
    db.prepare("INSERT INTO claim_events VALUES(?,?,?)").run(
      "1",
      "101",
      now - 1000,
    );
  }
  return db;
}
function card(db, index, at = now) {
  const roll = reserveRoll(db, {
    guildId: "1",
    channelId: "10",
    commandMessageId: String(100 + index),
    userId: "102",
    pool: "w",
    now: at,
    random: () => index / 4,
    prankEnabled: false,
    vaultEnabled: false,
  });
  publishRoll(db, roll.rollId, String(200 + index), at);
  return {
    guildId: "1",
    channelId: "10",
    messageId: String(200 + index),
    userId: "101",
    now: at,
  };
}
function claimState(db) {
  return ["claim_allowances", "claim_events"].map((table) =>
    db.prepare(`SELECT * FROM ${table}`).all(),
  );
}

for (const cooldown of [true, false])
  test(`Double Date grants exactly two free claims, normal cooldown=${cooldown}`, (t) => {
    const db = fixture(t, cooldown);
    const before = claimState(db);
    doubleDate.execute({ db, guildId: "1", userId: "101", now });
    assert.equal(getClaimAvailability(db, "1", "101", now).canClaim, true);
    for (let i = 0; i < 2; i++) {
      assert.equal(claimRoll(db, card(db, i)).status, "married");
      assert.deepEqual(claimState(db), before);
    }
    assert.equal(
      claimRoll(db, card(db, 2)).status,
      cooldown ? "exhausted" : "married",
    );
  });

test("Double Date takes priority over other claim tokens and failed claims spend nothing", (t) => {
  const db = fixture(t);
  addActiveBuff(db, "1", "101", "crown_of_the_sovereign", "{}", null, 3);
  addActiveBuff(db, "1", "101", "pinata_claim_token", "{}", null, 1);
  doubleDate.execute({ db, guildId: "1", userId: "101", now });
  addActiveBuff(
    db,
    "1",
    "101",
    "engagement_ring",
    JSON.stringify({ cooldownMultiplier: 0.5 }),
    null,
    3,
  );
  const ringBefore = db
    .prepare("SELECT * FROM active_user_buffs WHERE buff_id='engagement_ring'")
    .get();
  const request = card(db, 0);
  assert.equal(claimRoll(db, request).status, "married");
  assert.deepEqual(
    db
      .prepare(
        "SELECT * FROM active_user_buffs WHERE buff_id='engagement_ring'",
      )
      .get(),
    ringBefore,
  );
  assert.equal(claimRoll(db, request).status, "closed");
  assert.equal(
    db
      .prepare(
        "SELECT remaining_rolls FROM active_user_buffs WHERE buff_id='double_date'",
      )
      .get().remaining_rolls,
    1,
  );
  assert.equal(
    db
      .prepare(
        "SELECT remaining_rolls FROM active_user_buffs WHERE buff_id='crown_of_the_sovereign'",
      )
      .get().remaining_rolls,
    3,
  );
  assert.equal(
    db
      .prepare(
        "SELECT remaining_rolls FROM active_user_buffs WHERE buff_id='pinata_claim_token'",
      )
      .get().remaining_rolls,
    1,
  );
});

test("configured Double Date count and duration are captured and described", (t) => {
  const db = fixture(t);
  saveConfigSection(db, {
    guildId: "1",
    section: "itemEffects",
    expectedRevision: getConfigView(db, "1").revision,
    values: {
      "itemEffects.double_date.freeClaims": 3,
      "itemEffects.double_date.durationMs": 120000,
    },
  });
  assert.match(
    getResolvedItemDefinition(db, "1", "double_date").description.replace(
      /\*/g,
      "",
    ),
    /3 free claim tokens for 2 minutes/,
  );
  for (const invalid of [0, -1, 1.5])
    assert.throws(() =>
      saveConfigSection(db, {
        guildId: "1",
        section: "itemEffects",
        expectedRevision: getConfigView(db, "1").revision,
        values: { "itemEffects.double_date.freeClaims": invalid },
      }),
    );
  doubleDate.execute({ db, guildId: "1", userId: "101", now });
  saveConfigSection(db, {
    guildId: "1",
    section: "itemEffects",
    expectedRevision: getConfigView(db, "1").revision,
    values: { "itemEffects.double_date.freeClaims": 1 },
  });
  for (let i = 0; i < 3; i++)
    assert.equal(claimRoll(db, card(db, i)).status, "married");
  assert.equal(getClaimAvailability(db, "1", "101", now).canClaim, false);
});

test("legacy timed Double Date is bounded on first successful claim", (t) => {
  const db = fixture(t);
  addActiveBuff(
    db,
    "1",
    "101",
    "double_date",
    JSON.stringify({ durationMs: 600000 }),
    now + 600000,
    null,
  );
  for (let i = 0; i < 2; i++)
    assert.equal(claimRoll(db, card(db, i)).status, "married");
  assert.equal(getClaimAvailability(db, "1", "101", now).canClaim, false);
});

test("failed marriage transaction preserves both free claims", (t) => {
  const db = fixture(t);
  doubleDate.execute({ db, guildId: "1", userId: "101", now });
  const request = card(db, 0);
  db.exec(
    "CREATE TRIGGER reject_marriage BEFORE INSERT ON marriages BEGIN SELECT RAISE(ABORT,'injected'); END;",
  );
  assert.throws(() => claimRoll(db, request), /injected/);
  assert.equal(
    db
      .prepare(
        "SELECT remaining_rolls FROM active_user_buffs WHERE buff_id='double_date'",
      )
      .get().remaining_rolls,
    2,
  );
  db.exec("DROP TRIGGER reject_marriage");
  assert.equal(claimRoll(db, request).status, "married");
});

test("failure after free-claim debit rolls back the counter and marriage", (t) => {
  const db = fixture(t);
  doubleDate.execute({ db, guildId: "1", userId: "101", now });
  const request = card(db, 0);
  db.exec(
    "CREATE TRIGGER reject_close BEFORE UPDATE OF state ON character_rolls WHEN NEW.state='closed' BEGIN SELECT RAISE(ABORT,'late failure'); END;",
  );
  assert.throws(() => claimRoll(db, request), /late failure/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM marriages").get().n, 0);
  assert.equal(
    db
      .prepare(
        "SELECT remaining_rolls FROM active_user_buffs WHERE buff_id='double_date'",
      )
      .get().remaining_rolls,
    2,
  );
});

test("Double Date expires at ten minutes even with unused free claims", (t) => {
  const db = fixture(t);
  doubleDate.execute({ db, guildId: "1", userId: "101", now });
  assert.equal(
    getClaimAvailability(db, "1", "101", now + 600000).canClaim,
    false,
  );
  assert.equal(claimRoll(db, card(db, 0, now + 600000)).status, "exhausted");
});

test("normal claim is spent before Crown and Pinata tokens; tokens only pay during cooldown", (t) => {
  const db = fixture(t, false);
  addActiveBuff(db, "1", "101", "crown_of_the_sovereign", "{}", null, 1);
  addActiveBuff(db, "1", "101", "pinata_claim_token", "{}", null, 1);
  assert.equal(claimRoll(db, card(db, 0)).status, "married");
  const normalHistory = claimState(db);
  assert.equal(normalHistory[0].length, 1);
  assert.equal(
    db
      .prepare(
        "SELECT remaining_rolls FROM active_user_buffs WHERE buff_id='crown_of_the_sovereign'",
      )
      .get().remaining_rolls,
    1,
  );
  assert.equal(
    db
      .prepare(
        "SELECT remaining_rolls FROM active_user_buffs WHERE buff_id='pinata_claim_token'",
      )
      .get().remaining_rolls,
    1,
  );
  assert.equal(claimRoll(db, card(db, 1)).status, "married");
  assert.equal(
    db
      .prepare(
        "SELECT id FROM active_user_buffs WHERE buff_id='crown_of_the_sovereign'",
      )
      .get(),
    undefined,
  );
  assert.deepEqual(claimState(db), normalHistory);
  assert.equal(claimRoll(db, card(db, 2)).status, "married");
  assert.equal(
    db
      .prepare(
        "SELECT id FROM active_user_buffs WHERE buff_id='pinata_claim_token'",
      )
      .get(),
    undefined,
  );
  assert.deepEqual(claimState(db), normalHistory);
  assert.equal(claimRoll(db, card(db, 3)).status, "exhausted");
});

test("Double Date stays ahead of an available normal claim and saved Crown tokens", (t) => {
  const db = fixture(t, false);
  addActiveBuff(db, "1", "101", "crown_of_the_sovereign", "{}", null, 1);
  doubleDate.execute({ db, guildId: "1", userId: "101", now });
  const initial = claimState(db);
  for (let i = 0; i < 2; i++) {
    assert.equal(claimRoll(db, card(db, i)).status, "married");
    assert.deepEqual(claimState(db), initial);
  }
  assert.equal(claimRoll(db, card(db, 2)).status, "married");
  assert.equal(
    db
      .prepare(
        "SELECT remaining_rolls FROM active_user_buffs WHERE buff_id='crown_of_the_sovereign'",
      )
      .get().remaining_rolls,
    1,
  );
  assert.equal(claimRoll(db, card(db, 3)).status, "married");
  assert.equal(
    db
      .prepare(
        "SELECT id FROM active_user_buffs WHERE buff_id='crown_of_the_sovereign'",
      )
      .get(),
    undefined,
  );
});
