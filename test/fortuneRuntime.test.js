import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFinalCatalog, openFinalCatalog } from "../lib/catalogDb.js";
import { addItemToInventory, getInventory } from "../lib/itemStorage.js";
import { run as useCommand } from "../commands/use.js";
import { executeItemUse } from "../lib/itemActivation.js";
import {
  getDiscoveredItemIds,
  KAIMETSU_UNDISCOVERED,
} from "../lib/itemDiscovery.js";
import { getItemDefinition, rollVaultOutcome } from "../lib/itemRoster.js";
import { reservePaidVaultSession } from "../lib/vaultSessions.js";
import {
  getLens,
  getRecast,
  inspectFortuneRuntime,
} from "../lib/vaultFortune.js";
import { getVaultReward, reconcileVaultRewards } from "../lib/vaultRewards.js";
import {
  startVaultRoll,
  onVaultInteraction,
  recoverVaultSessions,
} from "../lib/vaultRuntime.js";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "fortune-runtime-")),
    path = join(dir, "test.sqlite");
  let db = createFinalCatalog(path);
  t.mock.method(globalThis, "setTimeout", () => ({}));
  t.mock.method(globalThis, "clearTimeout", () => {});
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const messages = new Map();
  let count = 0,
    failure = false;
  const channel = {
    id: "channel",
    messages: {
      fetch: async (request) => {
        const id = typeof request === "string" ? request : request.message;
        if (failure) throw new Error("transient");
        if (!messages.has(id))
          throw Object.assign(new Error("deleted"), { code: 10008 });
        return messages.get(id);
      },
    },
    send: async (payload) => {
      const message = {
        id: String(++count),
        channelId: "channel",
        payload,
        channel,
        edit: async (payload) => {
          if (failure) throw new Error("transient");
          message.payload = payload;
          return message;
        },
      };
      messages.set(message.id, message);
      return message;
    },
  };
  return {
    get db() {
      return db;
    },
    channel,
    messages,
    reopen() {
      db.close();
      db = openFinalCatalog(path);
    },
    fail(value) {
      failure = value;
    },
    client: {
      channels: {
        fetch: async () => {
          if (failure) throw new Error("transient");
          return channel;
        },
      },
    },
  };
}
function click(vaultId, message, action, extra = {}) {
  return {
    customId: `vault:${vaultId}:${action}`,
    guildId: "guild",
    channelId: "channel",
    channel: message.channel,
    user: { id: "owner" },
    message,
    isButton: () => true,
    isStringSelectMenu: () => false,
    deferUpdate: async () => {},
    reply: async () => {},
    update: (payload) => message.edit(payload),
    ...extra,
  };
}
async function bound(f, capturedOutcome) {
  const commandMessageId = `command-${f.messages.size}`;
  reservePaidVaultSession(f.db, {
    guildId: "guild",
    userId: "owner",
    channelId: "channel",
    commandMessageId,
    capturedOutcome,
    now: 100,
    timeoutMs: 1000,
  });
  return startVaultRoll({
    db: f.db,
    channel: f.channel,
    guildId: "guild",
    rollerId: "owner",
    commandMessageId,
    remaining: 0,
    now: () => 100,
  });
}

for (const inventory of [
  "empty",
  "other-user",
  "other-guild",
  "spent",
  "held",
  "usable",
]) {
  test(`Lens control requires the roller's usable inventory (${inventory})`, async (t) => {
    const f = fixture(t);
    if (inventory !== "empty") {
      const source = addItemToInventory(
        f.db,
        inventory === "other-guild" ? "other-guild" : "guild",
        inventory === "other-user" ? "other-user" : "owner",
        "fortunes_lens",
        inventory === "spent" ? 0 : 1,
      ).item;
      if (inventory === "held")
        f.db
          .prepare(
            `INSERT INTO item_action_costs
        (action_id, inventory_id, snapshot_json) VALUES (?, ?, ?)`,
          )
          .run("held-action", source.id, JSON.stringify(source));
    }
    const { vaultId, message } = await bound(f);
    const hasControl = () =>
      JSON.stringify(message.payload).includes(`vault:${vaultId}:lens`);
    assert.equal(hasControl(), inventory === "usable");
    await recoverVaultSessions(f.db, f.client, { now: () => 200 });
    assert.equal(hasControl(), inventory === "usable");
    if (inventory === "empty") {
      let rejected;
      await onVaultInteraction(
        f.db,
        click(vaultId, message, "lens", {
          reply: async (payload) => {
            rejected = payload;
          },
        }),
        { now: () => 300 },
      );
      assert.match(rejected.content, /unavailable/);
      assert.equal(
        getLens(f.db, vaultId),
        null,
        "forged clicks cannot bypass inventory checks",
      );
    }
  });
}

test("Lens controls refresh with inventory while saved reveals survive consumption", async (t) => {
  const f = fixture(t);
  addItemToInventory(f.db, "guild", "owner", "fortunes_lens");
  const first = await bound(f),
    second = await bound(f);
  const hasControl = (vault) =>
    JSON.stringify(vault.message.payload).includes(
      `vault:${vault.vaultId}:lens`,
    );
  assert.equal(hasControl(first), true);
  assert.equal(hasControl(second), true);
  await onVaultInteraction(f.db, click(first.vaultId, first.message, "lens"), {
    now: () => 200,
    random: () => 0,
  });
  await recoverVaultSessions(f.db, f.client, { now: () => 300 });
  assert.equal(hasControl(second), false);
  assert.ok(
    JSON.stringify(first.message.payload).includes(
      `Fortune Lens v1 · ${first.vaultId}`,
    ),
  );
  addItemToInventory(f.db, "guild", "owner", "fortunes_lens");
  await recoverVaultSessions(f.db, f.client, { now: () => 400 });
  assert.equal(hasControl(second), true);
  assert.equal(
    hasControl(first),
    false,
    "already revealed vault must not offer another activation",
  );
});

test("prefix use accepts multiword Fortune names and rejects ambiguous fortune without spending", async (t) => {
  const f = fixture(t);
  addItemToInventory(f.db, "guild", "owner", "fortunes_lens");
  addItemToInventory(f.db, "guild", "owner", "fortunes_recast");
  const replies = [];
  const message = {
    guildId: "guild",
    channelId: "channel",
    author: { id: "owner" },
    reply: async (content) => replies.push(content),
  };
  for (const args of [
    ["!use", "fortune"],
    ["!use", "Fortune's", "Lens"],
    ["!use", "Fortune's", "Recast"],
  ])
    await useCommand({
      message,
      args,
      yoshiko: { catalogDb: f.db },
      options: { now: 100 },
    });
  assert.match(replies[0], /Choose fortunes_lens/);
  assert.match(replies[1], /button/);
  assert.match(replies[2], /armed/);
  assert.equal(getInventory(f.db, "guild", "owner").length, 2);
  assert.ok(
    getInventory(f.db, "guild", "owner").every((item) => item.charges === 1),
  );
});

test("Lens send-before-ack is reconciled after reopen, never refunded; selected persisted slot reaches Recast privately", async (t) => {
  const f = fixture(t);
  addItemToInventory(f.db, "guild", "owner", "fortunes_lens");
  addItemToInventory(f.db, "guild", "owner", "fortunes_recast");
  f.db.exec("UPDATE user_inventory SET expires_at=201");
  assert.equal(
    executeItemUse(f.db, "guild", "owner", "fortune").success,
    false,
  );
  assert.equal(
    executeItemUse(f.db, "guild", "owner", "recast", [], { now: 100 }).success,
    true,
  );
  let { vaultId, message } = await bound(f);
  assert.ok(JSON.stringify(message.payload).includes("Use Fortune"));
  await assert.rejects(
    onVaultInteraction(
      f.db,
      click(vaultId, message, "lens", {
        update: async (payload) => {
          await message.edit(payload);
          throw new Error("lost ack");
        },
      }),
      { now: () => 200, random: () => 0 },
    ),
    /lost ack/,
  );
  const saved = getLens(f.db, vaultId).candidates;
  assert.equal(
    f.db
      .prepare(
        "SELECT 1 FROM guild_item_discoveries WHERE guild_id=? AND item_id=?",
      )
      .get("guild", saved[0].item.id),
    undefined,
  );
  f.reopen();
  await recoverVaultSessions(f.db, f.client, { now: () => 300 });
  assert.equal(getLens(f.db, vaultId).state, "presented");
  assert.equal(
    getInventory(f.db, "guild", "owner").filter(
      (item) => item.item_id === "fortunes_lens",
    ).length,
    0,
  );
  await onVaultInteraction(f.db, click(vaultId, message, "B"), {
    now: () => 400,
    random: () => {
      throw new Error("redraw");
    },
  });
  message = f.messages.get(getVaultReward(f.db, vaultId).messageId);
  assert.equal(getVaultReward(f.db, vaultId).state, "recast");
  assert.equal(getRecast(f.db, vaultId).original.item.id, saved[1].item.id);
  const decision = getRecast(f.db, vaultId);
  assert.ok(
    !JSON.stringify(message.payload).includes(decision.alternatives[0].name),
  );
  let privatePayload;
  await onVaultInteraction(
    f.db,
    click(vaultId, message, "recastopen", {
      reply: async (payload) => {
        privatePayload = payload;
      },
    }),
    { now: () => 500 },
  );
  assert.ok((privatePayload.flags & 64) === 64);
  assert.ok(
    JSON.stringify(privatePayload).includes(decision.alternatives[0].name),
  );
  assert.equal(getRecast(f.db, vaultId).deadline, 30500);
  assert.equal(inspectFortuneRuntime(f.db).blockers.length, 0);
  f.reopen();
  await recoverVaultSessions(f.db, f.client, { now: () => 600 });
  assert.ok(JSON.stringify(message.payload).includes("Open Recast choice"));
  const ephemeral = { id: "private", channel: f.channel };
  await onVaultInteraction(
    f.db,
    click(vaultId, ephemeral, `recastchoice:${message.id}`, {
      values: ["0"],
      isButton: () => false,
      isStringSelectMenu: () => true,
      update: async () => {},
    }),
    { now: () => 700 },
  );
  assert.equal(getVaultReward(f.db, vaultId).state, "delivered");
  assert.equal(
    getInventory(f.db, "guild", "owner", 700)[0].item_id,
    decision.alternatives[0].id,
  );
  await recoverVaultSessions(f.db, f.client, { now: () => 40000 });
  assert.equal(getInventory(f.db, "guild", "owner", 40000).length, 1);
});

test("failed private publication is unspent and resumable; forged owner/binding cannot consume or choose; timeout survives reopen", async (t) => {
  const f = fixture(t);
  addItemToInventory(f.db, "guild", "owner", "fortunes_recast");
  executeItemUse(f.db, "guild", "owner", "recast", [], { now: 100 });
  let { vaultId, message } = await bound(f);
  await onVaultInteraction(f.db, click(vaultId, message, "A"), {
    now: () => 200,
    random: () => 0,
  });
  message = f.messages.get(getVaultReward(f.db, vaultId).messageId);
  assert.equal(getRecast(f.db, vaultId).state, "pending");
  await assert.rejects(
    onVaultInteraction(
      f.db,
      click(vaultId, message, "recastopen", {
        reply: async () => {
          throw new Error("private failed");
        },
      }),
      { now: () => 300 },
    ),
    /private failed/,
  );
  assert.equal(getInventory(f.db, "guild", "owner")[0].charges, 1);
  assert.equal(getRecast(f.db, vaultId).deadline, null);
  f.reopen();
  let rejected;
  await onVaultInteraction(
    f.db,
    click(vaultId, message, "recastopen", {
      user: { id: "intruder" },
      reply: async (payload) => {
        rejected = payload;
      },
    }),
    { now: () => 400 },
  );
  assert.ok(rejected.content.includes("stale"));
  assert.equal(getRecast(f.db, vaultId).state, "pending");
  await onVaultInteraction(f.db, click(vaultId, message, "recastopen"), {
    now: () => 500,
  });
  const deadline = getRecast(f.db, vaultId).deadline;
  await onVaultInteraction(f.db, click(vaultId, message, "recastopen"), {
    now: () => 600,
  });
  assert.equal(getRecast(f.db, vaultId).deadline, deadline);
  assert.equal(getInventory(f.db, "guild", "owner").length, 0);
  f.reopen();
  await recoverVaultSessions(f.db, f.client, { now: () => deadline });
  assert.equal(getVaultReward(f.db, vaultId).state, "delivered");
  assert.equal(
    getVaultReward(f.db, vaultId).reward.item.id,
    getRecast(f.db, vaultId).original.item.id,
  );
  assert.equal(getInventory(f.db, "guild", "owner", deadline).length, 1);
});

test("multi-charge Lens publication releases only its hold, preserving later use of the same entry across restart", async (t) => {
  const f = fixture(t);
  const source = addItemToInventory(
    f.db,
    "guild",
    "owner",
    "fortunes_lens",
    2,
  ).item;
  const first = await bound(f);
  await onVaultInteraction(f.db, click(first.vaultId, first.message, "lens"), {
    now: () => 200,
    random: () => 0,
  });
  assert.equal(getInventory(f.db, "guild", "owner")[0].charges, 1);
  const second = await bound(f);
  await onVaultInteraction(
    f.db,
    click(second.vaultId, second.message, "lens"),
    { now: () => 300, random: () => 0 },
  );
  assert.equal(getInventory(f.db, "guild", "owner").length, 0);
  f.reopen();
  await recoverVaultSessions(f.db, f.client, { now: () => 1200 });
  assert.equal(getInventory(f.db, "guild", "owner").length, 0);
  assert.equal(getLens(f.db, first.vaultId).inventory_id, source.id);
  assert.equal(getLens(f.db, second.vaultId).inventory_id, source.id);
  assert.equal(inspectFortuneRuntime(f.db).blockers.length, 0);
});

for (const viaKeep of [false, true])
  test(`automatic Recast followUp edits its own private message with actual deadline (${viaKeep ? "Keep" : "slot"})`, async (t) => {
    const f = fixture(t);
    addItemToInventory(f.db, "guild", "owner", "fortunes_recast");
    if (viaKeep)
      addItemToInventory(f.db, "guild", "owner", "double_or_nothing");
    executeItemUse(f.db, "guild", "owner", "recast", [], { now: 100 });
    let { vaultId, message } = await bound(f);
    if (viaKeep) {
      await onVaultInteraction(f.db, click(vaultId, message, "A"), {
        now: () => 200,
        random: () => 0,
      });
      assert.equal(getVaultReward(f.db, vaultId).state, "decision");
      message = f.messages.get(getVaultReward(f.db, vaultId).messageId);
    }
    const edits = [],
      sent = [];
    class Interaction {
      constructor() {
        Object.assign(this, click(vaultId, message, viaKeep ? "keep" : "A"));
        this.webhook = {
          editMessage: async (id, payload) => {
            assert.equal(id, "private-followup");
            edits.push(payload);
          },
        };
      }
      async followUp(payload) {
        assert.equal(
          this.message,
          message,
          "prototype method must retain its receiver",
        );
        sent.push(payload);
        return {
          id: "private-followup",
          edit: async () => {
            throw new Error("Ephemeral messages require webhook editing");
          },
        };
      }
      async editReply() {
        assert.fail("must not edit the original public interaction reply");
      }
    }
    await onVaultInteraction(f.db, new Interaction(), {
      now: () => 500,
      random: () => 0,
    });
    assert.equal(getRecast(f.db, vaultId).deadline, 30500);
    assert.equal(sent.length, 1);
    assert.ok((sent[0].flags & 64) === 64);
    assert.equal(edits.length, 1);
    assert.ok(JSON.stringify(edits[0]).includes("<t:30:R>"));
    const rewardMessage = f.messages.get(
      getVaultReward(f.db, vaultId).messageId,
    );
    assert.ok(
      JSON.stringify(rewardMessage.payload).includes("Open Recast choice"),
    );
    assert.ok(
      JSON.stringify(sent[0]).includes(`recastchoice:${rewardMessage.id}`),
    );
  });

test("Lens masks undiscovered Kaimetsu per guild without changing saved candidates or discovering previews", async (t) => {
  const f = fixture(t);
  addItemToInventory(f.db, "guild", "owner", "fortunes_lens");
  const item = getItemDefinition("kaimetsu");
  const outcome = rollVaultOutcome(
    () => 0,
    () => 0,
    { "???": 1 },
    [item],
  );
  const { vaultId, message } = await bound(f, outcome);
  await onVaultInteraction(f.db, click(vaultId, message, "lens"), {
    now: () => 200,
  });
  const visible = JSON.stringify(message.payload);
  assert.ok(visible.includes(KAIMETSU_UNDISCOVERED.name));
  assert.ok(visible.includes(KAIMETSU_UNDISCOVERED.description));
  assert.ok(!visible.includes(item.name));
  assert.ok(!visible.includes(item.description));
  assert.ok(
    getLens(f.db, vaultId).candidates.every(
      (candidate) =>
        candidate.item.name === item.name &&
        candidate.item.description === item.description,
    ),
  );
  assert.equal(getDiscoveredItemIds(f.db, "guild").has("kaimetsu"), false);
  addItemToInventory(f.db, "other-guild", "owner", "kaimetsu");
  await recoverVaultSessions(f.db, f.client, { now: () => 300 });
  assert.ok(
    JSON.stringify(message.payload).includes(KAIMETSU_UNDISCOVERED.name),
  );
  addItemToInventory(f.db, "guild", "another-owner", "kaimetsu");
  await recoverVaultSessions(f.db, f.client, { now: () => 400 });
  assert.ok(JSON.stringify(message.payload).includes(item.name));
});

test("a gated Lens write cannot overwrite slot delivery, even with concurrent recovery", async (t) => {
  const f = fixture(t);
  addItemToInventory(f.db, "guild", "owner", "fortunes_lens");
  const { vaultId, message } = await bound(f);
  let release, entered;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const lens = onVaultInteraction(
    f.db,
    click(vaultId, message, "lens", {
      update: async (payload) => {
        entered();
        await gate;
        return message.edit(payload);
      },
    }),
    { now: () => 200, random: () => 0 },
  );
  await started;
  const selection = onVaultInteraction(f.db, click(vaultId, message, "A"), {
    now: () => 300,
    random: () => 0,
  });
  const recovery = recoverVaultSessions(f.db, f.client, { now: () => 400 });
  // Let an unprotected slot/recovery finish while Lens is still in flight.
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await Promise.all([lens, selection, recovery]);
  assert.equal(getVaultReward(f.db, vaultId).state, "delivered");
  const rewardMessage = f.messages.get(getVaultReward(f.db, vaultId).messageId);
  assert.notEqual(rewardMessage.id, message.id);
  assert.match(JSON.stringify(rewardMessage.payload), /received/);
  assert.match(JSON.stringify(message.payload), /"disabled":true/);
  assert.equal(getInventory(f.db, "guild", "owner", 400).length, 1);
  await recoverVaultSessions(f.db, f.client, { now: () => 1200 });
  assert.match(JSON.stringify(rewardMessage.payload), /received/);
});

test("a reward write catches up timeout reconciliation that commits during its transport await", async (t) => {
  const f = fixture(t);
  addItemToInventory(f.db, "guild", "owner", "fortunes_recast");
  addItemToInventory(f.db, "guild", "owner", "double_or_nothing");
  executeItemUse(f.db, "guild", "owner", "recast", [], { now: 100 });
  let { vaultId, message } = await bound(f);
  await onVaultInteraction(f.db, click(vaultId, message, "A"), {
    now: () => 200,
    random: () => 0,
  });
  message = f.messages.get(getVaultReward(f.db, vaultId).messageId);
  await onVaultInteraction(f.db, click(vaultId, message, "keep"), {
    now: () => 300,
  });
  await onVaultInteraction(f.db, click(vaultId, message, "recastopen"), {
    now: () => 400,
  });
  const deadline = getRecast(f.db, vaultId).deadline;
  // Recovery's public edit starts before timeout; a DB-only periodic scan commits
  // timeout Keep while that network operation is in flight.
  const edit = message.edit;
  // Make the fetched card stale so this test still exercises an actual edit await.
  // An already-correct recovery card now correctly performs no edit at all.
  message.payload = { ...message.payload, components: [] };
  let first = true;
  message.edit = async (payload) => {
    if (first) {
      first = false;
      reconcileVaultRewards(f.db, { now: deadline });
    }
    return edit(payload);
  };
  await recoverVaultSessions(f.db, f.client, { now: () => 500 });
  assert.equal(getVaultReward(f.db, vaultId).state, "delivered");
  assert.match(JSON.stringify(message.payload), /received/);
  assert.ok(!JSON.stringify(message.payload).includes("Open Recast choice"));
});

test("Lens expiry inspects REST rather than a stale cached unopened card before refunding", async (t) => {
  const f = fixture(t);
  addItemToInventory(f.db, "guild", "owner", "fortunes_lens");
  const { vaultId, message } = await bound(f);
  const stale = { ...message, payload: message.payload };
  await assert.rejects(
    onVaultInteraction(
      f.db,
      click(vaultId, message, "lens", {
        update: async (payload) => {
          await message.edit(payload);
          throw new Error("lost ack");
        },
      }),
      { now: () => 200, random: () => 0 },
    ),
    /lost ack/,
  );
  const requests = [];
  f.channel.messages.fetch = async (request) => {
    requests.push(request);
    return typeof request === "object" && request.force === true
      ? message
      : stale;
  };
  await recoverVaultSessions(f.db, f.client, { now: () => 1200 });
  assert.equal(getLens(f.db, vaultId).state, "presented");
  assert.equal(getInventory(f.db, "guild", "owner").length, 0);
  assert.deepEqual(requests[0], { message: message.id, force: true });
});

test("unshown Lens retains its zero-charge row through transient expiry, then refunds once after definitive inspection", async (t) => {
  const f = fixture(t);
  const source = addItemToInventory(
    f.db,
    "guild",
    "owner",
    "fortunes_lens",
  ).item;
  for (let i = 0; i < 4; i++)
    addItemToInventory(f.db, "guild", "owner", "hourglass_of_haste");
  const { vaultId, message } = await bound(f);
  await assert.rejects(
    onVaultInteraction(
      f.db,
      click(vaultId, message, "lens", {
        update: async () => {
          throw new Error("failed");
        },
      }),
      { now: () => 200 },
    ),
    /failed/,
  );
  f.reopen();
  f.fail(true);
  await recoverVaultSessions(f.db, f.client, { now: () => 1200 });
  assert.equal(
    getInventory(f.db, "guild", "owner").find((i) => i.id === source.id)
      .charges,
    0,
  );
  f.fail(false);
  await recoverVaultSessions(f.db, f.client, { now: () => 1300 });
  assert.equal(getLens(f.db, vaultId).state, "refunded");
  assert.equal(
    getInventory(f.db, "guild", "owner").find((i) => i.id === source.id)
      .charges,
    1,
  );
  await recoverVaultSessions(f.db, f.client, { now: () => 1400 });
  assert.equal(
    getInventory(f.db, "guild", "owner").find((i) => i.id === source.id)
      .charges,
    1,
  );
});
