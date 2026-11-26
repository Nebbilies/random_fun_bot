import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveGameCommand } from "../app/commandRegistry.js";
import { createFinalCatalog } from "../lib/catalogDb.js";

test("profile is recognized by the guild game command router", () => {
  assert.equal(resolveGameCommand("profile"), "profile");
});

function context(t) {
  const directory = mkdtempSync(join(tmpdir(), "profile-card-"));
  const db = createFinalCatalog(join(directory, "test.sqlite"));
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const names = ["Gamma", "Beta", "Alfa", "Eta", "Delta", "Tsukishiro Yanagi"];
  const ids = Array.from(
    { length: 19 },
    (_, i) => `${String(i + 1).padStart(8, "0")}-1111-4111-8111-111111111111`,
  );
  const identity = db.prepare(
    "INSERT INTO character_identities(id,name_full,creation_method) VALUES(?,?,'manual')",
  );
  const character = db.prepare(
    "INSERT INTO characters(id,rank,favourites,tie_order,likes_source,name_full) VALUES(?,?,0,?,'generated',?)",
  );
  const marriage = db.prepare(
    "INSERT INTO marriages(guild_id,character_id,owner_id,married_at) VALUES(?,?,?,'d')",
  );
  for (const [i, id] of ids.entries()) {
    const name = names[i] ?? `Character ${i}`;
    identity.run(id, name);
    if (i !== 2) character.run(id, i + 1, i + 1, name);
    marriage.run("1", id, i < 6 ? "101" : i < 12 ? "100" : "099");
  }
  marriage.run("2", ids[0], "101");
  const affection = db.prepare(
    "INSERT INTO character_affection VALUES(?,?,?, ?,0)",
  );
  [100, 100, 300, 0, 100, 0].forEach((points, i) =>
    affection.run("1", "101", ids[i], points),
  );
  affection.run("2", "101", ids[0], 2100);
  db.prepare("INSERT INTO player_soulmates VALUES ('1','101',?,0,0,1)").run(
    ids[5],
  );
  db.exec(
    "INSERT INTO franchises(id,display_name,created_at) VALUES(1,'Series B','d'),(2,'Series A','d')",
  );
  const franchise = db.prepare(
    "INSERT INTO character_franchise_memberships VALUES (?,?)",
  );
  for (const pair of [
    [ids[0], 1],
    [ids[1], 1],
    [ids[0], 2],
    [ids[4], 2],
    [ids[6], 1],
  ])
    franchise.run(...pair);

  db.exec(
    "INSERT INTO franchises(id,display_name,created_at) VALUES(3,'Main A','d'),(4,'Main B','d')",
  );
  db.prepare(
    "INSERT INTO character_main_franchises VALUES(?,3),(?,3),(?,4),(?,4)",
  ).run(ids[0], ids[1], ids[0], ids[6]);

  const replies = [];
  const edits = [];
  const member = {
    displayName: "NekoNova",
    displayAvatarURL: () => "https://cdn.discordapp.com/avatars/example.png",
  };
  const reply = {
    id: "200",
    edit: async (payload) => {
      edits.push(payload);
      return reply;
    },
  };
  const ctx = {
    prefix: "!",
    args: ["profile"],
    yoshiko: { catalogDb: db },
    message: {
      guildId: "1",
      author: { id: "101", username: "account" },
      member,
      guild: {
        members: {
          fetch: async ({ user }) =>
            new Map(
              user
                .filter((id) => id !== "099")
                .map((id) => [
                  id,
                  {
                    user: {
                      username: id,
                      displayAvatarURL: member.displayAvatarURL,
                    },
                  },
                ]),
            ),
        },
      },
      reply: async (payload) => {
        replies.push(payload);
        return reply;
      },
    },
  };
  return { ctx, replies, edits, db };
}

test("profile takes a read-only guild snapshot and replaces one reply with the card embed", async (t) => {
  const { createProfileCommand } = await import("../commands/profile.js");
  const { ctx, replies, edits, db } = context(t);
  const before = db.prepare("SELECT total_changes() AS n").get().n;
  const file = Buffer.from("png fixture");
  const run = createProfileCommand({
    preparePortraits: async (model) => {
      assert.equal(
        edits.at(-1).content,
        "Rendering your profile card...\n-# Preparing portraits...",
      );
      assert.equal(model.characterCount, 6);
      assert.equal(model.serverRank, 2);
      assert.equal(model.displayName, "NekoNova");
      assert.deepEqual(
        model.topCharacters.map(({ name, affection }) => [name, affection]),
        [
          ["Alfa", 300],
          ["Beta", 100],
          ["Delta", 100],
          ["Gamma", 100],
          ["Eta", 0],
        ],
      );
      assert.equal(model.soulmate.name, "Tsukishiro Yanagi");
      assert.deepEqual(
        model.topFranchises.map(({ name, count }) => [name, count]),
        [
          ["Main A", 2],
          ["Main B", 1],
        ],
      );
      return new Map();
    },
    renderProfileCard: async () => {
      assert.equal(
        edits.at(-1).content,
        "Rendering your profile card...\n-# Rendering image...",
      );
      return file;
    },
  });
  await run(ctx);
  assert.equal(replies.length, 1);
  assert.equal(
    replies[0].content,
    "Rendering your profile card...\n-# Loading collection stats...",
  );
  assert.equal(edits.length, 3);
  assert.equal(edits[2].content, null);
  assert.equal(edits[2].embeds[0].toJSON().title, "NekoNova's Profile Card");
  assert.equal(
    edits[2].embeds[0].toJSON().image.url,
    "attachment://profile-card.png",
  );
  assert.equal(edits[2].files[0].attachment, file);
  assert.equal(db.prepare("SELECT total_changes() AS n").get().n, before);
});

test("profile season selection edits the same card with frozen stats only for its requester", async (t) => {
  const { createProfileCommand } = await import("../commands/profile.js");
  const { ctx, replies, edits, db } = context(t);
  db.prepare(`INSERT INTO season_profiles VALUES ('1',0,'101',1,?)`).run(
    JSON.stringify({
      characterCount: 9,
      serverRank: 1,
      soulmate: null,
      topCharacters: [],
      topFranchises: [],
    }),
  );
  const hooks = new Map();
  const send = ctx.message.reply;
  ctx.message.reply = async (payload) => ({
    ...(await send(payload)),
    createMessageComponentCollector: () => ({
      on: (event, callback) => hooks.set(event, callback),
    }),
  });
  const models = [];
  await createProfileCommand({
    preparePortraits: async () => new Map(),
    renderProfileCard: async (model) => {
      models.push(model);
      return Buffer.from("png");
    },
  })(ctx);
  assert.deepEqual(
    edits
      .at(-1)
      .components[0].toJSON()
      .components[0].options.map((option) => option.value),
    ["current", "0"],
  );
  const select = hooks.get("collect");
  const base = {
    customId: "profile:season",
    guildId: "1",
    values: ["0"],
    deferUpdate: async () => {},
  };
  let denied;
  await select({
    ...base,
    user: { id: "102" },
    reply: async (payload) => {
      denied = payload.content;
    },
  });
  assert.match(denied, /Only the person/);
  assert.equal(models.length, 1);
  await select({ ...base, user: { id: "101" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    models.map((model) => model.characterCount),
    [6, 9],
  );
  assert.equal(replies.length, 1);
  assert.equal(edits.at(-1).embeds[0].toJSON().description, "Season 0");
});

test("profile edits the same reply if rendering fails", async (t) => {
  const { createProfileCommand } = await import("../commands/profile.js");
  const { ctx, replies, edits } = context(t);
  await createProfileCommand({
    preparePortraits: async () => new Map(),
    renderProfileCard: async () => {
      throw new Error("test render failure");
    },
    reportFailure: () => {},
  })(ctx);
  assert.equal(replies.length, 1);
  assert.equal(edits.length, 3);
  assert.match(edits[2].content, /-# Couldn’t render your profile card/);
  assert.equal(edits[2].files, undefined);
});

test("archive selection works during cutoff even when the component acknowledgement is slow", async (t) => {
  const { createProfileCommand } = await import("../commands/profile.js");
  const { createInteractionHandler } =
    await import("../app/events/interactionCreate.js");
  const { ctx, edits, db } = context(t);
  db.prepare("INSERT INTO season_profiles VALUES ('1',0,'101',1,?)").run(
    JSON.stringify({
      characterCount: 9,
      serverRank: 1,
      soulmate: null,
      topCharacters: [],
      topFranchises: [],
    }),
  );
  db.exec(`INSERT INTO season_rollovers
    (guild_id,season,revision,phase,channel_id,reminder_at,cutoff_at,requester)
    VALUES ('1',1,1,'announced','90',1,2,'admin')`);
  const hooks = new Map();
  const send = ctx.message.reply;
  ctx.message.reply = async (payload) => ({
    ...(await send(payload)),
    createMessageComponentCollector: () => ({
      on: (event, callback) => hooks.set(event, callback),
    }),
  });
  await createProfileCommand({
    preparePortraits: async () => new Map(),
    renderProfileCard: async (model) =>
      Buffer.from(String(model.characterCount)),
  })(ctx);
  assert.match(edits.at(-1).content, /next season is starting/i);
  assert.ok(edits.at(-1).components.length);
  let fallback, acknowledge;
  const route = createInteractionHandler({
    yoshiko: ctx.yoshiko,
    isReady: () => true,
    schedule(callback) {
      fallback = callback;
      return { unref() {} };
    },
  });
  const interaction = {
    customId: "profile:season",
    guildId: "1",
    values: ["0"],
    user: { id: "101" },
    deferUpdate: () =>
      new Promise((resolve) => {
        acknowledge = resolve;
      }),
    reply: async () =>
      assert.fail("Live selection received an expiration reply"),
  };
  await route(interaction);
  await hooks.get("collect")(interaction);
  fallback();
  acknowledge();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(edits.at(-1).embeds[0].toJSON().description, "Season 0");
  assert.equal(edits.at(-1).files[0].attachment.toString(), "9");
});

test("profile reports an unavailable server leaderboard on the original reply", async (t) => {
  const { createProfileCommand } = await import("../commands/profile.js");
  const { ctx, replies, edits } = context(t);
  ctx.message.guild.members.fetch = async () => {
    throw new Error("not available");
  };
  await createProfileCommand({
    preparePortraits: async () =>
      assert.fail("portraits shouldn’t start when stats fail"),
    reportFailure: () => {},
  })(ctx);
  assert.equal(replies.length, 1);
  assert.deepEqual(
    edits.map((edit) => edit.content),
    [
      "Rendering your profile card...\n-# Couldn’t load collection stats. Please try again.",
    ],
  );
});

test("profile edits the same reply after a failed attachment upload", async (t) => {
  const { createProfileCommand } = await import("../commands/profile.js");
  const { ctx, replies, edits } = context(t);
  const send = ctx.message.reply;
  ctx.message.reply = async (payload) => {
    const status = await send(payload);
    const edit = status.edit;
    status.edit = (value) =>
      value.files
        ? Promise.reject(new Error("attachment upload failed"))
        : edit(value);
    return status;
  };
  await createProfileCommand({
    preparePortraits: async () => new Map(),
    renderProfileCard: async () => Buffer.from("png fixture"),
    reportFailure: () => {},
  })(ctx);
  assert.equal(replies.length, 1);
  assert.equal(edits.length, 3);
  assert.match(edits[2].content, /-# Couldn’t upload your profile card/);
});

test("profile gives an empty collection no rank, soulmate or rows", async (t) => {
  const { loadProfileCardData } = await import("../lib/profileCardData.js");
  const { ctx, db } = context(t);
  ctx.message.author.id = "102";
  ctx.message.guild.members.fetch = async () =>
    assert.fail("an empty collection is unranked");
  const { characterCount, serverRank, soulmate, topCharacters, topFranchises } =
    await loadProfileCardData(db, ctx.message);
  assert.deepEqual(
    { characterCount, serverRank, soulmate, topCharacters, topFranchises },
    {
      characterCount: 0,
      serverRank: null,
      soulmate: null,
      topCharacters: [],
      topFranchises: [],
    },
  );
});

test("portrait preparation decodes shared portraits once and skips damaged ones", async () => {
  const { preparePortraits } = await import("../lib/profileCardRenderer.js");
  const { Canvas } = await import("skia-canvas");
  const sample = await new Canvas(2, 2, { gpu: false }).toBuffer("png");
  const received = [];
  const portraits = await preparePortraits(
    {
      avatarUrl: "avatar",
      soulmate: { portraitUrl: "character" },
      topCharacters: [
        { portraitUrl: "character" },
        { portraitUrl: "broken" },
        {},
      ],
    },
    async (url) => {
      received.push(url);
      return url === "broken" ? Buffer.from("not an image") : sample;
    },
  );
  assert.deepEqual(received, ["avatar", "character", "broken"]);
  assert.equal(portraits.get("character").width, 2);
  assert.equal(portraits.get("broken"), null);
});

test("the portrait downloader refuses non-HTTPS and private endpoints", async () => {
  const { downloadProfilePortrait } =
    await import("../lib/profileCardPortraits.js");
  for (const url of [
    "http://example.com/image.png",
    "https://127.0.0.1/portrait.png",
    "https://[::ffff:127.0.0.1]/asset.png",
    "https://[fc00::1]/asset.png",
    "https://user:pass@example.com/photo.png",
  ]) {
    await assert.rejects(
      downloadProfilePortrait(url),
      /must (use public HTTPS|be public)/,
    );
  }
});

test("Skia renders an Index PNG with a long soulmate name and missing portraits", async () => {
  const { renderProfileCard } = await import("../lib/profileCardRenderer.js");
  const png = await renderProfileCard(
    {
      displayName: "NekoNova",
      characterCount: 1,
      serverRank: 7,
      soulmate: { name: "Tsukishiro Yanagi", affection: 1420 },
      topCharacters: [{ name: "Tsukishiro Yanagi", affection: 1420 }],
      topFranchises: [{ name: "Frieren: Beyond Journey’s End", count: 1 }],
    },
    new Map(),
  );
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(png.readUInt32BE(16), 1440);
  assert.equal(png.readUInt32BE(20), 1080);
});
