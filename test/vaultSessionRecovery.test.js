import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFinalCatalog, openCatalog } from "../lib/catalogDb.js";
import {
  reservePaidVaultSession,
  getVaultSession,
  inspectVaultSessions,
} from "../lib/vaultSessions.js";
import {
  startVaultRoll,
  onVaultInteraction,
  recoverVaultSessions,
} from "../lib/vaultRuntime.js";
import { getVaultReward } from "../lib/vaultRewards.js";
import { getInventory, addItemToInventory } from "../lib/itemStorage.js";
import { ITEM_TIERS, getItemsInTier } from "../lib/itemRoster.js";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "vault-session-"));
  const path = join(dir, "fake.sqlite");
  let db = createFinalCatalog(path);
  // Discard pre-crash timers instead of letting them touch closed connections.
  const timers = new Set();
  t.mock.method(globalThis, "setTimeout", () => {
    const timer = {};
    timers.add(timer);
    return timer;
  });
  t.mock.method(globalThis, "clearTimeout", (timer) => timers.delete(timer));
  t.after(() => {
    timers.clear();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    get db() {
      return db;
    },
    reopen() {
      timers.clear();
      db.close();
      db = openCatalog(path);
      assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
    },
  };
}
function discord() {
  const messages = new Map();
  let failure = false;
  const channel = {
    id: "channel",
    sent: 0,
    messages: {
      fetch: async (request) => {
        const id = typeof request === "string" ? request : request.message;
        if (failure) throw new Error("temporary fetch failure");
        if (!messages.has(id))
          throw Object.assign(new Error("deleted"), { code: 10008 });
        return messages.get(id);
      },
    },
    send: async (payload) => {
      if (failure) throw new Error("temporary send failure");
      if (payload.enforceNonce) {
        const existing = [...messages.values()].find(
          (message) => message.nonce === payload.nonce,
        );
        if (existing) return existing;
      }
      const message = {
        id: String(++channel.sent),
        channelId: channel.id,
        channel,
        payload,
        nonce: payload.nonce,
        edit: async (change) => {
          if (failure) throw new Error("temporary edit failure");
          message.payload = change;
          return message;
        },
      };
      messages.set(message.id, message);
      return message;
    },
  };
  return {
    channel,
    messages,
    fail(value) {
      failure = value;
    },
    client: {
      channels: {
        fetch: async () => {
          if (failure) throw new Error("temporary channel failure");
          return channel;
        },
      },
    },
  };
}
const outcome = () => ({
  tier: "common",
  tierData: ITEM_TIERS.common,
  item: getItemsInTier("common")[0],
});
const request = (extra = {}) => ({
  guildId: "10001",
  rollerId: "roller",
  channelId: "channel",
  commandMessageId: "command",
  paidRollId: "paid-1",
  remaining: 3,
  now: 1000,
  timeoutMs: 60000,
  ...extra,
});
function click(vaultId, message, extra = {}) {
  return {
    customId: `vault:${vaultId}:A`,
    guildId: "10001",
    channelId: "channel",
    user: { id: "roller" },
    message,
    isButton: () => true,
    isStringSelectMenu: () => false,
    channel: message.channel,
    deferUpdate: async () => {},
    reply: async () => {},
    update: async (payload) => message.edit(payload),
    ...extra,
  };
}
async function start(f, d) {
  return startVaultRoll({
    db: f.db,
    channel: d.channel,
    guildId: "10001",
    rollerId: "roller",
    commandMessageId: "command",
    remaining: 999,
    now: () => 2000,
  });
}

test("paid reservation rolls back with allowance transaction, adopts by command and survives reopen/repeated choice", async (t) => {
  const f = fixture(t),
    d = discord();
  f.db.exec("BEGIN IMMEDIATE");
  reservePaidVaultSession(f.db, request());
  f.db.exec("ROLLBACK");
  assert.equal(inspectVaultSessions(f.db, { now: 1000 }).length, 0);
  f.db.exec("BEGIN IMMEDIATE");
  const reserved = reservePaidVaultSession(
    f.db,
    request({ capturedOutcome: outcome() }),
  );
  f.db.exec("COMMIT");
  assert.equal(reserved.messageId, null);
  assert.equal(reserved.paidRollId, "paid-1");
  f.reopen();
  const started = await start(f, d);
  assert.equal(started.vaultId, reserved.vaultId);
  assert.equal(getVaultSession(f.db, reserved.vaultId).remaining, 3);
  f.reopen();
  await recoverVaultSessions(f.db, d.client, { now: () => 3000 });
  assert.equal(d.channel.sent, 1);
  assert.equal(getVaultSession(f.db, reserved.vaultId).deadline, 61000);
  const noDraw = () => {
    throw new Error("must not reroll captured/revealed outcome");
  };
  await onVaultInteraction(f.db, click(reserved.vaultId, started.message), {
    now: () => 4000,
    random: noDraw,
  });
  assert.equal(
    getVaultSession(f.db, reserved.vaultId).rewardId,
    reserved.vaultId,
  );
  const [granted] = getInventory(f.db, "10001", "roller", 4000);
  assert.ok(granted);
  assert.equal(getInventory(f.db, "10001", "roller", 4000).length, 1);
  assert.equal(granted.acquired_at, new Date(4000).toISOString());
  assert.ok(
    getInventory(f.db, "10001", "roller", granted.expires_at - 1).some(
      (item) => item.id === granted.id,
    ),
  );
  assert.equal(
    getInventory(f.db, "10001", "roller", granted.expires_at).length,
    0,
  );
  f.reopen();
  await onVaultInteraction(f.db, click(reserved.vaultId, started.message), {
    now: () => 5000,
    random: noDraw,
  });
  assert.deepEqual(getInventory(f.db, "10001", "roller", 5000), [granted]);
  const reward = getVaultReward(f.db, reserved.vaultId);
  assert.notEqual(reward.messageId, started.message.id);
  assert.equal(reward.sourceMessageId, started.message.id);
  assert.equal(d.channel.sent, 2);
  assert.match(JSON.stringify(started.message.payload), /"disabled":true/);
  assert.match(
    JSON.stringify(d.messages.get(reward.messageId).payload),
    /received/,
  );
});

test("failed reward send recovers on the new message without rerolling or re-enabling the vault", async (t) => {
  const f = fixture(t),
    d = discord();
  const reserved = reservePaidVaultSession(
    f.db,
    request({ capturedOutcome: outcome() }),
  );
  const started = await start(f, d);
  const send = d.channel.send;
  d.channel.send = async (payload) => {
    if (payload.enforceNonce && !payload.reply)
      throw new Error("reward send unavailable");
    return send(payload);
  };
  await assert.rejects(
    onVaultInteraction(f.db, click(reserved.vaultId, started.message), {
      now: () => 3000,
    }),
    /reward send unavailable/,
  );
  assert.equal(getVaultReward(f.db, reserved.vaultId).messageId, null);
  assert.match(JSON.stringify(started.message.payload), /"disabled":true/);
  assert.equal(d.channel.sent, 1);
  d.channel.send = send;
  f.reopen();
  await recoverVaultSessions(f.db, d.client, { now: () => 4000 });
  const reward = getVaultReward(f.db, reserved.vaultId);
  assert.notEqual(reward.messageId, started.message.id);
  assert.equal(d.channel.sent, 2);
  const inventory = getInventory(f.db, "10001", "roller", 4000);
  assert.equal(inventory.length, 1);
  assert.equal(inventory[0].acquired_at, new Date(3000).toISOString());
  await recoverVaultSessions(f.db, d.client, { now: () => 5000 });
  assert.equal(d.channel.sent, 2);
  assert.match(
    JSON.stringify(d.messages.get(reward.messageId).payload),
    /received/,
  );
});

test("reward send response loss is deduplicated by nonce on retry", async (t) => {
  const f = fixture(t),
    d = discord();
  const reserved = reservePaidVaultSession(
    f.db,
    request({ capturedOutcome: outcome() }),
  );
  const started = await start(f, d);
  const send = d.channel.send;
  let lost = true;
  d.channel.send = async (payload) => {
    const message = await send(payload);
    if (lost && payload.enforceNonce && !payload.reply) {
      lost = false;
      throw new Error("lost reward response");
    }
    return message;
  };
  await assert.rejects(
    onVaultInteraction(f.db, click(reserved.vaultId, started.message), {
      now: () => 3000,
    }),
    /lost reward response/,
  );
  assert.equal(d.channel.sent, 2);
  assert.equal(getVaultReward(f.db, reserved.vaultId).messageId, null);
  f.reopen();
  await recoverVaultSessions(f.db, d.client, { now: () => 4000 });
  assert.equal(d.channel.sent, 2);
  assert.equal(getVaultReward(f.db, reserved.vaultId).messageId, "2");
});

test("original expiry survives repeated transient delivery failures before and after reopen", async (t) => {
  const f = fixture(t),
    d = discord();
  const reserved = reservePaidVaultSession(f.db, request());
  d.fail(true);
  for (let i = 0; i < 3; i++)
    await recoverVaultSessions(f.db, d.client, { now: () => 2000 + i });
  assert.equal(getVaultSession(f.db, reserved.vaultId).messageId, null);
  assert.equal(getVaultSession(f.db, reserved.vaultId).deadline, 61000);
  f.reopen();
  await recoverVaultSessions(f.db, d.client, { now: () => 62000 });
  assert.equal(getVaultSession(f.db, reserved.vaultId).state, "expired");
  d.fail(false);
  await recoverVaultSessions(f.db, d.client, { now: () => 63000 });
  assert.equal(d.channel.sent, 1);
  const session = getVaultSession(f.db, reserved.vaultId);
  assert.ok(
    JSON.stringify(
      d.messages.get(session.messageId).payload.components,
    ).includes('"disabled":true'),
  );
  await onVaultInteraction(
    f.db,
    click(reserved.vaultId, d.messages.get(session.messageId)),
    { now: () => 64000 },
  );
  assert.equal(getVaultReward(f.db, reserved.vaultId), null);
  assert.equal(session.deadline, 61000);
  const delivered = getVaultSession(f.db, reserved.vaultId).deliveredAt;
  f.reopen();
  await recoverVaultSessions(f.db, d.client, { now: () => 65000 });
  assert.equal(d.channel.sent, 1);
  assert.equal(getVaultSession(f.db, reserved.vaultId).deliveredAt, delivered);
  assert.equal(getVaultReward(f.db, reserved.vaultId), null);
});

test("failed reveal acknowledgement commits once; reopened post-reveal recovery keeps original decision deadline", async (t) => {
  const f = fixture(t),
    d = discord();
  addItemToInventory(f.db, "10001", "roller", "double_or_nothing", undefined, {
    now: 1000,
  });
  const reserved = reservePaidVaultSession(
    f.db,
    request({ capturedOutcome: outcome() }),
  );
  const started = await start(f, d);
  await assert.rejects(
    onVaultInteraction(
      f.db,
      click(reserved.vaultId, started.message, {
        deferUpdate: async () => {
          throw new Error("temporary ack failure");
        },
      }),
      { now: () => 3000 },
    ),
    /temporary ack/,
  );
  const first = getVaultReward(f.db, reserved.vaultId);
  assert.equal(first.state, "decision");
  assert.equal(first.messageId, null);
  assert.equal(getVaultSession(f.db, reserved.vaultId).state, "revealed");
  f.reopen();
  d.fail(true);
  for (let i = 0; i < 3; i++)
    await recoverVaultSessions(f.db, d.client, { now: () => 4000 + i });
  assert.equal(getVaultReward(f.db, reserved.vaultId).deadline, first.deadline);
  d.fail(false);
  await onVaultInteraction(f.db, click(reserved.vaultId, started.message), {
    now: () => 5000,
    random: () => {
      throw new Error("must reuse original");
    },
  });
  await recoverVaultSessions(f.db, d.client, { now: () => first.deadline + 1 });
  assert.equal(getVaultReward(f.db, reserved.vaultId).state, "delivered");
  const inventory = getInventory(f.db, "10001", "roller", first.deadline + 1);
  assert.equal(inventory.length, 2);
  const granted = inventory.find((item) => item.item_id === outcome().item.id);
  assert.equal(granted.acquired_at, new Date(first.deadline + 1).toISOString());
  assert.equal(d.channel.sent, 2);
});

test("transient fetch errors never replace a live vault or reset its timeout; definite deletion rebinds", async (t) => {
  const f = fixture(t),
    d = discord();
  reservePaidVaultSession(f.db, request());
  const started = await start(f, d);
  d.fail(true);
  f.reopen();
  for (let i = 0; i < 3; i++)
    await recoverVaultSessions(f.db, d.client, { now: () => 3000 });
  assert.equal(d.channel.sent, 1);
  assert.equal(getVaultSession(f.db, started.vaultId).deadline, 61000);
  d.fail(false);
  await recoverVaultSessions(f.db, d.client, { now: () => 4000 });
  assert.equal(d.channel.sent, 1);
  d.messages.delete(started.message.id);
  await recoverVaultSessions(f.db, d.client, { now: () => 5000 });
  assert.equal(d.channel.sent, 2);
  await onVaultInteraction(f.db, click(started.vaultId, started.message), {
    now: () => 6000,
  });
  assert.equal(getVaultReward(f.db, started.vaultId), null);
});

for (const sourceKind of ["mystery_consolation", "unknown"])
  test(`cross-source vault ID collision fails before reconciliation: ${sourceKind}`, async (t) => {
    const f = fixture(t),
      d = discord();
    const reserved = reservePaidVaultSession(
      f.db,
      request({ vaultId: "injected-id" }),
    );
    const unrelated = reservePaidVaultSession(
      f.db,
      request({
        vaultId: "unrelated",
        commandMessageId: "other",
        now: 0,
        timeoutMs: 1,
      }),
    );
    f.db
      .prepare(
        `INSERT INTO vault_rewards(vault_id,guild_id,user_id,channel_id,original_json,state,created_at)
    VALUES(?,?,?,?,?,'delivered',?)`,
      )
      .run(
        reserved.vaultId,
        reserved.guildId,
        reserved.rollerId,
        reserved.channelId,
        JSON.stringify(outcome()),
        1000,
      );
    f.db
      .prepare("INSERT INTO reward_sources VALUES(?,?,?,?)")
      .run(reserved.vaultId, sourceKind, "1", '{"version":1}');
    const before = f.db
      .prepare("SELECT * FROM vault_sessions ORDER BY vault_id")
      .all();
    assert.throws(
      () => inspectVaultSessions(f.db, { now: 100000 }),
      /source.*collision/i,
    );
    await assert.rejects(
      recoverVaultSessions(f.db, d.client, { now: () => 100000 }),
      /source.*collision/i,
    );
    assert.deepEqual(
      f.db.prepare("SELECT * FROM vault_sessions ORDER BY vault_id").all(),
      before,
    );
    assert.equal(getVaultSession(f.db, unrelated.vaultId).state, "unopened");
    assert.equal(d.channel.sent, 0);
  });

test("direct reward creation rejects a real vault session ID before any writes, including idempotent retry", async (t) => {
  const f = fixture(t);
  const { createDirectItemRewardInTransaction } =
    await import("../lib/vaultRewards.js");
  const request = {
    rewardId: "injected-id",
    guildId: "10001",
    userId: "roller",
    channelId: "channel",
    sourceKind: "mystery_consolation",
    sourceId: "1",
    metadata: { version: 1 },
    outcome: outcome(),
    now: 1000,
  };
  const snapshot = () =>
    ["vault_sessions", "vault_rewards", "reward_sources", "user_inventory"].map(
      (table) => f.db.prepare(`SELECT * FROM ${table}`).all(),
    );
  const rejectWithoutMutation = () => {
    const before = snapshot();
    f.db.exec("BEGIN IMMEDIATE");
    try {
      assert.throws(
        () => createDirectItemRewardInTransaction(f.db, request),
        /source.*collision/i,
      );
      assert.deepEqual(snapshot(), before);
    } finally {
      f.db.exec("ROLLBACK");
    }
  };
  reservePaidVaultSession(f.db, {
    ...request,
    rollerId: request.userId,
    vaultId: request.rewardId,
  });
  rejectWithoutMutation();
  f.db.exec("DELETE FROM vault_sessions; BEGIN IMMEDIATE");
  createDirectItemRewardInTransaction(f.db, request);
  f.db.exec("COMMIT");
  reservePaidVaultSession(f.db, {
    ...request,
    rollerId: request.userId,
    vaultId: request.rewardId,
  });
  rejectWithoutMutation();
});
