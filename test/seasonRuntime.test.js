import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { installEmptyFinalCatalog } from "../lib/catalogFinalSchema.js";
import { installSeasonSchema } from "../lib/seasonSchema.js";
import {
  getSeasonStatus,
  previewRollover,
  queueRollover,
  saveSeasonSettings,
} from "../features/seasons/seasonSchedule.js";
import { runSeasonWork } from "../features/seasons/seasonRuntime.js";
import { addSeasonMessage } from "../features/seasons/seasonStore.js";

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
  now = preview.reminderAt;
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
  now = preview.reminderAt;
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
        members: { me: { id: "99" }, fetch: async () => new Map() },
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
