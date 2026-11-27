import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { installEmptyFinalCatalog } from "../lib/catalogFinalSchema.js";
import { installSeasonSchema } from "../lib/seasonSchema.js";
import {
  cancelRollover,
  getSeasonStatus,
  previewRollover,
  queueRollover,
  saveSeasonSettings,
} from "../features/seasons/seasonSchedule.js";
import { runSeasonWork } from "../features/seasons/seasonRuntime.js";
import { addSeasonMessage } from "../features/seasons/seasonStore.js";
import { startRecoveryWorker } from "../app/recoveryWorker.js";

function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("PRAGMA foreign_keys=ON");
  installEmptyFinalCatalog(db);
  installSeasonSchema(db);
  db.exec(
    "INSERT INTO roll_allowances VALUES('10','101',123,1),('10','102',123,1)",
  );
  saveSeasonSettings(db, { guildId: "10", channelId: "90", targetDays: 30 });
  return db;
}

function reminderFixture(t, send = undefined) {
  const db = fixture(t);
  db.exec("UPDATE guild_season_settings SET channel_checked_at=1");
  const sent = [];
  const edited = [];
  let now = Date.now();
  const channel = {
    guildId: "10",
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    messages: {
      fetch: async () => new Map(sent.map((message) => [message.id, message])),
      async edit(id, payload) {
        edited.push({ id, ...payload });
      },
    },
    async send(payload) {
      await send?.(payload);
      const message = {
        ...payload,
        id: String(sent.length + 1),
        createdTimestamp: now,
        author: { id: "99" },
      };
      sent.push(message);
      return message;
    },
  };
  const guild = {
    channels: { fetch: async () => channel },
    members: {
      me: { id: "99" },
      fetch: async () => new Map([["101", { user: { id: "101" } }]]),
    },
  };
  const client = { user: { id: "99" }, guilds: { fetch: async () => guild } };
  return {
    db,
    client,
    sent,
    edited,
    guild,
    channel,
    setTime: (time) => {
      now = time;
    },
    queue() {
      return queueRollover(db, {
        guildId: "10",
        requester: "admin",
        preview: previewRollover(db, "10", now),
        now,
      });
    },
    run: () => runSeasonWork({ db, client, now: () => now }),
    cancel(rollover) {
      cancelRollover(db, { guildId: "10", revision: rollover.revision, now });
    },
    status: () => getSeasonStatus(db, "10", now),
  };
}

test("season polling picks up confirmations without waiting for general recovery", async (t) => {
  const f = reminderFixture(t);
  const callbacks = new Map();
  startRecoveryWorker(
    { yoshiko: { catalogDb: f.db, client: f.client }, recoveryOperations: {} },
    {
      schedule(callback, ms) {
        callbacks.set(ms, callback);
        return { unref() {} };
      },
      runRecovery: () => assert.fail("The fast poll must only run season work"),
    },
  );
  f.queue();
  assert.equal(typeof callbacks.get(1000), "function");
  await callbacks.get(1000)();
  assert.equal(f.status().rollover.phase, "announced");
  assert.match(f.sent[0].content, /Choose the soulmate/);
});

test("the public reminder posts even when player mention lookup fails", async (t) => {
  const f = reminderFixture(t);
  f.setTime(1_800_000_000_000);
  const fetch = f.guild.members.fetch;
  f.guild.members.fetch = async () => {
    throw new Error("Roster unavailable");
  };
  const rollover = f.queue();
  await f.run();
  assert.equal(f.status().rollover.phase, "announced");
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].content, /Choose the soulmate/);
  f.guild.members.fetch = fetch;
  f.setTime(rollover.reminder_at + 6000);
  await f.run();
  assert.deepEqual(f.sent[1].allowedMentions.users, ["101"]);
});

test("an in-flight reminder is corrected after cancellation and reconfirmation", async (t) => {
  const started = Promise.withResolvers();
  const held = Promise.withResolvers();
  const f = reminderFixture(t, () => {
    started.resolve();
    return held.promise;
  });
  f.setTime(1_800_000_000_000);
  const old = f.queue();
  const work = f.run();
  await started.promise;
  f.cancel(old);
  const next = f.queue();
  held.resolve();
  await work;
  await f.run();
  assert.equal(next.revision, old.revision + 1);
  assert.equal(f.status().rollover.revision, next.revision);
  assert.equal(f.status().rollover.phase, "announced");
  assert.equal(
    f.sent.filter((message) => message.allowedMentions.users.length).length,
    1,
  );
  assert.deepEqual(
    f.edited.map(({ id }) => id),
    ["1"],
  );
  assert.match(f.edited[0].content, /canceled/i);
  f.cancel(next);
  f.setTime(next.cutoff_at);
  await f.run();
  await f.run();
  assert.equal(f.status().current.season, 1);
  assert.equal(f.status().rollover.phase, "canceled");
  assert.equal(f.edited.length, 2);
});

test("a definitive rejection retries at the original cutoff and cancels if still undelivered", async (t) => {
  let attempts = 0;
  const f = reminderFixture(t, () => {
    attempts++;
    throw Object.assign(new Error("Cannot post"), { status: 403 });
  });
  f.setTime(1_800_000_000_000);
  const rollover = f.queue();
  await f.run();
  f.setTime(rollover.reminder_at + 6000);
  await f.run();
  assert.equal(attempts, 2);
  assert.equal(f.status().rollover.cutoff_at, rollover.cutoff_at);
  f.setTime(rollover.cutoff_at);
  await f.run();
  assert.equal(attempts, 2);
  assert.equal(f.status().rollover.phase, "canceled");
  assert.equal(f.status().current.season, 1);
});

test("a Discord reminder posted at cutoff is corrected without advancing the season", async (t) => {
  const started = Promise.withResolvers();
  const held = Promise.withResolvers();
  const f = reminderFixture(t, () => {
    started.resolve();
    return held.promise;
  });
  const rollover = f.queue();
  const work = f.run();
  await started.promise;
  f.setTime(rollover.cutoff_at);
  held.resolve();
  await work;
  await f.run();
  assert.equal(f.status().current.season, 1);
  assert.equal(f.status().rollover.phase, "canceled");
  assert.equal(f.sent.length, 1);
  assert.match(f.edited[0].content, /canceled/i);
});

test("a canceled reminder with a lost acknowledgement is corrected before the new revision posts", async (t) => {
  const f = reminderFixture(t);
  f.setTime(1_800_000_000_000);
  const send = f.channel.send;
  f.channel.send = async (payload) => {
    await send(payload);
    throw new Error("Lost acknowledgement");
  };
  const first = f.queue();
  await f.run();
  f.cancel(first);
  const next = f.queue();
  f.channel.send = send;
  f.setTime(first.reminder_at + 6000);
  await f.run();
  assert.deepEqual(
    f.edited.map(({ id }) => id),
    ["1"],
  );
  assert.equal(f.sent.length, 1);
  await f.run();
  assert.equal(f.status().rollover.revision, next.revision);
  assert.equal(f.status().rollover.phase, "announced");
  assert.notEqual(f.sent[0].nonce, f.sent[1].nonce);
});

test("history proves a reminder was posted before cutoff even after that cutoff passes", async (t) => {
  const f = reminderFixture(t);
  f.setTime(1_800_000_000_000);
  const send = f.channel.send;
  f.channel.send = async (payload) => {
    await send(payload);
    throw new Error("Lost acknowledgement");
  };
  const rollover = f.queue();
  await f.run();
  f.channel.send = send;
  f.setTime(rollover.cutoff_at);
  await f.run();
  await f.run();
  assert.equal(f.status().current.season, 2);
  assert.equal(f.status().current.startedAt, rollover.cutoff_at);
  assert.equal(f.sent.length, 2);
  assert.match(f.sent[1].content, /Season 2 has started/);
});

test("the bot posts a reminder, pings only present players, and announces the next season after cutoff", async (t) => {
  const db = fixture(t);
  const messages = [];
  const channel = {
    guildId: "10",
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    async send(message) {
      messages.push(message);
      return { id: String(messages.length) };
    },
  };
  const guild = {
    channels: { fetch: async () => channel },
    members: {
      me: { id: "99" },
      fetch: async () => new Map([["101", { user: { id: "101" } }]]),
    },
  };
  const client = { guilds: { fetch: async () => guild } };
  let now = Date.now();
  const run = () => runSeasonWork({ db, client, now: () => now });
  await run();
  const preview = previewRollover(db, "10", now);
  queueRollover(db, { guildId: "10", requester: "admin", preview, now });
  await run();
  assert.equal(getSeasonStatus(db, "10").rollover.phase, "announced");
  assert.match(messages[0].content, /Choose the soulmate/);
  assert.deepEqual(messages[1].allowedMentions.users, ["101"]);
  now = preview.cutoffAt;
  await run();
  await run();
  assert.equal(getSeasonStatus(db, "10").current.season, 2);
  assert.match(messages[2].content, /Season 2 has started/);
  assert.equal(messages.length, 3);
  assert.deepEqual(
    db
      .prepare("SELECT user_id FROM season_profiles ORDER BY user_id")
      .all()
      .map((row) => row.user_id),
    ["101", "102"],
  );
});

test("a restart reconciles an ambiguous reminder send without changing its published cutoff", async (t) => {
  const db = fixture(t);
  let now = Date.now();
  const messages = [];
  const newerMessages = [];
  const channel = {
    guildId: "10",
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    messages: {
      fetch: async ({ before, limit }) =>
        new Map(
          [...messages, ...newerMessages]
            .filter((message) => !before || Number(message.id) < Number(before))
            .sort((a, b) => b.createdTimestamp - a.createdTimestamp)
            .slice(0, limit)
            .map((message) => [message.id, message]),
        ),
    },
    async send({ content }) {
      const message = {
        content,
        id: String(messages.length + 1),
        createdTimestamp: now,
        author: { id: "99" },
      };
      messages.push(message);
      if (messages.length === 1) throw new Error("Lost acknowledgement");
      return message;
    },
  };
  const guild = {
    channels: { fetch: async () => channel },
    members: {
      me: { id: "99" },
      fetch: async () => new Map([["101", { user: { id: "101" } }]]),
    },
  };
  const client = { user: { id: "99" }, guilds: { fetch: async () => guild } };
  const run = () => runSeasonWork({ db, client, now: () => now });
  await run();
  const preview = previewRollover(db, "10", now);
  queueRollover(db, { guildId: "10", requester: "admin", preview, now });
  await run();
  assert.equal(getSeasonStatus(db, "10").rollover.phase, "posting");
  now += 6_000;
  for (let i = 0; i < 501; i++)
    newerMessages.push({
      id: String(i + 10),
      createdTimestamp: now + i,
      author: { id: "98" },
      content: "Activity",
    });
  await run();
  assert.equal(getSeasonStatus(db, "10").rollover.phase, "posting");
  await run();
  const { rollover } = getSeasonStatus(db, "10");
  assert.equal(rollover.phase, "announced");
  assert.equal(rollover.cutoff_at, preview.cutoffAt);
  assert.equal(
    messages.filter((message) =>
      message.content.includes("Choose the soulmate"),
    ).length,
    1,
  );
});

test("inaccessible ping batches yield to other guilds and expire at cutoff", async (t) => {
  const db = fixture(t);
  let now = Date.now();
  const cutoff = now + 1000;
  db.exec(
    "UPDATE guild_season_settings SET channel_checked_at=1; INSERT INTO roll_allowances VALUES('20','201',123,1)",
  );
  const schedule = db.prepare(`INSERT INTO season_rollovers
    (guild_id,season,revision,phase,channel_id,reminder_at,cutoff_at,requester,announced_at)
    VALUES (?,1,1,'announced',?,?,?,?,?)`);
  const rollover = db.prepare(
    "SELECT * FROM season_rollovers WHERE guild_id=?",
  );
  schedule.run("10", "90", now - 2, cutoff, "admin", now - 2);
  schedule.run("20", "91", now - 1, cutoff + 10_000, "admin", now - 1);
  for (let part = 0; part < 24; part++)
    addSeasonMessage(db, rollover.get("10"), "ping", { part, users: ["101"] });
  addSeasonMessage(db, rollover.get("20"), "ping", { users: ["201"] });
  const messages = [];
  let unreachable = true;
  const client = {
    guilds: {
      fetch: async (guildId) => ({
        channels: {
          fetch: async () => {
            if (guildId === "10" && unreachable)
              throw new Error("Unknown channel");
            return {
              guildId,
              isTextBased: () => true,
              permissionsFor: () => ({ has: () => true }),
              async send(message) {
                messages.push({ guildId, ...message });
                return { id: String(messages.length) };
              },
            };
          },
        },
        members: {
          me: { id: "99" },
          fetch: async () => new Map([["201", { user: { id: "201" } }]]),
        },
      }),
    },
  };
  const run = () => runSeasonWork({ db, client, now: () => now });
  await run();
  assert.deepEqual(messages, []);
  await run();
  assert.deepEqual(messages[0].allowedMentions.users, ["201"]);
  unreachable = false;
  now = cutoff + 6000;
  await run();
  assert.equal(messages.length, 2);
  assert.match(messages[1].content, /Season 2 has started/);
});
