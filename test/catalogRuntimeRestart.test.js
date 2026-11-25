import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  createFinalCatalog,
  openCatalog,
  openCatalogReadOnly,
} from "../lib/catalogDb.js";
import {
  runRoll,
  onRollReaction,
  recoverRollRuntime,
  recoverForcedEscapes,
  startForcedEscape,
  recoverOpenEscapes,
} from "../lib/characterRollRuntime.js";
import {
  reserveRoll,
  getRollStatus,
  getMysterySession,
  loadRollCharacterSnapshot,
} from "../lib/characterRolls.js";
import {
  reserveMysteryAwareRoll,
  MYSTERY_ROSTER,
} from "../lib/mysteryCoordinator.js";
import {
  startMysteryRoll,
  onMysteryButton,
  onMysteryAnswer,
  cancelMysteryRuntime,
  recoverMysteryRuntime,
} from "../lib/mysteryRuntime.js";
import {
  startItemAction,
  onItemActionInteraction,
  recoverItemActionRuntime,
} from "../lib/itemActionRuntime.js";
import { getItemAction } from "../lib/itemActionStorage.js";
import { activateItemAction, updateItemSelection } from "../lib/itemActions.js";
import { addItemToInventory, getInventory } from "../lib/itemStorage.js";
import { executeItemUseById } from "../commands/use.js";
import { revealVaultReward } from "../lib/vaultRewards.js";
import { recoverVaultRewards } from "../lib/vaultRuntime.js";
import { recoverPendingRollDeliveries } from "../lib/rollDelivery.js";
import {
  startTrade,
  onTradeAnswer,
  cancelTransfer,
} from "../lib/tradeRuntime.js";
import {
  inspectCatalogRuntimeRestart,
  assertCatalogRuntimeRestartReady,
} from "../lib/catalogRuntimeRecovery.js";

// Actual authoritative final schema, never defaultDB, legacy release-v12 DDL, or
// a raw DatabaseSync reopen. New connection identities discard WeakMap runtimes.
// Explicitly discard fake timers at crash; do NOT run graceful cancellation first.
const IDS = [1, 2, 3, 4].map(
  (n) => `12345678-1234-4123-8123-${String(n).padStart(12, "0")}`,
);
function clock(start = 1_800_000_000_000) {
  let current = start;
  const timers = new Map();
  let serial = 0;
  return {
    now: () => current,
    setTimer(fn, delay) {
      const id = ++serial;
      timers.set(id, { fn, at: current + delay });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    crash() {
      timers.clear();
    },
    pending: () => timers.size,
    async advance(at) {
      for (;;) {
        const due = [...timers]
          .filter(([, timer]) => timer.at <= at)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        current = due[1].at;
        await due[1].fn();
      }
      current = at;
    },
  };
}
function discord() {
  const sent = [],
    messages = new Map();
  const channel = {
    id: "10",
    guildId: "1",
    sent,
    messages: {
      async fetch(id) {
        if (!messages.has(id))
          throw Object.assign(Error("missing"), { code: 10008 });
        return messages.get(id);
      },
    },
    async send(payload) {
      const card = {
        id: String(500 + sent.length),
        guildId: "1",
        channelId: "10",
        channel,
        payload,
        embeds: payload.embeds ?? [],
        components: payload.components ?? [],
        edits: [],
        async react() {},
        async edit(change) {
          this.edits.push(change);
          this.payload = change;
          this.embeds = change.embeds ?? this.embeds;
          this.components = change.components ?? this.components;
          return this;
        },
      };
      sent.push(card);
      messages.set(card.id, card);
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
  const message = (id = "100", userId = "101", content = "") => ({
    id,
    guildId: "1",
    channelId: "10",
    author: { id: userId },
    channel,
    client,
    content,
    reply: (payload) => channel.send(payload),
    guild: { members: { cache: new Map([["202", { id: "202" }]]) } },
  });
  function click(customId, card, userId = "101") {
    const replies = [];
    const interaction = {
      customId,
      message: card,
      guildId: "1",
      channelId: "10",
      user: { id: userId },
      client,
      replies,
      isButton: () => true,
      async deferReply() {},
      async editReply(text) {
        replies.push(text);
      },
      async deferUpdate() {
        this.deferred = true;
      },
      async reply(data) {
        replies.push(data);
      },
      async followUp(data) {
        replies.push(data);
      },
    };
    return interaction;
  }
  return { channel, client, message, click, sent };
}
function fixture(t, count = 1) {
  const directory = mkdtempSync(join(tmpdir(), "catalog-runtime-restart-"));
  const path = join(directory, "synthetic.sqlite");
  let db = createFinalCatalog(path);
  for (let i = 0; i < count; i++) {
    db.prepare(
      "INSERT INTO character_identities(id,creation_method) VALUES (?,'manual')",
    ).run(IDS[i]);
    db.prepare(
      `INSERT INTO characters(id,rank,favourites,tie_order,likes_source,name_full,gender,anime_titles,image_url)
      VALUES (?,?,?,?,'generated',?,'Female','["Original show"]','https://example.invalid/original.png')`,
    ).run(IDS[i], i + 1, 1234 - i, i + 1, `Original ${i + 1}`);
  }
  const time = clock();
  t.mock.method(Date, "now", time.now);
  // Item runtime has no clock injection; fake only its background sweeper, never
  // let a closed pre-crash DB be touched. Recovery is explicitly invoked below.
  t.mock.method(globalThis, "setInterval", () => ({ unref() {} }));
  t.after(() => {
    time.crash();
    if (db.isOpen) db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    get db() {
      return db;
    },
    path,
    time,
    ...discord(),
    reopen(readOnly = false) {
      time.crash();
      db.close();
      db = (readOnly ? openCatalogReadOnly : openCatalog)(path);
      return db;
    },
  };
}
function terms(f, rollId) {
  return loadRollCharacterSnapshot(f.db, rollId);
}
function rows(db) {
  return db
    .prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")
    .all()
    .map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}"`).all()]);
}
function marry(f, index, owner = "202") {
  const result = f.db
    .prepare(
      "INSERT INTO marriages(guild_id,character_id,owner_id,married_at) VALUES ('1',?,?,?)",
    )
    .run(IDS[index], owner, new Date(f.time.now()).toISOString());
  return {
    characterId: IDS[index],
    marriageId: Number(result.lastInsertRowid),
    ownerId: owner,
  };
}
async function heart(f, card, userId = "202") {
  await onRollReaction(
    { catalogDb: f.db },
    { emoji: { name: "❤️" }, message: card },
    { id: userId },
  );
}
const codes = (f) =>
  inspectCatalogRuntimeRestart(f.db).blockers.map((b) => b.code);

for (const interruption of [
  "reservation",
  "channel-fetch",
  "intro-send",
  "intro-ack",
  "legacy-capture",
]) {
  test(`unbound mystery ${interruption} survives real reopen and retries without recharging`, async (t) => {
    const f = fixture(t);
    const eventDraw =
      (MYSTERY_ROSTER.findIndex((e) => e.id === "doors") + 0.1) /
      MYSTERY_ROSTER.length;
    const draws = [0, 0, eventDraw][Symbol.iterator]();
    const r = reserveMysteryAwareRoll(f.db, {
      guildId: "1",
      channelId: "10",
      commandMessageId: "100",
      userId: "101",
      pool: "w",
      now: f.time.now(),
      mysteryEnabled: true,
      random: () => draws.next().value,
    });
    assert.equal(r.status, "mystery");
    const allowance = f.db.prepare("SELECT * FROM roll_allowances").all();
    const snapshot = terms(f, r.rollId);
    const send = f.channel.send;
    let lock;
    t.mock.method(f.channel, "send", async (payload) => {
      if (interruption === "intro-send")
        throw new Error("intro transport failed");
      const sent = await send(payload);
      if (interruption === "intro-ack") {
        lock = new DatabaseSync(f.path);
        lock.exec("BEGIN IMMEDIATE");
      }
      return sent;
    });
    const fetch = f.client.channels.fetch;
    if (interruption === "channel-fetch")
      t.mock.method(f.client.channels, "fetch", async () => {
        throw new Error("channel unavailable");
      });
    if (!["reservation", "legacy-capture"].includes(interruption)) {
      try {
        await assert.rejects(
          startMysteryRoll({
            db: f.db,
            client: f.client,
            message:
              interruption === "channel-fetch"
                ? { ...f.message(), channelId: "99" }
                : f.message(),
            reservation: r,
            ...f.time,
          }),
          /failed|unavailable|locked/,
        );
      } finally {
        if (lock) {
          lock.exec("ROLLBACK");
          lock.close();
        }
      }
    }
    if (interruption === "legacy-capture") {
      const state = JSON.parse(getMysterySession(f.db, r.sessionId).stateJson);
      state.runtime = { version: 1, phase: "reserved", remaining: r.remaining };
      f.db
        .prepare("UPDATE mystery_sessions SET state_json=? WHERE id=?")
        .run(JSON.stringify(state), r.sessionId);
    }
    f.channel.send.mock.restore();
    if (f.client.channels.fetch !== fetch)
      f.client.channels.fetch.mock.restore();
    // Model Discord's best-effort nonce deduplication after send-before-ack.
    t.mock.method(f.channel, "send", async (payload) => {
      const prior =
        payload.enforceNonce &&
        f.sent.find((m) => m.payload.nonce === payload.nonce);
      return prior || send(payload);
    });
    f.reopen(true);
    const before = rows(f.db);
    assert.doesNotThrow(() => assertCatalogRuntimeRestartReady(f.db));
    assert.deepEqual(rows(f.db), before, "preflight remains read-only");
    f.reopen();
    const recovered = await recoverMysteryRuntime({
      db: f.db,
      client: f.client,
      ...f.time,
    });
    assert.deepEqual(recovered.blockers, []);
    assert.deepEqual(recovered.deferred, []);
    assert.deepEqual(recovered.recovered, [r.sessionId]);
    assert.equal(f.sent.length, 1, "one canonical intro across retry");
    assert.ok(f.sent[0].payload.nonce);
    assert.equal(f.sent[0].payload.enforceNonce, true);
    assert.deepEqual(
      f.db.prepare("SELECT * FROM roll_allowances").all(),
      allowance,
    );
    assert.deepEqual(terms(f, r.rollId), snapshot);
    await f.time.advance(getMysterySession(f.db, r.sessionId).nextAt);
    assert.equal(getMysterySession(f.db, r.sessionId).state, "running");
  });
}

for (const lockedCleanup of [false, true])
  test(`mystery intro failure preserves paid state and original error; competing writer=${lockedCleanup}`, async (t) => {
    const f = fixture(t);
    const failure = new Error("original Discord send failure");
    let lock;
    t.mock.method(f.channel, "send", async () => {
      if (lockedCleanup) {
        lock = new DatabaseSync(f.path);
        lock.exec("BEGIN IMMEDIATE");
      }
      throw failure;
    });
    const eventDraw =
      (MYSTERY_ROSTER.findIndex((e) => e.id === "doors") + 0.1) /
      MYSTERY_ROSTER.length;
    const draws = [0.5, 0, 0, eventDraw][Symbol.iterator]();
    try {
      await assert.rejects(
        runRoll(
          {
            message: f.message(),
            yoshiko: {
              catalogDb: f.db,
              client: f.client,
              mysteryEnabled: true,
              vaultEnabled: false,
            },
          },
          "w",
          () => draws.next().value,
          f.time,
        ),
        (error) => error === failure,
      );
    } finally {
      if (lock) {
        lock.exec("ROLLBACK");
        lock.close();
      }
    }
    assert.equal(getMysterySession(f.db, 1).state, "reserved");
    assert.equal(
      f.db.prepare("SELECT state FROM character_rolls").get().state,
      "pending",
    );
    assert.doesNotThrow(() => assertCatalogRuntimeRestartReady(f.db));
  });

test("overlapping intro startup and periodic recovery share delivery and timer", async (t) => {
  const f = fixture(t);
  const draws = [0, 0, 0][Symbol.iterator]();
  const r = reserveMysteryAwareRoll(f.db, {
    guildId: "1",
    channelId: "10",
    commandMessageId: "100",
    userId: "101",
    pool: "w",
    now: f.time.now(),
    mysteryEnabled: true,
    random: () => draws.next().value,
  });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const send = f.channel.send;
  t.mock.method(f.channel, "send", async (payload) => {
    await gate;
    return send(payload);
  });
  const startup = startMysteryRoll({
    db: f.db,
    client: f.client,
    message: f.message(),
    reservation: r,
    ...f.time,
  });
  const recovery = recoverMysteryRuntime({
    db: f.db,
    client: f.client,
    ...f.time,
  });
  release();
  await startup;
  assert.deepEqual((await recovery).recovered, [r.sessionId]);
  assert.equal(f.sent.length, 1);
  assert.equal(f.time.pending(), 1);
});

test("unbound intro transport failure defers without blocking startup and retries later", async (t) => {
  const f = fixture(t);
  const draws = [0, 0, 0][Symbol.iterator]();
  const r = reserveMysteryAwareRoll(f.db, {
    guildId: "1",
    channelId: "10",
    commandMessageId: "100",
    userId: "101",
    pool: "w",
    now: f.time.now(),
    mysteryEnabled: true,
    random: () => draws.next().value,
  });
  const before = rows(f.db);
  const send = f.channel.send;
  t.mock.method(f.channel, "send", async () => {
    throw new Error("Discord unavailable");
  });
  for (let i = 0; i < 2; i++) {
    const report = await recoverMysteryRuntime({
      db: f.db,
      client: f.client,
      ...f.time,
    });
    assert.deepEqual(report.blockers, []);
    assert.equal(report.deferred[0].sessionId, r.sessionId);
    assert.deepEqual(rows(f.db), before);
    assert.doesNotThrow(() => assertCatalogRuntimeRestartReady(f.db));
  }
  f.channel.send.mock.restore();
  const report = await recoverMysteryRuntime({
    db: f.db,
    client: f.client,
    ...f.time,
  });
  assert.deepEqual(report.recovered, [r.sessionId]);
  assert.equal(f.sent.length, 1);
});

for (const corruption of [
  "runtime",
  "remaining",
  "deadline",
  "partial-binding",
  "phase",
]) {
  test(`unbound mystery ${corruption} corruption remains a read-only blocker`, (t) => {
    const f = fixture(t);
    const draws = [0, 0, 0][Symbol.iterator]();
    const r = reserveMysteryAwareRoll(f.db, {
      guildId: "1",
      channelId: "10",
      commandMessageId: "100",
      userId: "101",
      pool: "w",
      now: f.time.now(),
      mysteryEnabled: true,
      random: () => draws.next().value,
    });
    const state = JSON.parse(getMysterySession(f.db, r.sessionId).stateJson);
    if (corruption === "runtime") delete state.runtime;
    if (corruption === "remaining") state.runtime.remaining = -1;
    if (corruption === "phase") state.runtime.phase = "running";
    f.db
      .prepare("UPDATE mystery_sessions SET state_json=? WHERE id=?")
      .run(JSON.stringify(state), r.sessionId);
    if (corruption === "deadline")
      f.db.exec("UPDATE mystery_sessions SET deadline_at=started_at");
    if (corruption === "partial-binding")
      f.db.exec("UPDATE mystery_sessions SET event_message_id='500'");
    const before = rows(f.db);
    assert.throws(
      () => assertCatalogRuntimeRestartReady(f.db),
      /mystery_runtime_missing/,
    );
    assert.deepEqual(rows(f.db), before);
  });
}

// Behavioral acceptance: a read-only ready preflight must be followed by real
// coordinator recovery, preserving paid terms, bindings, deadlines and costs.
test("normal final-v12 startup/readOnly is non-mutating; published ordinary reaction settles once with captured UUID terms", async (t) => {
  const f = fixture(t);
  await runRoll(
    {
      message: f.message(),
      yoshiko: {
        catalogDb: f.db,
        mysteryEnabled: false,
        imagePicker: {
          pick: async () => ({ url: "https://example.invalid/original.png" }),
        },
      },
    },
    "w",
    () => 0.5,
    f.time,
  );
  const roll = f.db.prepare("SELECT * FROM character_rolls").get();
  const snapshot = terms(f, roll.id);
  assert.equal(roll.state, "open");
  assert.equal(snapshot.id, IDS[0]);
  f.db.exec("UPDATE characters SET name_full='Edited',favourites=99");
  f.reopen(true);
  const bytes = readFileSync(f.path),
    before = rows(f.db);
  assert.equal(f.db.prepare("PRAGMA user_version").get().user_version, 12);
  assert.equal(f.db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  assert.equal(assertCatalogRuntimeRestartReady(f.db).ready, true);
  assert.deepEqual(terms(f, roll.id), snapshot);
  assert.throws(() => f.db.exec("DELETE FROM character_rolls"), /readonly/);
  assert.deepEqual(rows(f.db), before);
  f.reopen();
  assert.deepEqual(readFileSync(f.path), bytes);
  assert.equal(recoverRollRuntime(f.db), 1);
  await heart(f, f.sent[0]);
  await heart(f, f.sent[0], "303");
  const marriages = f.db
    .prepare("SELECT character_id,owner_id FROM marriages")
    .all();
  assert.deepEqual(
    marriages.map((r) => [r.character_id, r.owner_id]),
    [[IDS[0], "202"]],
  );
  assert.match(f.sent[1].payload.content, /Original 1/);
  assert.deepEqual(terms(f, roll.id), snapshot);
  f.reopen();
  assert.equal(recoverRollRuntime(f.db), 0);
  await heart(f, f.sent[0]);
  assert.equal(f.db.prepare("SELECT count(*) n FROM marriages").get().n, 1);
});

test("ordinary pending crash: preflight allows durable delivery; recovery publishes once without charging again", async (t) => {
  const f = fixture(t);
  const r = reserveRoll(f.db, {
    guildId: "1",
    channelId: "10",
    commandMessageId: "100",
    userId: "101",
    pool: "w",
    now: f.time.now(),
    random: () => 0.5,
  });
  assert.equal(r.status, "reserved");
  const snapshot = terms(f, r.rollId);
  const remaining = getRollStatus(f.db, "1", "101", f.time.now()).remaining;
  f.reopen(true);
  const before = rows(f.db),
    bytes = readFileSync(f.path);
  assert.equal(assertCatalogRuntimeRestartReady(f.db).ready, true);
  assert.ok(
    inspectCatalogRuntimeRestart(f.db).recoverable.some(
      (work) => work.kind === "ordinary_delivery" && work.id === r.rollId,
    ),
  );
  assert.deepEqual(codes(f), []);
  assert.deepEqual(rows(f.db), before);
  f.reopen();
  assert.deepEqual(readFileSync(f.path), bytes);
  assert.equal(recoverRollRuntime(f.db), 0);
  assert.equal(
    f.db.prepare("SELECT state FROM character_rolls").get().state,
    "pending",
  );
  await recoverPendingRollDeliveries(f.db, f.client, { now: f.time.now });
  assert.equal(
    f.db.prepare("SELECT state FROM character_rolls").get().state,
    "open",
  );
  await recoverPendingRollDeliveries(f.db, f.client, { now: f.time.now });
  assert.equal(f.sent.length, 1);
  await heart(f, f.sent[0]);
  assert.equal(
    f.db.prepare("SELECT character_id FROM marriages").get().character_id,
    IDS[0],
  );
  assert.equal(
    getRollStatus(f.db, "1", "101", f.time.now()).remaining,
    remaining,
  );
  assert.deepEqual(terms(f, r.rollId), snapshot);
});

for (const corruption of ["missing", "presentation"])
  test(`ordinary pending ${corruption} delivery terms block without mutations or guessed refunds`, async (t) => {
    const f = fixture(t);
    reserveRoll(f.db, {
      guildId: "1",
      channelId: "10",
      commandMessageId: "100",
      userId: "101",
      pool: "w",
      now: f.time.now(),
      random: () => 0.5,
    });
    if (corruption === "missing") f.db.exec("DELETE FROM roll_delivery");
    else f.db.exec(`UPDATE roll_delivery SET presentation_json='{}'`);
    f.reopen(true);
    const before = rows(f.db);
    assert.throws(
      () => assertCatalogRuntimeRestartReady(f.db),
      /ordinary_delivery_pending/,
    );
    assert.deepEqual(rows(f.db), before);
    f.reopen();
    const result = await recoverPendingRollDeliveries(f.db, f.client, {
      now: f.time.now,
    });
    assert.equal(
      result[0].status,
      corruption === "missing" ? "legacy" : "pending",
    );
    assert.deepEqual(rows(f.db), before);
    assert.equal(f.sent.length, 0);
  });

for (const phase of ["reserved", "running", "countdown", "claim_open"]) {
  test(`mystery ${phase} crash: recovery resumes captured phase and canonical claim without recharging`, async (t) => {
    const f = fixture(t);
    const eventDraw =
      (MYSTERY_ROSTER.findIndex((e) => e.id === "doors") + 0.1) /
      MYSTERY_ROSTER.length;
    const draws = [0, 0, eventDraw][Symbol.iterator]();
    const r = reserveMysteryAwareRoll(f.db, {
      guildId: "1",
      channelId: "10",
      commandMessageId: "100",
      userId: "101",
      pool: "w",
      now: f.time.now(),
      mysteryEnabled: true,
      random: () => draws.next().value,
    });
    assert.equal(r.status, "mystery");
    await startMysteryRoll({
      db: f.db,
      client: f.client,
      message: f.message(),
      reservation: r,
      ...f.time,
      random: () => 0,
    });
    if (phase !== "reserved")
      await f.time.advance(getMysterySession(f.db, r.sessionId).nextAt);
    if (["countdown", "claim_open"].includes(phase)) {
      await onMysteryButton(
        f.db,
        f.click(`mystery:${r.sessionId}:door:1`, f.sent.at(-1)),
      );
      if (phase === "claim_open")
        await f.time.advance(getMysterySession(f.db, r.sessionId).nextAt);
    }
    assert.equal(getMysterySession(f.db, r.sessionId).state, phase);
    assert.ok(f.time.pending());
    const snapshot = terms(f, r.rollId),
      remaining = getRollStatus(f.db, "1", "101", f.time.now()).remaining;
    const last = f.sent.at(-1),
      sent = f.sent.length;
    const deadline = getMysterySession(f.db, r.sessionId).nextAt;
    f.db.exec(
      "UPDATE characters SET name_full='Edited after mystery',favourites=1",
    );
    f.reopen();
    assert.equal(f.time.pending(), 0);
    assert.equal(assertCatalogRuntimeRestartReady(f.db).ready, true);
    const before = rows(f.db);
    const stale = f.click(
      `mystery:${r.sessionId}:${phase === "claim_open" ? "decline" : "door:1"}`,
      last,
    );
    assert.equal(await onMysteryButton(f.db, stale), true);
    assert.match(stale.replies[0], /expired|no longer available/);
    assert.equal(
      await onMysteryAnswer(f.db, f.message("101", "101", "answer")),
      false,
    );
    assert.deepEqual(rows(f.db), before);
    const recovered = await recoverMysteryRuntime({
      db: f.db,
      client: f.client,
      ...f.time,
      random: () => 0,
    });
    assert.deepEqual(recovered.recovered, [r.sessionId]);
    assert.deepEqual(recovered.deferred, []);
    recoverRollRuntime(f.db);
    assert.equal(getMysterySession(f.db, r.sessionId).state, phase);
    assert.equal(getMysterySession(f.db, r.sessionId).nextAt, deadline);
    assert.ok(f.time.pending());
    if (phase === "reserved")
      await f.time.advance(getMysterySession(f.db, r.sessionId).nextAt);
    if (["reserved", "running"].includes(phase)) {
      await onMysteryButton(
        f.db,
        f.click(`mystery:${r.sessionId}:door:1`, f.sent.at(-1)),
      );
    }
    if (phase !== "claim_open")
      await f.time.advance(getMysterySession(f.db, r.sessionId).nextAt);
    assert.equal(getMysterySession(f.db, r.sessionId).state, "claim_open");
    const prizeId = f.db
      .prepare("SELECT message_id FROM character_rolls WHERE id=?")
      .get(r.rollId).message_id;
    const prize = await f.channel.messages.fetch(prizeId);
    assert.match(JSON.stringify(prize.payload), /Original 1/);
    assert.doesNotMatch(JSON.stringify(prize.payload), /Edited after mystery/);
    await heart(f, prize, "101");
    await heart(f, prize, "101");
    assert.equal(f.db.prepare("SELECT count(*) n FROM marriages").get().n, 1);
    assert.equal(
      getRollStatus(f.db, "1", "101", f.time.now()).remaining,
      remaining,
    );
    assert.deepEqual(terms(f, r.rollId), snapshot);
    assert.ok(f.sent.length >= sent);
    assert.equal(cancelMysteryRuntime(f.db), 0);
  });
}

test("legacy ambiguous mystery countdown remains blocked and recovery never guesses a winner or refunds", async (t) => {
  const f = fixture(t);
  const eventDraw =
    (MYSTERY_ROSTER.findIndex((e) => e.id === "doors") + 0.1) /
    MYSTERY_ROSTER.length;
  const draws = [0, 0, eventDraw][Symbol.iterator]();
  const r = reserveMysteryAwareRoll(f.db, {
    guildId: "1",
    channelId: "10",
    commandMessageId: "100",
    userId: "101",
    pool: "w",
    now: f.time.now(),
    mysteryEnabled: true,
    random: () => draws.next().value,
  });
  await startMysteryRoll({
    db: f.db,
    client: f.client,
    message: f.message(),
    reservation: r,
    ...f.time,
    random: () => 0,
  });
  await f.time.advance(getMysterySession(f.db, r.sessionId).nextAt);
  await onMysteryButton(
    f.db,
    f.click(`mystery:${r.sessionId}:door:1`, f.sent.at(-1)),
  );
  assert.equal(getMysterySession(f.db, r.sessionId).state, "countdown");
  const columns = f.db.prepare("PRAGMA table_info(mystery_sessions)").all();
  const stateColumn = columns.find((c) => /state.*json/.test(c.name)).name;
  const state = JSON.parse(
    f.db.prepare(`SELECT ${stateColumn} value FROM mystery_sessions`).get()
      .value,
  );
  delete state.runtime;
  f.db
    .prepare(`UPDATE mystery_sessions SET ${stateColumn}=? WHERE id=?`)
    .run(JSON.stringify(state), r.sessionId);
  f.reopen();
  const before = rows(f.db),
    sent = f.sent.length;
  assert.throws(
    () => assertCatalogRuntimeRestartReady(f.db),
    /mystery_runtime_missing/,
  );
  const result = await recoverMysteryRuntime({
    db: f.db,
    client: f.client,
    ...f.time,
  });
  assert.deepEqual(result.recovered, []);
  assert.equal(result.blockers.length, 1);
  assert.equal(cancelMysteryRuntime(f.db), 0);
  assert.deepEqual(rows(f.db), before);
  assert.equal(f.sent.length, sent);
  assert.equal(f.time.pending(), 0);
});

function siren(f) {
  const target = marry(f, 0);
  const inventoryId = addItemToInventory(f.db, "1", "101", "sirens_call").item
    .id;
  const result = executeItemUseById(f.db, "1", "101", inventoryId, ["202"], {
    channelId: "10",
    now: f.time.now(),
    random: () => 0,
  });
  assert.equal(result.success, true);
  assert.equal(getInventory(f.db, "1", "101").length, 0);
  return { target, result, id: result.escapeAttempt.pendingRollId };
}

test("Siren pending: captured windows/cost/UUID survive and failed delivery retries faithfully", async (t) => {
  const f = fixture(t);
  const { id, target } = siren(f);
  const snapshot = terms(f, id);
  const windows = f.db
    .prepare("SELECT rules_json FROM character_rolls")
    .get().rules_json;
  assert.ok(JSON.parse(windows).escapeProtectionMs > 0);
  f.db.exec("UPDATE characters SET name_full='Edited',favourites=1");
  f.reopen();
  const before = rows(f.db);
  assert.deepEqual(codes(f), []);
  assert.equal(assertCatalogRuntimeRestartReady(f.db).ready, true);
  assert.deepEqual(rows(f.db), before);
  recoverRollRuntime(f.db); // Pending Siren exception must preserve its spent item.
  await recoverForcedEscapes(f.db, {
    channels: {
      fetch: async () => {
        throw Error("offline");
      },
    },
  });
  assert.equal(
    f.db.prepare("SELECT state FROM character_rolls").get().state,
    "pending",
  );
  assert.deepEqual(terms(f, id), snapshot);
  assert.equal(
    f.db.prepare("SELECT rules_json FROM character_rolls").get().rules_json,
    windows,
  );
  t.mock.method(globalThis, "setTimeout", f.time.setTimer);
  t.mock.method(globalThis, "clearTimeout", f.time.clearTimer);
  await recoverForcedEscapes(f.db, f.client);
  assert.equal(
    f.db.prepare("SELECT state FROM character_rolls").get().state,
    "open",
  );
  assert.match(JSON.stringify(f.sent[0].payload), /Original 1/);
  assert.doesNotMatch(JSON.stringify(f.sent[0].payload), /Edited/);
  await recoverForcedEscapes(f.db, f.client);
  assert.equal(f.sent.length, 1);
  await heart(f, f.sent[0]);
  await heart(f, f.sent[0]);
  assert.equal(
    f.db.prepare("SELECT escape_outcome FROM character_rolls").get()
      .escape_outcome,
    "reclaimed",
  );
  assert.equal(
    f.db.prepare("SELECT id FROM marriages").get().id,
    target.marriageId,
  );
  assert.equal(getInventory(f.db, "1", "101").length, 0);
});

test("Siren missing captured windows stays blocked, pending and spent without live defaults", async (t) => {
  const f = fixture(t);
  siren(f);
  f.db.exec("UPDATE character_rolls SET rules_json=NULL");
  f.reopen();
  const before = rows(f.db);
  assert.throws(
    () => assertCatalogRuntimeRestartReady(f.db),
    /forced_rules_unavailable/,
  );
  await recoverForcedEscapes(f.db, f.client);
  assert.deepEqual(rows(f.db), before);
  assert.equal(f.sent.length, 0);
  assert.equal(getInventory(f.db, "1", "101").length, 0);
});

test("Siren corrupt terms stay pending and spent across retry, never fall back to live character", async (t) => {
  const f = fixture(t);
  siren(f);
  f.db.exec("UPDATE character_rolls SET character_snapshot_json='{}'");
  f.reopen();
  const before = rows(f.db);
  assert.ok(codes(f).includes("invalid_terms"));
  await recoverForcedEscapes(f.db, f.client);
  assert.deepEqual(rows(f.db), before);
  assert.equal(f.sent.length, 0);
  assert.equal(getInventory(f.db, "1", "101").length, 0);
});

test("published forced escape resumes original deadlines and allows a single canonical steal", async (t) => {
  const f = fixture(t);
  const { result, target } = siren(f);
  await startForcedEscape({
    db: f.db,
    channel: f.channel,
    guildId: "1",
    channelId: "10",
    ...result.escapeAttempt,
    ...f.time,
  });
  assert.ok(f.time.pending());
  f.reopen();
  assert.equal(assertCatalogRuntimeRestartReady(f.db).ready, true);
  const saved = f.db
    .prepare(
      "SELECT published_at,protected_until,expires_at FROM character_rolls",
    )
    .get();
  recoverRollRuntime(f.db);
  await recoverForcedEscapes(f.db, f.client);
  await recoverOpenEscapes(f.db, f.client, f.time);
  assert.deepEqual(
    f.db
      .prepare(
        "SELECT published_at,protected_until,expires_at FROM character_rolls",
      )
      .get(),
    saved,
  );
  assert.equal(
    f.sent.length,
    1,
    "recovery edits the original card instead of sending a replacement",
  );
  await f.time.advance(saved.protected_until);
  await heart(f, f.sent[0], "303");
  await heart(f, f.sent[0], "404");
  assert.equal(
    f.db
      .prepare("SELECT owner_id FROM marriages WHERE character_id=?")
      .get(target.characterId).owner_id,
    "303",
  );
  assert.equal(
    f.db.prepare("SELECT escape_outcome FROM character_rolls").get()
      .escape_outcome,
    "married",
  );
  assert.equal(getInventory(f.db, "1", "101").length, 0);
  assert.equal(f.db.prepare("SELECT count(*) n FROM marriages").get().n, 1);
  assert.equal(f.sent.length, 2, "only one canonical claim announcement");
});

test("item confirming restarts through bound runtime controls; committed effect announcement retry never reactivates or consumes twice", async (t) => {
  const f = fixture(t, 2);
  marry(f, 0, "101");
  marry(f, 1, "101");
  const inv = addItemToInventory(f.db, "1", "101", "kaimetsu").item.id;
  const action = await startItemAction({
    db: f.db,
    message: f.message(),
    inventoryId: inv,
  });
  const prompt = f.sent[0];
  f.reopen();
  assert.equal(assertCatalogRuntimeRestartReady(f.db).ready, true);
  assert.ok(
    inspectCatalogRuntimeRestart(f.db).recoverable.some(
      (r) => r.kind === "item_action" && r.id === action.id,
    ),
  );
  let runtime = await recoverItemActionRuntime(f.db, f.client);
  assert.equal(getItemAction(f.db, action.id).state, "confirming");
  assert.equal(getInventory(f.db, "1", "101").length, 1);
  // Commit through the real interaction router, but lose the result edit.
  const edit = prompt.edit;
  prompt.edit = async () => {
    throw Error("delivery interrupted");
  };
  await onItemActionInteraction(
    f.db,
    f.click(`item:${action.id}:confirm`, prompt),
  );
  assert.equal(getItemAction(f.db, action.id).state, "resolved");
  assert.equal(getItemAction(f.db, action.id).delivery_pending, 1);
  const committed = rows(f.db);
  runtime.stop();
  f.reopen();
  prompt.edit = edit;
  runtime = await recoverItemActionRuntime(f.db, f.client);
  t.after(runtime.stop);
  await onItemActionInteraction(
    f.db,
    f.click(`item:${action.id}:confirm`, prompt),
  );
  await runtime.reconcile();
  assert.equal(getItemAction(f.db, action.id).delivery_pending, 0);
  assert.equal(getInventory(f.db, "1", "101").length, 0);
  assert.equal(f.db.prepare("SELECT count(*) n FROM marriages").get().n, 1);
  assert.deepEqual(
    rows(f.db).filter(([name]) => name !== "item_actions"),
    committed.filter(([name]) => name !== "item_actions"),
  );
  assert.equal(assertCatalogRuntimeRestartReady(f.db).ready, true);
});

test("corrupt item runtime remains an explicit read-only preflight blocker", async (t) => {
  const f = fixture(t, 2);
  marry(f, 0, "101");
  marry(f, 1, "101");
  const inv = addItemToInventory(f.db, "1", "101", "kaimetsu").item.id;
  await startItemAction({ db: f.db, message: f.message(), inventoryId: inv });
  f.db.exec(`UPDATE item_actions SET selections_json='{broken'`);
  f.reopen(true);
  const before = rows(f.db);
  assert.throws(
    () => assertCatalogRuntimeRestartReady(f.db),
    /item_reconciliation_required/,
  );
  assert.deepEqual(rows(f.db), before);
  assert.equal(getInventory(f.db, "1", "101").length, 1);
});

for (const delivered of [false, true])
  test(`Hostage ${delivered ? "active" : "unconfirmed delivery"} restart uses existing escrow semantics, not guessed cost`, async (t) => {
    const f = fixture(t, 2);
    const own = marry(f, 0, "101"),
      target = marry(f, 1);
    const inv = addItemToInventory(f.db, "1", "101", "hostage_note").item.id;
    const action = await startItemAction({
      db: f.db,
      message: f.message(),
      inventoryId: inv,
    });
    assert.equal(
      updateItemSelection(f.db, action.id, "1", "101", {
        own,
        targets: [target],
      }),
      true,
    );
    if (delivered)
      await onItemActionInteraction(
        f.db,
        f.click(`item:${action.id}:confirm`, f.sent[0]),
      );
    else
      assert.equal(
        activateItemAction(f.db, {
          actionId: action.id,
          guildId: "1",
          actorId: "101",
        }).status,
        "awaiting_delivery",
      );
    f.reopen();
    const runtime = await recoverItemActionRuntime(f.db, f.client);
    t.after(runtime.stop);
    const recovered = getItemAction(f.db, action.id);
    assert.equal(recovered.state, delivered ? "active" : "canceled");
    assert.equal(getInventory(f.db, "1", "101").length, delivered ? 0 : 1);
    if (delivered) {
      const prompt = await f.channel.messages.fetch(recovered.message_id);
      await onItemActionInteraction(
        f.db,
        f.click(`item:${action.id}:exchange`, prompt, "202"),
      );
      await onItemActionInteraction(
        f.db,
        f.click(`item:${action.id}:exchange`, prompt, "202"),
      );
      assert.equal(getItemAction(f.db, action.id).state, "resolved");
      assert.equal(
        f.db
          .prepare("SELECT owner_id FROM marriages WHERE character_id=?")
          .get(IDS[0]).owner_id,
        "202",
      );
      assert.equal(
        f.db
          .prepare("SELECT owner_id FROM marriages WHERE character_id=?")
          .get(IDS[1]).owner_id,
        "101",
      );
    }
    assert.equal(f.db.prepare("SELECT count(*) n FROM marriages").get().n, 2);
  });

test("vault pending delivery is allowed without acknowledging; runtime delivers without replaying reward", async (t) => {
  const f = fixture(t);
  revealVaultReward(f.db, {
    vaultId: "synthetic-vault",
    guildId: "1",
    userId: "101",
    channelId: "10",
    outcome: {
      tier: "common",
      tierData: { name: "Common", color: 0x808080, emoji: "" },
      item: {
        id: "hourglass_of_haste",
        name: "Hourglass",
        description: "Synthetic reward",
        maxCharges: 1,
      },
    },
    now: f.time.now(),
  });
  f.reopen(true);
  const before = rows(f.db);
  assert.equal(assertCatalogRuntimeRestartReady(f.db).ready, true);
  assert.deepEqual(rows(f.db), before);
  assert.equal(
    f.db.prepare("SELECT delivered_at FROM vault_rewards").get().delivered_at,
    null,
  );
  f.reopen();
  await recoverVaultRewards(f.db, f.client, { now: f.time.now });
  await recoverVaultRewards(f.db, f.client, { now: f.time.now });
  assert.equal(
    f.db.prepare("SELECT delivered_at FROM vault_rewards").get().delivered_at,
    f.time.now(),
  );
  assert.equal(getInventory(f.db, "1", "101").length, 1);
  assert.equal(f.sent.length, 1);
});

test("ordinary published escape resumes its timer and settles expiry without returning roll cost", async (t) => {
  const f = fixture(t);
  const marriage = marry(f, 0);
  await runRoll(
    {
      message: f.message(),
      yoshiko: {
        catalogDb: f.db,
        mysteryEnabled: false,
        imagePicker: {
          pick: async () => ({ url: "https://example.invalid/original.png" }),
        },
      },
    },
    "w",
    () => 0.5,
    f.time,
  );
  assert.ok(f.time.pending());
  const remaining = getRollStatus(f.db, "1", "101", f.time.now()).remaining;
  const saved = f.db
    .prepare(
      "SELECT published_at,protected_until,expires_at FROM character_rolls",
    )
    .get();
  f.reopen();
  assert.equal(assertCatalogRuntimeRestartReady(f.db).ready, true);
  recoverRollRuntime(f.db);
  await recoverOpenEscapes(f.db, f.client, f.time);
  assert.deepEqual(
    f.db
      .prepare(
        "SELECT published_at,protected_until,expires_at FROM character_rolls",
      )
      .get(),
    saved,
  );
  assert.ok(f.time.pending());
  await f.time.advance(saved.expires_at);
  await heart(f, f.sent[0], "303");
  assert.equal(
    f.db
      .prepare("SELECT owner_id FROM marriages WHERE id=?")
      .get(marriage.marriageId).owner_id,
    "202",
  );
  assert.equal(
    f.db.prepare("SELECT escape_outcome FROM character_rolls").get()
      .escape_outcome,
    "expired",
  );
  assert.equal(
    getRollStatus(f.db, "1", "101", f.time.now()).remaining,
    remaining,
  );
  assert.ok(f.sent[0].edits.length > 0);
});

test("trade awaiting confirmation is memory-only: new runtime ignores yes and preserves exact ownership UUIDs", async (t) => {
  const f = fixture(t, 2);
  marry(f, 0, "101");
  marry(f, 1);
  t.mock.method(globalThis, "setTimeout", f.time.setTimer);
  t.mock.method(globalThis, "clearTimeout", f.time.clearTimer);
  const oldDb = f.db;
  await startTrade({
    yoshiko: { catalogDb: oldDb },
    message: f.message(),
    args: ["trade", "202"],
  });
  assert.equal(
    await onTradeAnswer(oldDb, f.message("101", "101", "Original 1")),
    true,
  );
  assert.equal(
    await onTradeAnswer(oldDb, f.message("102", "202", "Original 2")),
    true,
  );
  const before = rows(oldDb);
  f.reopen();
  assert.equal(
    await onTradeAnswer(f.db, f.message("103", "202", "yes")),
    false,
  );
  assert.deepEqual(rows(f.db), before);
  assert.equal(assertCatalogRuntimeRestartReady(f.db).ready, true); // Cannot detect the lost conversation.
  assert.match(
    inspectCatalogRuntimeRestart(f.db).limitations[0],
    /memory-only/,
  );
  // Dispose the old test-process-only session; not startup recovery on the new DB.
  await cancelTransfer({ yoshiko: { catalogDb: oldDb }, message: f.message() });
});
