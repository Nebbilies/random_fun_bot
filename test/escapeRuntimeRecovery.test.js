import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCatalog, transaction } from "../lib/catalogDb.js";
import { migrateCharacterIdentities } from "../lib/characterIdentityMigration.js";
import { initializeCatalogReleaseSchema } from "../lib/catalogReleaseSchema.js";
import {
  reserveRoll,
  publishRoll,
  recoverRolls,
  getRoll,
  claimRoll,
} from "../lib/characterRolls.js";
import {
  recoverOpenEscapes,
  startForcedEscape,
} from "../lib/characterRollRuntime.js";
import { sirensCall } from "../lib/items/sirensCall.js";
import { getMarriage } from "../lib/characterMarriage.js";
import { executeItemUse } from "../commands/use.js";
import { addItemToInventory, getInventory } from "../lib/itemStorage.js";

const start = 10_000;
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "escape-recovery-"));
  const file = join(dir, "catalog.sqlite");
  let db = openCatalog(file);
  db.exec(`INSERT INTO characters(id,rank,favourites,name_full,image_url,anime_titles,gender)
    VALUES(1,1,123,'Original','https://example.invalid/original.png','["Original show"]','Female');
    INSERT INTO character_identities SELECT id,name_full,image_url FROM characters;`);
  migrateCharacterIdentities(db, { dryRun: false, targetVersion: 11 });
  initializeCatalogReleaseSchema(db);
  const id = db.prepare("SELECT id FROM characters").get().id;
  db.prepare(
    `INSERT INTO marriages(guild_id,character_id,owner_id,married_at) VALUES('1',?,'101','original')`,
  ).run(id);
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    get db() {
      return db;
    },
    id,
    reopen() {
      db.close();
      db = new DatabaseSync(file);
      db.exec("PRAGMA foreign_keys=ON");
      return db;
    },
  };
}
function clock(time) {
  let value = time,
    sequence = 0;
  const timers = new Map();
  return {
    now: () => value,
    setTimer(callback, delay) {
      const key = ++sequence;
      timers.set(key, { callback, at: value + delay });
      return key;
    },
    clearTimer(key) {
      timers.delete(key);
    },
    get deadlines() {
      return [...timers.values()].map((x) => x.at).sort((a, b) => a - b);
    },
    async advance(to) {
      value = to;
      for (let i = 0; i < 30; i++) {
        const due = [...timers].find(([, timer]) => timer.at <= value);
        if (!due) return;
        timers.delete(due[0]);
        await due[1].callback();
      }
      throw new Error("Timer loop");
    },
  };
}
function discord(error = null) {
  const edits = [];
  let fetches = 0;
  const message = {
    id: "500",
    guildId: "1",
    channelId: "10",
    edit: async (payload) =>
      edits.push(JSON.stringify(payload.components.map((c) => c.toJSON()))),
  };
  return {
    edits,
    message,
    get fetches() {
      return fetches;
    },
    client: {
      channels: {
        fetch: async () => ({
          messages: {
            fetch: async (id) => {
              fetches++;
              assert.equal(id, "500");
              if (error) {
                const e = error;
                error = null;
                throw e;
              }
              return message;
            },
          },
        }),
      },
    },
  };
}
function ordinary(db) {
  const roll = reserveRoll(db, {
    guildId: "1",
    channelId: "10",
    commandMessageId: "100",
    userId: "101",
    pool: "w",
    now: start,
    random: () => 0,
  });
  assert.equal(roll.status, "reserved");
  assert.equal(publishRoll(db, roll.rollId, "500", start), true);
}
async function siren(db) {
  addItemToInventory(db, "1", "102", "sirens_call");
  const directive = executeItemUse(db, "1", "102", "siren", ["101"], {
    channelId: "10",
    random: () => 0,
    now: start,
  }).escapeAttempt;
  assert.deepEqual(getInventory(db, "1", "102"), []);
  const fake = discord(),
    c = clock(start);
  assert.equal(
    (
      await startForcedEscape({
        db,
        ...directive,
        guildId: "1",
        channelId: "10",
        channel: { send: async () => fake.message },
        ...c,
      })
    ).status,
    "started",
  );
}
const roll = (db) => getRoll(db, "1", "10", "500");

for (const kind of ["ordinary", "siren"]) {
  for (const offset of [20_000, 70_000, 120_000]) {
    test(`${kind}: file reopen at ${offset}ms preserves terms and deadlines, settles and rearms without reroll`, async (t) => {
      const f = fixture(t);
      if (kind === "siren") await siren(f.db);
      else ordinary(f.db);
      const original = roll(f.db),
        marriage = getMarriage(f.db, "1", f.id);
      f.db
        .exec(`UPDATE characters SET name_full='Edited',rank=999,favourites=9999;
        INSERT INTO game_config_overrides(scope_id,key,value_json) VALUES('1','windows.escapeProtectionMs','90000');`);
      const db = f.reopen(),
        fake = discord(),
        c = clock(start + offset);
      recoverRolls(db, c.now());
      assert.equal(roll(db).state, "open");
      const result = await recoverOpenEscapes(db, fake.client, c);
      assert.equal(
        result[0].status,
        offset >= 120_000 ? "settled" : "recovered",
      );
      assert.match(fake.edits[0], /Original/);
      assert.doesNotMatch(fake.edits[0], /Edited|#999/);
      assert.equal(roll(db).protectedUntil, original.protectedUntil);
      assert.equal(roll(db).expiresAt, original.expiresAt);
      assert.deepEqual(getMarriage(db, "1", f.id), marriage);
      if (offset < 60_000) {
        assert.deepEqual(c.deadlines, [original.protectedUntil]);
        assert.equal(
          claimRoll(db, {
            guildId: "1",
            channelId: "10",
            messageId: "500",
            userId: "102",
            now: c.now(),
          }).status,
          "protected",
        );
        await c.advance(original.protectedUntil);
        assert.match(fake.edits.at(-1), /Anyone can now marry/);
      }
      if (offset < 120_000) {
        assert.deepEqual(c.deadlines, [original.expiresAt]);
        const count = fake.fetches;
        await recoverOpenEscapes(db, fake.client, c);
        assert.equal(fake.fetches, count); // no duplicate updater/timer
        await c.advance(original.expiresAt);
      }
      assert.equal(roll(db).escapeOutcome, "expired");
      assert.match(fake.edits.at(-1), /Expired/);
      assert.deepEqual(c.deadlines, []);
      assert.equal(
        db.prepare("SELECT COUNT(*) AS n FROM character_rolls").get().n,
        1,
      );
      assert.deepEqual(getMarriage(db, "1", f.id), marriage);
    });
  }
}

test("replacement marriage cancels on recovery without changing replacement or allowance", async (t) => {
  const f = fixture(t);
  ordinary(f.db);
  f.db.exec("DELETE FROM marriages");
  f.db
    .prepare(
      `INSERT INTO marriages(guild_id,character_id,owner_id,married_at) VALUES('1',?,'101','replacement')`,
    )
    .run(f.id);
  const replacement = getMarriage(f.db, "1", f.id),
    db = f.reopen(),
    fake = discord();
  await recoverOpenEscapes(db, fake.client, clock(start + 30_000));
  assert.equal(roll(db).escapeOutcome, "canceled");
  assert.deepEqual(getMarriage(db, "1", f.id), replacement);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM claim_allowances").get().n,
    0,
  );
  assert.match(fake.edits[0], /Canceled/);
});

test("transient fetch retries the original bound attempt, including overdue settlement", async (t) => {
  const f = fixture(t);
  ordinary(f.db);
  const db = f.reopen();
  const c = clock(start + 119_000),
    fake = discord(new Error("temporary network failure"));
  assert.equal(
    (await recoverOpenEscapes(db, fake.client, c))[0].status,
    "retrying",
  );
  assert.equal(roll(db).state, "open");
  assert.deepEqual(c.deadlines, [start + 124_000]);
  await recoverOpenEscapes(db, fake.client, c);
  assert.equal(fake.fetches, 1);
  await c.advance(start + 124_000);
  assert.equal(fake.fetches, 2);
  assert.equal(roll(db).escapeOutcome, "expired");
  assert.match(fake.edits[0], /Expired/);
  assert.deepEqual(c.deadlines, []);
});

test("Discord 10008 ends an inaccessible attempt, preserving ownership and spent costs", async (t) => {
  const f = fixture(t);
  await siren(f.db);
  const marriage = getMarriage(f.db, "1", f.id),
    db = f.reopen();
  const c = clock(start + 20_000),
    fake = discord(
      Object.assign(new Error("Unknown Message"), { code: 10008 }),
    );
  assert.equal(
    (await recoverOpenEscapes(db, fake.client, c))[0].status,
    "missing",
  );
  assert.equal(roll(db).state, "failed");
  assert.deepEqual(c.deadlines, []);
  assert.deepEqual(getMarriage(db, "1", f.id), marriage);
});

for (const snapshot of [null, "{}"]) {
  test(`legacy or corrupt bound snapshot (${snapshot}) explicitly cancels without Discord`, async (t) => {
    const f = fixture(t);
    ordinary(f.db);
    f.db
      .prepare("UPDATE character_rolls SET character_snapshot_json=?")
      .run(snapshot);
    const db = f.reopen(),
      fake = discord();
    await recoverOpenEscapes(db, fake.client, clock(start + 20_000));
    assert.equal(roll(db).escapeOutcome, "canceled");
    assert.equal(fake.fetches, 0);
  });
}

test("Siren charge failure rolls back effective reservation and captured windows", (t) => {
  const f = fixture(t),
    db = f.db;
  addItemToInventory(db, "1", "102", "sirens_call");
  db.exec(`CREATE TRIGGER reject_siren_cost BEFORE DELETE ON user_inventory
    BEGIN SELECT RAISE(ABORT, 'cost failure'); END;`);
  assert.throws(
    () =>
      executeItemUse(db, "1", "102", "siren", ["101"], {
        channelId: "10",
        random: () => 0,
        now: start,
      }),
    /cost failure/,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM character_rolls").get().n,
    0,
  );
  assert.equal(getInventory(db, "1", "102").length, 1);
});

test("Siren captures windows at reservation, not delivery; missing rules fail without mutation", async (t) => {
  const f = fixture(t),
    db = f.db;
  const directive = transaction(db, () =>
    sirensCall.execute({
      db,
      guildId: "1",
      userId: "102",
      channelId: "10",
      args: ["101"],
      random: () => 0,
      now: start,
    }),
  ).escapeAttempt;
  const rules = db
    .prepare("SELECT rules_json FROM character_rolls")
    .get().rules_json;
  assert.equal(JSON.parse(rules).escapeProtectionMs, 60_000);
  db.exec(
    `INSERT INTO game_config_overrides(scope_id,key,value_json) VALUES('1','windows.escapeProtectionMs','90000');`,
  );
  const fake = discord(),
    c = clock(start);
  const options = {
    db,
    ...directive,
    guildId: "1",
    channelId: "10",
    channel: { send: async () => fake.message },
    ...c,
  };
  db.exec("UPDATE character_rolls SET rules_json=NULL");
  const before = db.prepare("SELECT * FROM character_rolls").all();
  await assert.rejects(startForcedEscape(options), /captured escape rules/);
  assert.deepEqual(db.prepare("SELECT * FROM character_rolls").all(), before);
  db.prepare("UPDATE character_rolls SET rules_json=?").run(rules);
  await startForcedEscape(options);
  assert.equal(roll(db).protectedUntil, start + 60_000);
  assert.equal(roll(db).expiresAt, start + 120_000);
});
