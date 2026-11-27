import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";
import { Collection, Events } from "discord.js";
import { startBot } from "../app/bootstrap.js";
import { createFinalCatalog, openCatalog } from "../lib/catalogDb.js";
import { createRecoveryObserver } from "../lib/recoveryObservation.js";
import { createInteractionHandler } from "../app/events/interactionCreate.js";
import { registerUtilityCommands } from "../app/utilityCommands.js";

test("bot bootstrap logs the client in with handlers installed and ingress closed", async (t) => {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  const client = Object.assign(new EventEmitter(), {
    loggedIn: false,
    login: async (token) => {
      assert.equal(token, "test-token");
      assert.equal(client.listenerCount(Events.MessageCreate), 1);
      await client.listeners(Events.MessageCreate)[0]({
        get author() {
          assert.fail("ingress must stay closed");
        },
      });
      client.loggedIn = true;
    },
  });
  const bot = await startBot(
    { token: "test-token" },
    { client, openCatalog: () => db },
  );
  assert.equal(bot.client, client);
  assert.equal(client.loggedIn, true);
});

test("invalid restart state prevents handler registration and login", async (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("PRAGMA user_version=12");
  const client = Object.assign(new EventEmitter(), {
    login: () => assert.fail("must not log in"),
  });
  await assert.rejects(
    startBot(
      {},
      {
        client,
        openCatalog: () => db,
        validateRestart() {
          throw new Error("invalid restart");
        },
      },
    ),
    /invalid restart/,
  );
  assert.equal(client.eventNames().length, 0);
});

test("normal bot boot scans affection once and validates restart in the catalog read snapshot", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bot-bootstrap-"));
  const path = join(directory, "game.sqlite");
  createFinalCatalog(path).close();
  const records = [];
  const client = Object.assign(new EventEmitter(), { login: async () => {} });
  try {
    const bot = await startBot(
      { token: "test-token" },
      {
        client,
        catalogPath: path,
        startupObserver: createRecoveryObserver({
          log: (line) => records.push(JSON.parse(line)),
        }),
        validateRestart(db, settings) {
          assert.equal(db.isTransaction, true);
          assert.equal(settings.affectionStateValidated, true);
        },
      },
    );
    bot.catalogDb.close();
    const finished = records
      .filter((record) => record.event === "stage-finish")
      .map((record) => record.stage);
    assert.equal(
      finished.filter((stage) => stage === "affection-validation").length,
      1,
    );
    assert.ok(finished.includes("catalog-integrity"));
    assert.ok(finished.includes("restart-validation"));
  } finally {
    client.catalogDb?.isOpen && client.catalogDb.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("retired reward inbox is not routable and old controls only receive a removal notice", async () => {
  assert.equal(
    existsSync(new URL("../commands/rewards.js", import.meta.url)),
    false,
  );
  const { run } = await import("../commands/help.js");
  let help;
  await run({
    prefix: "?",
    message: {
      reply: async (payload) => {
        help = payload;
      },
    },
  });
  assert.doesNotMatch(JSON.stringify(help), /\*\*rewards\*\*/);
  const handle = createInteractionHandler({ yoshiko: {}, isReady: () => true });
  for (const customId of [
    "rewards:next",
    "rewards:accept:reward",
    "rewards:decline:reward",
    "rewardreplace:choose",
  ]) {
    const replies = [];
    await handle({ customId, reply: async (payload) => replies.push(payload) });
    assert.equal(replies.length, 1);
    assert.equal(replies[0].ephemeral, true);
    assert.match(replies[0].content, /inbox has been removed/);
    assert.match(replies[0].content, /original reward card/);
    assert.doesNotMatch(
      replies[0].content,
      /Run the command again|[!?]rewards/,
    );
  }
});

test("collector controls only get an expired reply when the live collector has not acknowledged", async () => {
  let fallback;
  const handle = createInteractionHandler({
    yoshiko: {},
    isReady: () => true,
    schedule: (callback, delay) => {
      assert.equal(delay, 500);
      fallback = callback;
      return { unref() {} };
    },
  });
  let replies = 0;
  const interaction = {
    customId: "xfer:confirm",
    deferred: false,
    reply: async () => {
      replies++;
    },
  };
  await handle(interaction);
  assert.equal(replies, 0);
  interaction.deferred = true;
  fallback();
  assert.equal(replies, 0);
  interaction.deferred = false;
  fallback();
  assert.equal(replies, 1);
});

test("utility commands register on ready and on guild create", async () => {
  const puts = [];
  const client = new EventEmitter();
  registerUtilityCommands(
    { client, config: { clientId: "123" }, commands: new Collection() },
    {
      put: async (...args) => {
        puts.push(args);
      },
    },
  );
  await client.listeners(Events.ClientReady)[0]({
    guilds: { cache: new Map([["1", {}]]) },
  });
  client.emit(Events.GuildCreate, { id: "2" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(puts.length, 2);
  assert.match(puts[0][0], /guilds\/1\/commands/);
  assert.match(puts[1][0], /guilds\/2\/commands/);
});
