import test from "node:test";
import assert from "node:assert/strict";
import { createFinalCatalog, openCatalog } from "../lib/catalogDb.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { armCupidsMisfire } from "../lib/items/cupidsMisfire.js";
import { addActiveBuff, getActiveBuffs } from "../lib/itemStorage.js";
import { marryCharacter, getMarriage } from "../lib/characterMarriage.js";
import {
  reserveRoll,
  publishRoll,
  claimRoll,
  getClaimStatus,
  recoverRolls,
} from "../lib/characterRolls.js";
import {
  deliverReservedRoll,
  recoverPendingRollDeliveries,
} from "../lib/rollDelivery.js";
import { rollCard } from "../lib/characterRollRuntime.js";
import { registerPendingTransfer } from "../lib/characterAvailability.js";
import { getGameConfig } from "../lib/gameConfig.js";
import { setGuildRates } from "../lib/guildRates.js";
import { executeItemUseById } from "../lib/itemActivation.js";

const id = "12345678-1234-4123-8123-123456789abc";
const now = 1_800_000_000_000;
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "misfire-"));
  const path = join(dir, "catalog.sqlite");
  let db = createFinalCatalog(path);
  db.prepare(
    "INSERT INTO character_identities(id,creation_method) VALUES (?,'manual')",
  ).run(id);
  db.prepare(
    `INSERT INTO characters(id,rank,favourites,tie_order,likes_source,name_full,gender)
    VALUES (?,1,2000,1,'generated','Cupid Target','female')`,
  ).run(id);
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    get db() {
      return db;
    },
    reopen() {
      db.close();
      db = openCatalog(path);
    },
  };
}
function inventory(db, item, user = "101", guild = "1", charges = 1) {
  return Number(
    db
      .prepare(
        `INSERT INTO user_inventory(guild_id,user_id,item_id,charges,acquired_at,expires_at)
    VALUES (?,?,?,?,?,?)`,
      )
      .run(guild, user, item, charges, new Date(now).toISOString(), now + 1000)
      .lastInsertRowid,
  );
}
function arm(db) {
  return armCupidsMisfire(db, {
    guildId: "1",
    userId: "101",
    inventoryId: inventory(db, "cupids_misfire"),
    now,
  });
}
function reserve(db, extra = {}) {
  return reserveRoll(db, {
    guildId: "1",
    channelId: "10",
    commandMessageId: "100",
    userId: "101",
    pool: "w",
    now,
    random: () => 0,
    ...extra,
  });
}
const armed = (db) =>
  getActiveBuffs(db, "1", "101", now).some(
    (b) => b.buff_id === "cupids_misfire",
  );

test("atomic arming rejects duplicate without cost, survives expiry/restart, scoped by guild/user", (t) => {
  const f = fixture(t);
  const db = f.db;
  const source = inventory(db, "cupids_misfire");
  assert.equal(
    executeItemUseById(db, "1", "101", source, [], { now }).success,
    true,
  );
  assert.equal(
    db.prepare("SELECT * FROM user_inventory WHERE id=?").get(source),
    undefined,
  );
  const second = inventory(db, "cupids_misfire");
  assert.equal(
    armCupidsMisfire(db, {
      guildId: "1",
      userId: "101",
      inventoryId: second,
      now,
    }).status,
    "already_armed",
  );
  assert.equal(
    db.prepare("SELECT charges FROM user_inventory WHERE id=?").get(second)
      .charges,
    1,
  );
  assert.equal(getActiveBuffs(db, "2", "101", now).length, 0);
  assert.equal(getActiveBuffs(db, "1", "102", now).length, 0);
  f.reopen();
  assert.equal(
    getActiveBuffs(f.db, "1", "101", now + 999999999)[0].expires_at,
    null,
  );
});

for (const owner of ["202"])
  test(`divorce opponent bypasses protection/own Shield, skips mystery, normal claim`, (t) => {
    const { db } = fixture(t);
    marryCharacter(db, "1", id, owner, now);
    inventory(db, "mirror_shield", "101");
    db.prepare(
      "INSERT INTO character_protection_locks VALUES ('1',?,'temporary',?)",
    ).run(id, now + 100000);
    const marriage = getMarriage(db, "1", id);
    db.prepare("INSERT INTO counterfeit_crowns VALUES (?,?,?,?,?)").run(
      "1",
      owner,
      id,
      marriage.id,
      "crown",
    );
    arm(db);
    const r = reserve(db, {
      mystery: {
        eventChannelId: "20",
        selectEvent: () => assert.fail("no mystery"),
      },
    });
    assert.equal(r.cupidsMisfire.result, "divorced");
    assert.equal(r.escapeOwnerId, null);
    assert.equal(
      db
        .prepare("SELECT mystery_session_id FROM character_rolls WHERE id=?")
        .get(r.rollId).mystery_session_id,
      null,
    );
    assert.equal(getMarriage(db, "1", id), null);
    assert.equal(
      db.prepare("SELECT * FROM counterfeit_crowns").get(),
      undefined,
    );
    assert.equal(armed(db), false);
    assert.equal(
      db
        .prepare(
          "SELECT charges FROM user_inventory WHERE item_id='mirror_shield'",
        )
        .get().charges,
      1,
    );
    assert.equal(
      db.prepare("SELECT former_owner_id FROM character_ownership_losses").get()
        .former_owner_id,
      owner,
    );
    assert.equal(reserve(db).status, "duplicate");
    assert.equal(publishRoll(db, r.rollId, "500", now), true);
    const publicRoll = db
      .prepare(
        "SELECT protected_until,exclusive_user_id FROM character_rolls WHERE id=?",
      )
      .get(r.rollId);
    assert.equal(publicRoll.protected_until, null);
    assert.equal(publicRoll.exclusive_user_id, null);
    assert.equal(
      claimRoll(db, {
        guildId: "1",
        channelId: "10",
        messageId: "500",
        userId: owner,
        now,
      }).status,
      "married",
    );
    assert.equal(getClaimStatus(db, "1", owner, now).canClaim, false);
  });

test("own appearance leaves armed Misfire and ownership untouched instead of self-divorcing", (t) => {
  const { db } = fixture(t);
  marryCharacter(db, "1", id, "101", now);
  arm(db);
  const r = reserve(db, {
    mystery: {
      eventChannelId: "20",
      selectEvent: () => assert.fail("no mystery"),
    },
  });
  assert.equal(r.ownAppearance, true);
  assert.equal(r.cupidsMisfire, null);
  assert.equal(armed(db), true);
  assert.equal(getMarriage(db, "1", id).ownerId, "101");
  assert.equal(publishRoll(db, r.rollId, "500", now), true);
  assert.equal(
    claimRoll(db, {
      guildId: "1",
      channelId: "10",
      messageId: "500",
      userId: "101",
      now,
    }).status,
    "closed",
  );
});

test("opposing Shield spends exactly one charge and effect, retains normal owner reclaim", (t) => {
  const { db } = fixture(t);
  marryCharacter(db, "1", id, "202", now);
  const shield = inventory(db, "mirror_shield", "202", "1", 2);
  arm(db);
  const r = reserve(db);
  assert.equal(r.cupidsMisfire.result, "blocked");
  assert.equal(r.escapeOwnerId, "202");
  assert.equal(
    db.prepare("SELECT charges FROM user_inventory WHERE id=?").get(shield)
      .charges,
    1,
  );
  assert.equal(armed(db), false);
  assert.ok(getMarriage(db, "1", id));
  publishRoll(db, r.rollId, "500", now);
  assert.equal(
    claimRoll(db, {
      guildId: "1",
      channelId: "10",
      messageId: "500",
      userId: "202",
      now,
    }).status,
    "reclaimed",
  );
  assert.equal(getClaimStatus(db, "1", "202", now).canClaim, true);
});

test("unowned, busy transfer and soulbound selections preserve effect and Shield", (t) => {
  const { db } = fixture(t);
  arm(db);
  const r = reserve(db);
  assert.equal(r.cupidsMisfire, null);
  assert.ok(armed(db));
  db.prepare("UPDATE character_rolls SET state='closed'").run();
  marryCharacter(db, "1", id, "202", now);
  inventory(db, "mirror_shield", "202");
  registerPendingTransfer(db, "transfer", "1", [id], now + 10000);
  assert.equal(reserve(db, { commandMessageId: "101" }).status, "empty");
  assert.ok(armed(db));
  db.prepare(
    "INSERT INTO character_protection_locks VALUES ('1',?,'soulbind',NULL)",
  ).run(id);
  assert.equal(reserve(db, { commandMessageId: "102" }).status, "empty");
  assert.equal(
    db
      .prepare(
        "SELECT charges FROM user_inventory WHERE item_id='mirror_shield'",
      )
      .get().charges,
    1,
  );
});

test("roll persistence failure rolls divorce, effect and selection buffs back together", (t) => {
  const { db } = fixture(t);
  marryCharacter(db, "1", id, "202", now);
  arm(db);
  addActiveBuff(db, "1", "101", "four_leaf_clover", null, null, 3);
  db.exec(
    "CREATE TRIGGER fail_roll BEFORE INSERT ON character_rolls BEGIN SELECT RAISE(ABORT,'injected'); END",
  );
  assert.throws(() => reserve(db), /injected/);
  assert.ok(getMarriage(db, "1", id));
  assert.ok(armed(db));
  assert.equal(
    getActiveBuffs(db, "1", "101", now).find(
      (b) => b.buff_id === "four_leaf_clover",
    ).remaining_rolls,
    3,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM character_ownership_losses").get().n,
    0,
  );
});

test("failed send/restart retries committed divorce with immutable notice and one initial owner ping", async (t) => {
  const f = fixture(t);
  marryCharacter(f.db, "1", id, "202", now);
  arm(f.db);
  const r = reserve(f.db);
  f.reopen();
  recoverRolls(f.db, now);
  const channel = {
    id: "10",
    guildId: "1",
    send: async () => {
      throw new Error("transport");
    },
  };
  await assert.rejects(
    deliverReservedRoll(f.db, null, { rollId: r.rollId, channel }),
    /transport/,
  );
  f.reopen();
  let sends = 0;
  channel.send = async (payload) => {
    sends++;
    assert.deepEqual(payload.allowedMentions.users, []); // ambiguous prior attempt cannot ping twice
    assert.match(JSON.stringify(payload), /forcibly divorced/);
    assert.doesNotMatch(JSON.stringify(payload), /tries to leave/);
    return { id: "500" };
  };
  channel.messages = { fetch: async () => ({ react: async () => {} }) };
  const client = { channels: { fetch: async () => channel } };
  assert.equal(
    (
      await deliverReservedRoll(f.db, client, {
        rollId: r.rollId,
        channel,
        now: () => now,
      })
    ).status,
    "published",
  );
  f.reopen();
  await recoverPendingRollDeliveries(f.db, client, { now: () => now });
  assert.equal(sends, 1);
  assert.equal(getMarriage(f.db, "1", id), null);
  assert.equal(armed(f.db), false);
  const edited = rollCard(
    r.character,
    null,
    6,
    null,
    { userIds: ["202"], ping: false },
    r.cupidsMisfire,
  );
  assert.deepEqual(edited.allowedMentions.users, []);
  assert.match(JSON.stringify(edited), /forcibly divorced/);
  const initial = rollCard(
    r.character,
    null,
    6,
    null,
    { userIds: ["202"] },
    { ...r.cupidsMisfire, ping: true },
  );
  assert.deepEqual(initial.allowedMentions.users, ["202"]);
});

for (const kind of ["prank", "vault", "mystery"])
  test(`${kind} leaves armed effect waiting`, (t) => {
    const { db } = fixture(t);
    arm(db);
    const rules = getGameConfig(db, "1");
    let r;
    if (kind === "prank") {
      setGuildRates(db, "1", { prankRate: 1 });
      r = reserve(db, { prankEnabled: true });
    } else if (kind === "vault") {
      setGuildRates(db, "1", { vaultRate: 1 });
      r = reserve(db, {
        vaultEnabled: true,
        gameConfig: { ...rules, vault: { ...rules.vault, enabled: true } },
      });
    } else {
      r = reserve(db, {
        gameConfig: { ...rules, mystery: { ...rules.mystery, enabled: true } },
        mystery: {
          eventChannelId: "20",
          selectEvent: () => ({
            eventId: "test",
            durationMs: 10000,
            state: {},
          }),
        },
      });
    }
    assert.equal(r.status, kind);
    assert.ok(armed(db));
  });

test("arming failure rolls effect back without spending inventory", (t) => {
  const { db } = fixture(t);
  const source = inventory(db, "cupids_misfire");
  db.exec(
    "CREATE TRIGGER reject_buff BEFORE INSERT ON active_user_buffs BEGIN SELECT RAISE(ABORT,'no buff'); END",
  );
  assert.throws(
    () =>
      armCupidsMisfire(db, {
        guildId: "1",
        userId: "101",
        inventoryId: source,
        now,
      }),
    /no buff/,
  );
  assert.equal(armed(db), false);
  assert.equal(
    db.prepare("SELECT charges FROM user_inventory WHERE id=?").get(source)
      .charges,
    1,
  );
});

test("roll persistence failure also restores opposing Shield charge", (t) => {
  const { db } = fixture(t);
  marryCharacter(db, "1", id, "202", now);
  arm(db);
  const shield = inventory(db, "mirror_shield", "202");
  db.exec(
    "CREATE TRIGGER fail_roll BEFORE INSERT ON character_rolls BEGIN SELECT RAISE(ABORT,'injected'); END",
  );
  assert.throws(() => reserve(db), /injected/);
  assert.equal(
    db.prepare("SELECT charges FROM user_inventory WHERE id=?").get(shield)
      .charges,
    1,
  );
  assert.ok(armed(db));
  assert.ok(getMarriage(db, "1", id));
});

test("Crown never redirects to another decoy or consumes the unrelated Crown", (t) => {
  const { db } = fixture(t);
  const decoy = "12345678-1234-4123-8123-123456789abd";
  db.prepare(
    "INSERT INTO character_identities(id,creation_method) VALUES (?,'manual')",
  ).run(decoy);
  db.prepare(
    `INSERT INTO characters(id,rank,favourites,tie_order,likes_source,name_full,gender)
    VALUES (?,2,1000,2,'generated','Decoy','male')`,
  ).run(decoy);
  marryCharacter(db, "1", id, "202", now);
  marryCharacter(db, "1", decoy, "202", now);
  db.prepare("INSERT INTO counterfeit_crowns VALUES (?,?,?,?,?)").run(
    "1",
    "202",
    decoy,
    getMarriage(db, "1", decoy).id,
    "crown",
  );
  arm(db);
  const r = reserve(db);
  assert.equal(r.character.id, id);
  assert.equal(getMarriage(db, "1", id), null);
  assert.ok(getMarriage(db, "1", decoy));
  assert.ok(db.prepare("SELECT * FROM counterfeit_crowns").get());
});

test("Shield-blocked notice is above escape, deduplicates initial owner mentions and survives silent edits", (t) => {
  const { db } = fixture(t);
  marryCharacter(db, "1", id, "202", now);
  inventory(db, "mirror_shield", "202");
  arm(db);
  const r = reserve(db);
  const escape = {
    phase: "protected",
    ownerId: "202",
    protectedUntil: now + 60000,
    ping: true,
  };
  const card = rollCard(
    r.character,
    null,
    6,
    escape,
    { userIds: ["202"] },
    { ...r.cupidsMisfire, ping: true },
  );
  assert.deepEqual(card.allowedMentions.users, ["202"]);
  assert.match(card.components[0].toJSON().content, /Misfire blocked/);
  assert.match(card.components[1].toJSON().content, /tries to leave/);
  const edit = rollCard(
    r.character,
    null,
    6,
    { ...escape, ping: false, outcome: "reclaimed" },
    { userIds: ["202"], ping: false },
    r.cupidsMisfire,
  );
  assert.deepEqual(edit.allowedMentions.users, []);
  assert.match(JSON.stringify(edit), /Misfire blocked/);
});
