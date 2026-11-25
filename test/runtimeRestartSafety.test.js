import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFinalCatalog,
  openCatalog,
  openCatalogReadOnly,
} from "../lib/catalogDb.js";
import { reserveRoll, publishRoll, claimRoll } from "../lib/characterRolls.js";
import {
  recoverForcedEscapes,
  recoverOpenEscapes,
} from "../lib/characterRollRuntime.js";
import { recoverPendingRollDeliveries } from "../lib/rollDelivery.js";
import {
  assertCatalogRuntimeRestartReady,
  inspectCatalogRuntimeRestart,
} from "../lib/catalogRuntimeRecovery.js";
import { addItemToInventory, getInventory } from "../lib/itemStorage.js";
import { executeItemUseById } from "../commands/use.js";
import {
  startItemAction,
  onItemActionInteraction,
} from "../lib/itemActionRuntime.js";

// Synthetic final-v12 files only. Normal openers exercise the real schema guard;
// no legacy migration, default catalog, real Discord client, or startup orchestration.
const ID = "12345678-1234-4123-8123-123456789abc";
const NOW = 1_800_000_000_000;
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "restart-safety-r2-"));
  const file = join(dir, "synthetic.sqlite");
  let db = createFinalCatalog(file);
  db.prepare(
    "INSERT INTO character_identities(id,creation_method) VALUES (?,'manual')",
  ).run(ID);
  db.prepare(
    `INSERT INTO characters(id,rank,favourites,tie_order,likes_source,name_full,gender,image_url)
    VALUES (?,1,2000,1,'generated','Original','Female','https://example.invalid/original.png')`,
  ).run(ID);
  const timers = new Map();
  let sequence = 0;
  const clock = {
    now: () => NOW,
    setTimer(fn, delay) {
      const id = ++sequence;
      timers.set(id, { fn, delay });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
  };
  t.mock.method(Date, "now", clock.now);
  t.mock.method(globalThis, "setTimeout", clock.setTimer);
  t.mock.method(globalThis, "clearTimeout", clock.clearTimer);
  t.mock.method(globalThis, "setInterval", () => ({ unref() {} }));
  const sent = [],
    cards = new Map();
  let reactionFailures = 0,
    reactions = 0;
  const channel = {
    id: "10",
    guildId: "1",
    messages: {
      async fetch(id) {
        assert.ok(cards.has(id), `unknown fake message ${id}`);
        return cards.get(id);
      },
    },
    async send(payload) {
      const card = {
        id: String(500 + sent.length),
        guildId: "1",
        channelId: "10",
        channel,
        payload,
        edits: [],
        reactions: { cache: new Map() },
        async edit(change) {
          this.edits.push(change);
          return this;
        },
        async react(emoji) {
          reactions++;
          assert.equal(emoji, "❤️");
          if (reactionFailures > 0) {
            reactionFailures--;
            throw Error("transient reaction transport");
          }
          this.reactions.cache.set(emoji, { me: true });
        },
      };
      sent.push(card);
      cards.set(card.id, card);
      return card;
    },
  };
  const client = {
    channels: {
      async fetch(id) {
        assert.equal(id, "10");
        return channel;
      },
    },
  };
  t.after(() => {
    timers.clear();
    if (db.isOpen) db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    get db() {
      return db;
    },
    clock,
    channel,
    client,
    sent,
    get reactions() {
      return reactions;
    },
    failReactions(n) {
      reactionFailures = n;
    },
    reopen(readOnly = false) {
      timers.clear();
      db.close();
      db = (readOnly ? openCatalogReadOnly : openCatalog)(file);
    },
  };
}
function rows(db) {
  return db
    .prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")
    .all()
    .map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}"`).all()]);
}
function reserve(f) {
  const r = reserveRoll(f.db, {
    guildId: "1",
    channelId: "10",
    commandMessageId: "100",
    userId: "101",
    pool: "w",
    now: NOW,
    random: () => 0.5,
  });
  assert.equal(r.status, "reserved");
  return r.rollId;
}
function marry(f) {
  f.db
    .prepare(
      "INSERT INTO marriages(guild_id,character_id,owner_id,married_at) VALUES ('1',?,'202','original')",
    )
    .run(ID);
  return f.db.prepare("SELECT * FROM marriages").get();
}
function siren(f) {
  const item = addItemToInventory(f.db, "1", "101", "sirens_call").item;
  const result = executeItemUseById(f.db, "1", "101", item.id, ["202"], {
    channelId: "10",
    now: NOW,
    random: () => 0,
  });
  assert.equal(result.success, true);
  return result.escapeAttempt.pendingRollId;
}
const roll = (f) => f.db.prepare("SELECT * FROM character_rolls").get();
const whistles = (f) =>
  getInventory(f.db, "1", "202").filter((i) => i.item_id === "golden_whistle");
async function recover(f) {
  assertCatalogRuntimeRestartReady(f.db);
  await recoverPendingRollDeliveries(f.db, f.client, { now: f.clock.now });
  await recoverForcedEscapes(f.db, f.client);
  await recoverOpenEscapes(f.db, f.client, f.clock);
}

for (const source of [
  "ordinary-pending",
  "ordinary-open",
  "siren-pending",
  "siren-open",
]) {
  test(`${source}: crash before passive whistle seals once, charges once and preserves exact marriage`, async (t) => {
    const f = fixture(t),
      marriage = marry(f);
    addItemToInventory(f.db, "1", "202", "golden_whistle", 3);
    if (source.startsWith("siren")) siren(f);
    else reserve(f);
    if (source.endsWith("-open")) {
      // Crash boundary is publication committed, passive effect not yet called.
      const card = await f.channel.send({ content: "original escape card" });
      assert.equal(publishRoll(f.db, roll(f).id, card.id, NOW), true);
    }
    const snapshot = roll(f).character_snapshot_json,
      rules = roll(f).rules_json;
    f.reopen();
    await recover(f);
    assert.equal(roll(f).escape_outcome, "reclaimed");
    assert.equal(whistles(f)[0].charges, 2);
    assert.deepEqual(f.db.prepare("SELECT * FROM marriages").get(), marriage);
    assert.equal(
      f.db.prepare("SELECT count(*) n FROM claim_allowances").get().n,
      0,
    );
    assert.equal(roll(f).character_snapshot_json, snapshot);
    assert.equal(roll(f).rules_json, rules);
    if (source.startsWith("siren"))
      assert.deepEqual(getInventory(f.db, "1", "101"), []);
    else
      assert.equal(
        f.db.prepare("SELECT used FROM roll_allowances").get().used,
        1,
      );
    const committed = rows(f.db),
      sends = f.sent.length;
    assert.equal(
      f.sent.filter((c) =>
        (typeof c.payload === "string"
          ? c.payload
          : c.payload?.content
        )?.includes("Golden Whistle"),
      ).length,
      1,
    );
    if (!source.startsWith("siren"))
      assert.ok(
        f.sent.some((card) =>
          card.edits.some((edit) => JSON.stringify(edit).includes("Reclaimed")),
        ),
        "recovered ordinary escapes must refresh even across interrupted delivery acknowledgement",
      );
    await recover(f);
    f.reopen();
    await recover(f);
    assert.deepEqual(rows(f.db), committed);
    assert.equal(f.sent.length, sends);
  });
}

test("whistle charge failure rolls reclaim back; recovered open retry commits both once", async (t) => {
  const f = fixture(t),
    marriage = marry(f);
  reserve(f);
  addItemToInventory(f.db, "1", "202", "golden_whistle", 3);
  const card = await f.channel.send({ content: "escape" });
  publishRoll(f.db, roll(f).id, card.id, NOW);
  f.reopen();
  f.db
    .exec(`CREATE TRIGGER reject_whistle BEFORE UPDATE OF charges ON user_inventory
    BEGIN SELECT RAISE(ABORT,'injected whistle charge failure'); END`);
  const before = rows(f.db);
  assert.equal(
    (await recoverOpenEscapes(f.db, f.client, f.clock))[0].status,
    "retrying",
  );
  assert.deepEqual(rows(f.db), before);
  assert.equal(roll(f).state, "open");
  assert.equal(whistles(f)[0].charges, 3);
  // Drop test-only fault before the normal schema-validated reopen.
  f.db.exec("DROP TRIGGER reject_whistle");
  f.reopen();
  await recover(f);
  assert.equal(roll(f).escape_outcome, "reclaimed");
  assert.equal(whistles(f)[0].charges, 2);
  assert.deepEqual(f.db.prepare("SELECT * FROM marriages").get(), marriage);
});

for (const [name, update] of [
  ["NULL expiry", "expires_at=NULL"],
  ["fractional expiry", "expires_at=published_at+0.5"],
  ["wrong positive expiry", "expires_at=expires_at+1"],
  ["unknown roll state", "state='unrecognized_paid_state'"],
])
  test(`${name}: read-only guard refuses without mutations, refunds or ownership changes`, (t) => {
    const f = fixture(t),
      id = reserve(f);
    publishRoll(f.db, id, "500", NOW);
    f.db.exec(`UPDATE character_rolls SET ${update}`);
    f.reopen(true);
    const before = rows(f.db);
    const code =
      name === "unknown roll state"
        ? "unknown_runtime_state"
        : "invalid_claim_terms";
    assert.ok(
      inspectCatalogRuntimeRestart(f.db).blockers.some((b) => b.code === code),
    );
    assert.throws(() => assertCatalogRuntimeRestartReady(f.db), {
      code: "CATALOG_RUNTIME_RECOVERY_REQUIRED",
    });
    assert.deepEqual(rows(f.db), before);
    f.reopen();
    assert.deepEqual(rows(f.db), before);
    if (name === "NULL expiry" || name === "fractional expiry") {
      assert.throws(
        () =>
          claimRoll(f.db, {
            guildId: "1",
            channelId: "10",
            messageId: "500",
            userId: "303",
            now: NOW,
          }),
        /Invalid durable claim deadline/,
      );
      assert.deepEqual(rows(f.db), before);
    }
  });

test("two Golden Hours, same command: one reset, one cost, one captured vault across reopen", (t) => {
  const f = fixture(t);
  reserve(f);
  const first = addItemToInventory(f.db, "1", "101", "golden_hour").item;
  const second = addItemToInventory(f.db, "1", "101", "golden_hour").item;
  const options = { channelId: "10", commandMessageId: "700", now: NOW };
  const original = executeItemUseById(f.db, "1", "101", first.id, [], options);
  assert.equal(original.success, true);
  const receipt = f.db
    .prepare("SELECT * FROM affection_invocations WHERE invocation_id=?")
    .get("item-use:700");
  assert.equal(receipt.kind, "manual_item");
  assert.equal(JSON.parse(receipt.result_json).inventoryId, first.id);
  assert.equal(f.db.prepare("SELECT used FROM roll_allowances").get().used, 0);
  assert.equal(getInventory(f.db, "1", "101").length, 1);
  // Activity after the first reset must not be reset by the duplicate invocation.
  f.db.exec("UPDATE roll_allowances SET used=4");
  f.reopen();
  const before = rows(f.db);
  const again = executeItemUseById(f.db, "1", "101", second.id, [], {
    ...options,
    random: () => {
      throw Error("replay must not draw");
    },
  });
  assert.deepEqual(again, original);
  for (const [guildId, userId, channelId] of [
    ["2", "101", "10"],
    ["1", "202", "10"],
    ["1", "101", "20"],
  ]) {
    assert.throws(
      () =>
        executeItemUseById(f.db, guildId, userId, second.id, [], {
          ...options,
          channelId,
        }),
      /scope/i,
    );
  }
  assert.deepEqual(rows(f.db), before);
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM vault_sessions").get().n,
    1,
  );
  assert.equal(f.db.prepare("SELECT used FROM roll_allowances").get().used, 4);
  assert.equal(getInventory(f.db, "1", "101")[0].id, second.id);
});

test("transient heart failure is retried by the actual recovery sweep for a bound open roll", async (t) => {
  const f = fixture(t);
  reserve(f);
  f.reopen();
  f.failReactions(1);
  await recoverPendingRollDeliveries(f.db, f.client, { now: f.clock.now });
  assert.equal(roll(f).state, "open");
  assert.equal(f.reactions, 1);
  assert.equal(f.sent[0].reactions.cache.has("❤️"), false);
  const before = rows(f.db),
    messageId = roll(f).message_id;
  f.reopen();
  await recoverPendingRollDeliveries(f.db, f.client, { now: f.clock.now });
  assert.equal(f.reactions, 2);
  assert.equal(f.sent[0].reactions.cache.get("❤️").me, true);
  await recoverPendingRollDeliveries(f.db, f.client, { now: f.clock.now });
  assert.equal(
    f.reactions,
    2,
    "already-present bot reaction is not added again",
  );
  assert.equal(f.sent.length, 1);
  assert.equal(roll(f).message_id, messageId);
  assert.deepEqual(rows(f.db), before);
});

test("valid canceled item action remains restartable", async (t) => {
  const f = fixture(t);
  const item = addItemToInventory(f.db, "1", "101", "kaimetsu").item;
  const message = {
    id: "800",
    guildId: "1",
    channelId: "10",
    channel: f.channel,
    author: { id: "101" },
    reply: (payload) => f.channel.send(payload),
  };
  const action = await startItemAction({
    db: f.db,
    message,
    inventoryId: item.id,
  });
  const interaction = {
    customId: `item:${action.id}:cancel`,
    guildId: "1",
    channelId: "10",
    message: f.sent[0],
    user: { id: "101" },
    client: f.client,
    isButton: () => true,
    async deferUpdate() {},
    async reply() {},
    async followUp() {},
  };
  await onItemActionInteraction(f.db, interaction);
  assert.equal(
    f.db.prepare("SELECT state FROM item_actions").get().state,
    "canceled",
  );
  f.reopen(true);
  const before = rows(f.db);
  const report = inspectCatalogRuntimeRestart(f.db);
  assert.deepEqual(rows(f.db), before);
  assert.equal(report.ready, true, JSON.stringify(report.blockers));
});
