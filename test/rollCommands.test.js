import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { openCatalog } from "../lib/catalogDb.js";
import { MAIN_FRANCHISE_DDL } from "../lib/catalogFinalSchema.js";
import {
  getRoll,
  getRollStatus,
  reserveRoll,
  failRoll,
} from "../lib/characterRolls.js";
import {
  onRollReaction,
  onRollReport,
  rollCard,
  runRoll,
} from "../lib/characterRollRuntime.js";
import { run as mu } from "../commands/mu.js";
import { run as ru } from "../commands/ru.js";
import { run as daily } from "../commands/daily.js";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "roll-command-"));
  const db = openCatalog(join(dir, "catalog.sqlite"));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  db.exec(
    "INSERT INTO characters (id,rank,favourites,name_full,gender,image_url,anime_titles) VALUES (1,1,100,'A <@999>','Female','https://example.com/a.png','[\"A Show\"]'),(2,2,90,'B','Male','https://example.com/b.png','[\"B Show\"]')",
  );
  db.exec(
    MAIN_FRANCHISE_DDL.replace("character_id TEXT", "character_id INTEGER"),
  );
  db.exec(`INSERT INTO franchises(id,display_name,created_at) VALUES(1,'A Franchise','now');
    INSERT INTO character_main_franchises VALUES(1,1);`);
  const sent = [];
  const reacted = [];
  const channel = {
    send: async (value) => {
      sent.push(value);
    },
  };
  const card = {
    id: "500",
    channel,
    react: async (emoji) => {
      reacted.push(emoji);
    },
  };
  const message = {
    id: "100",
    guildId: "1",
    channelId: "10",
    author: { id: "101" },
    channel,
    reply: async (value) => {
      sent.push(value);
      return card;
    },
  };
  const yoshiko = {
    catalogDb: db,
    mysteryEnabled: false,
    imagePicker: { pick: async () => ({ url: "https://example.com/a.png" }) },
  };
  return { db, sent, reacted, channel, card, message, yoshiko };
}

test("daily refills exhausted rolls, denies repeats across hours, and renews at Vietnam midnight", async (t) => {
  const x = fixture(t);
  let now = Date.parse("2026-10-17T16:30:00Z");
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    const ctx = { message: x.message, yoshiko: x.yoshiko };
    x.db
      .prepare(
        "INSERT INTO roll_allowances (guild_id,user_id,period,used) VALUES (?,?,?,7)",
      )
      .run("1", "101", Math.floor(now / 3_600_000));
    await daily(ctx);
    assert.equal(
      x.sent.at(-1),
      "Daily claimed! Your rolls are refilled to 7 for this hour.",
    );
    for (let i = 0; i < 7; i++) {
      const result = reserveRoll(x.db, {
        guildId: "1",
        userId: "101",
        channelId: "10",
        commandMessageId: String(1000 + i),
        pool: "w",
        now,
      });
      assert.equal(result.status, "reserved");
      assert.equal(result.remaining, 6 - i);
      failRoll(x.db, result.rollId);
    }
    await daily(ctx);
    assert.match(x.sent.at(-1), /already claimed.*00:00 UTC\+7/);
    assert.equal(getRollStatus(x.db, "1", "101", now).remaining, 0);
    now = Date.parse("2026-10-17T16:59:59.999Z");
    await daily(ctx);
    assert.match(x.sent.at(-1), /already claimed/);
    now++;
    await daily(ctx);
    assert.equal(
      x.sent.at(-1),
      "Daily claimed! Your rolls are refilled to 7 for this hour.",
    );
    now += 3_600_000;
    x.db
      .prepare(
        "UPDATE roll_allowances SET period = ?, used = 3 WHERE guild_id = ? AND user_id = ?",
      )
      .run(Math.floor(now / 3_600_000), "1", "101");
    await daily(ctx);
    assert.match(x.sent.at(-1), /already claimed/);
    assert.equal(getRollStatus(x.db, "1", "101", now).remaining, 4);
  } finally {
    Date.now = originalNow;
  }
});

test("card shows the main franchise under the name and keeps one report button", () => {
  const card = rollCard(
    {
      name_full: "A",
      anime_titles: '["A Show"]',
      main_franchise_names: '["A Franchise"]',
      rank: 1234,
      favourites: 1234,
    },
    { url: "https://example.com/a.png" },
    6,
  );
  const content = JSON.stringify(
    card.components.map((component) => component.toJSON()),
  );
  assert.match(content, /A Franchise/);
  assert.doesNotMatch(content, /A Show/);
  assert.ok(content.indexOf("A Franchise") > content.indexOf("# A"));
  assert.ok(
    content.indexOf("A Franchise") < content.indexOf("**Rank:** #1,234"),
  );
  assert.match(content, /\*\*Rank:\*\* #1,234/);
  assert.doesNotMatch(content, /Likes|Favorites/);
  assert.match(content, /Report tag/);
  assert.match(content, /6 rolls left/);
  assert.doesNotMatch(content, /Other names:|Image source|Next|Previous/);
  assert.equal((content.match(/Report tag/g) || []).length, 1);
  const unknown = rollCard(
    { name_full: "B", anime_titles: null, rank: 13, favourites: 0 },
    null,
    1,
  );
  const unassigned = unknown.components[0].toJSON();
  assert.ok("components" in unassigned);
  assert.deepEqual(
    unassigned.components
      .slice(0, 2)
      .map((component) => "content" in component && component.content),
    ["# B", "**Rank:** #13"],
  );
  assert.match(
    JSON.stringify(unknown.components.map((component) => component.toJSON())),
    /1 roll left/,
  );
});

test("roll cards hide archived likes for generated and imported characters", () => {
  const character = {
    name_full: "Chell",
    anime_titles: null,
    rank: 100,
    favourites: 5050,
    likes_source: "generated",
  };
  const render = (value) =>
    JSON.stringify(
      rollCard(value, null, 6).components.map((component) =>
        component.toJSON(),
      ),
    );
  assert.doesNotMatch(render(character), /5,050|Likes|\[generated\]/);
  assert.doesNotMatch(
    render({ ...character, likes_source: "anilist" }),
    /5,050|Likes|\[generated\]/,
  );
});

test("shared 1% prank chance runs before character selection in either pool", async (t) => {
  for (const [draw, prank, title, pool] of [
    [0, "dog_clap", "ur roll gone", "w"],
    [0.004999, "dog_clap", "ur roll gone", "h"],
    [0.005, "john_pork", "john ate ur roll", "w"],
    [0.009999, "john_pork", "john ate ur roll", "h"],
  ]) {
    const x = fixture(t);
    x.db.exec("DELETE FROM characters");
    let draws = 0;
    x.yoshiko.imagePicker.pick = async () => {
      throw new Error("Must not look up an image");
    };
    const random = () => {
      assert.equal(++draws, 1);
      return Number(draw);
    };
    await runRoll({ message: x.message, yoshiko: x.yoshiko }, pool, random);
    const payload = x.sent[0];
    const components = payload.components[0].toJSON().components;
    assert.equal(components[0].content, `# ${title}`);
    assert.equal(components[1].content, "- ");
    assert.equal(components[2].content, "**Rank:** ?");
    assert.equal(components[3].items[0].media.url, `attachment://${prank}.gif`);
    assert.ok(existsSync(payload.files[0].attachment));
    assert.equal(payload.files[0].name, `${prank}.gif`);
    assert.doesNotMatch(JSON.stringify(components), /Report tag|custom_id/);
    assert.deepEqual(x.reacted, []);
    assert.equal(getRollStatus(x.db, "1", "101").remaining, 6);
    assert.equal(
      x.db.prepare("SELECT COUNT(*) AS n FROM mystery_sessions").get()?.n,
      0,
    );
    assert.equal(
      x.db
        .prepare(
          "SELECT COUNT(*) AS n FROM character_rolls WHERE state IN ('pending','open')",
        )
        .get()?.n,
      0,
    );
    await runRoll({ message: x.message, yoshiko: x.yoshiko }, pool, () => {
      throw new Error("Duplicate rerolled");
    });
    assert.equal(x.sent.length, 1);
    assert.equal(getRollStatus(x.db, "1", "101").remaining, 6);
  }
});

test("1% boundary proceeds to character selection; exhausted rolls skip the prank check", async (t) => {
  const x = fixture(t);
  const draws = [0.01, 0];
  await runRoll({ message: x.message, yoshiko: x.yoshiko }, "w", () => {
    const draw = draws.shift();
    assert.notEqual(draw, undefined);
    return draw ?? 0;
  });
  assert.equal(draws.length, 0);
  assert.match(JSON.stringify(x.sent[0].components[0].toJSON()), /Report tag/);
  x.message.id = "101";
  x.db.exec("UPDATE roll_allowances SET used = 7");
  await runRoll({ message: x.message, yoshiko: x.yoshiko }, "w", () => {
    throw new Error("Exhausted roll drew");
  });
  assert.match(x.sent.at(-1), /No rolls left/);
});

test("roll publishes before reacting; heart claims immediately and report stays usable", async (t) => {
  const x = fixture(t);
  await runRoll({ message: x.message, yoshiko: x.yoshiko }, "w", () => 0.5);
  const cardText = JSON.stringify(
    x.sent[0].components.map((component) => component.toJSON()),
  );
  assert.match(cardText, /A Franchise/);
  assert.doesNotMatch(cardText, /A Show/);
  assert.match(
    JSON.stringify(x.sent[0].components.map((component) => component.toJSON())),
    /6 rolls left/,
  );
  assert.deepEqual(x.reacted, ["❤️"]);
  assert.equal(getRoll(x.db, "1", "10", "500").state, "open");
  const reaction = {
    emoji: { name: "❤️" },
    message: { id: "500", guildId: "1", channelId: "10", channel: x.channel },
  };
  await onRollReaction(x.yoshiko, reaction, { id: "102", bot: false });
  assert.equal(
    x.db.prepare("SELECT owner_id FROM marriages WHERE character_id = 1").get()
      ?.owner_id,
    "102",
  );
  assert.equal(x.sent.at(-1).content, "<@102> has married **A <@999>** 🎉");
  assert.deepEqual(x.sent.at(-1).allowedMentions.users, ["102"]);
  const replies = [];
  const interaction = {
    isButton: () => true,
    customId: "roll:report",
    guildId: "1",
    channelId: "10",
    message: { id: "500" },
    user: { id: "103" },
    reply: async (value) => {
      replies.push(value);
    },
  };
  assert.equal(await onRollReport(x.db, interaction), true);
  assert.match(replies[0].content, /saved/);
});

for (const cached of [true, false])
  test(`marriage announces before a blocked card edit (${cached ? "cached V2" : "uncached"} card)`, async (t) => {
    const x = fixture(t);
    await runRoll({ message: x.message, yoshiko: x.yoshiko }, "w", () => 0.5);
    const components = x.sent[0].components;
    let fetches = 0;
    /** @type {any} */
    let edited;
    let release = () => {};
    const blocked = new Promise((resolve) => {
      release = () => resolve(undefined);
    });
    const card = {
      id: "500",
      guildId: "1",
      channelId: "10",
      channel: x.channel,
      embeds: [],
      components: cached ? components : [],
      fetch: async () => {
        fetches++;
        return { ...card, components };
      },
      edit: async (payload) => {
        edited = payload;
        await blocked;
      },
    };
    const claiming = onRollReaction(
      x.yoshiko,
      { emoji: { name: "❤️" }, message: card },
      { id: "102", bot: false },
    );
    try {
      // Flush promise continuations without letting a blocked cosmetic edit finish.
      await new Promise((resolve) => setImmediate(resolve));
      assert.match(x.sent.at(-1).content, /<@102> has married/);
      assert.equal(fetches, cached ? 0 : 1);
      assert.equal(
        edited.components.find((c) => c.toJSON().type === 17).toJSON()
          .accent_color,
        0x8b4513,
      );
      assert.match(JSON.stringify(edited.components), /Report tag/);
      assert.deepEqual(edited.allowedMentions, {
        parse: [],
        repliedUser: false,
      });
      assert.equal(
        x.db
          .prepare("SELECT owner_id FROM marriages WHERE character_id=1")
          .get()?.owner_id,
        "102",
      );
    } finally {
      release();
      await claiming;
    }
  });

test("marriage announces while an uncached card fetch is still pending", async (t) => {
  const x = fixture(t);
  await runRoll({ message: x.message, yoshiko: x.yoshiko }, "w", () => 0.5);
  let release = () => {};
  const blocked = new Promise((resolve) => {
    release = () => resolve(undefined);
  });
  const card = {
    id: "500",
    guildId: "1",
    channelId: "10",
    channel: x.channel,
    embeds: [],
    components: [],
    fetch: async () => {
      await blocked;
      return card;
    },
  };
  const claiming = onRollReaction(
    x.yoshiko,
    { emoji: { name: "❤️" }, message: card },
    { id: "102", bot: false },
  );
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(x.sent.at(-1).content, /<@102> has married/);
  } finally {
    release();
    await claiming;
  }
});

for (const failure of ["fetch", "edit", "announcement"])
  test(`marriage retains ownership and attempts independent feedback after ${failure} failure`, async (t) => {
    const x = fixture(t);
    await runRoll({ message: x.message, yoshiko: x.yoshiko }, "w", () => 0.5);
    t.mock.method(console, "error", () => {});
    let announced = 0;
    let edited = 0;
    const components = x.sent[0].components;
    x.channel.send = async () => {
      announced++;
      if (failure === "announcement") throw new Error("Send failed");
    };
    const card = {
      id: "500",
      guildId: "1",
      channelId: "10",
      channel: x.channel,
      embeds: [],
      components: failure === "fetch" ? [] : components,
      fetch: async () => {
        throw new Error("Fetch failed");
      },
      edit: async () => {
        edited++;
        if (failure === "edit") throw new Error("Edit failed");
      },
    };
    await onRollReaction(
      x.yoshiko,
      { emoji: { name: "❤️" }, message: card },
      { id: "102", bot: false },
    );
    assert.equal(announced, 1);
    assert.equal(edited, failure === "fetch" ? 0 : 1);
    assert.equal(
      x.db.prepare("SELECT owner_id FROM marriages WHERE character_id=1").get()
        ?.owner_id,
      "102",
    );
  });

test("failed heart closes card but consumes roll", async (t) => {
  const x = fixture(t);
  x.card.react = async () => {
    throw new Error("Missing permissions");
  };
  const previous = console.error;
  console.error = () => {};
  try {
    await runRoll({ message: x.message, yoshiko: x.yoshiko }, "w", () => 0.5);
  } finally {
    console.error = previous;
  }
  assert.equal(getRoll(x.db, "1", "10", "500").state, "failed");
  assert.equal(
    x.db
      .prepare(
        "SELECT used FROM roll_allowances WHERE guild_id = '1' AND user_id = '101'",
      )
      .get()?.used,
    1,
  );
});

test("mu and ru show available and exhausted allowances with reset countdowns", async (t) => {
  const x = fixture(t);
  const now = Date.parse("2026-10-15T17:30:00Z");
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    await mu({ message: x.message, yoshiko: x.yoshiko });
    await ru({ message: x.message, yoshiko: x.yoshiko });
    assert.equal(
      x.sent[0],
      "You can claim right now! The next claim reset is in **2h 30 min**.",
    );
    assert.equal(
      x.sent[1],
      "You have 7 rolls left. Next rolls reset in **30 min**.",
    );
    x.db
      .prepare(
        "INSERT INTO claim_allowances (guild_id,user_id,period) VALUES (?,?,?)",
      )
      .run("1", "101", Math.floor((now + 7 * 3_600_000) / (3 * 3_600_000)));
    x.db
      .prepare(
        "INSERT INTO roll_allowances (guild_id,user_id,period,used) VALUES (?,?,?,?)",
      )
      .run("1", "101", Math.floor(now / 3_600_000), 5);
    await mu({ message: x.message, yoshiko: x.yoshiko });
    await ru({ message: x.message, yoshiko: x.yoshiko });
    assert.equal(
      x.sent[2],
      "You can't claim right now. The next claim reset is in **2h 30 min**.",
    );
    assert.equal(
      x.sent[3],
      "You have 2 rolls left. Next rolls reset in **30 min**.",
    );
  } finally {
    Date.now = originalNow;
  }
});

test("mu and ru support targeting other users by mention or ID, and validate arguments", async (t) => {
  const x = fixture(t);
  const now = Date.parse("2026-10-15T17:30:00Z");
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    // Target 102 who has consumed 4 rolls and claimed
    x.db
      .prepare(
        "INSERT INTO claim_allowances (guild_id,user_id,period) VALUES (?,?,?)",
      )
      .run("1", "102", Math.floor((now + 7 * 3_600_000) / (3 * 3_600_000)));
    x.db
      .prepare(
        "INSERT INTO roll_allowances (guild_id,user_id,period,used) VALUES (?,?,?,?)",
      )
      .run("1", "102", Math.floor(now / 3_600_000), 4);

    // Target via mention
    await mu({
      message: x.message,
      yoshiko: x.yoshiko,
      prefix: "!",
      args: ["mu", "<@102>"],
    });
    await ru({
      message: x.message,
      yoshiko: x.yoshiko,
      prefix: "!",
      args: ["ru", "<@102>"],
    });
    assert.equal(
      x.sent.at(-2),
      "<@102> can't claim right now. The next claim reset is in **2h 30 min**.",
    );
    assert.equal(
      x.sent.at(-1),
      "<@102> has 3 rolls left. Next rolls reset in **30 min**.",
    );

    // Target via raw ID
    await mu({
      message: x.message,
      yoshiko: x.yoshiko,
      prefix: "!",
      args: ["mu", "102"],
    });
    await ru({
      message: x.message,
      yoshiko: x.yoshiko,
      prefix: "!",
      args: ["ru", "102"],
    });
    assert.equal(
      x.sent.at(-2),
      "<@102> can't claim right now. The next claim reset is in **2h 30 min**.",
    );
    assert.equal(
      x.sent.at(-1),
      "<@102> has 3 rolls left. Next rolls reset in **30 min**.",
    );

    // Invalid argument
    await mu({
      message: x.message,
      yoshiko: x.yoshiko,
      prefix: "!",
      args: ["mu", "invalid_user"],
    });
    assert.equal(x.sent.at(-1), "Usage: !mu [@user]");
    await ru({
      message: x.message,
      yoshiko: x.yoshiko,
      prefix: "!",
      args: ["ru", "invalid_user"],
    });
    assert.equal(x.sent.at(-1), "Usage: !ru [@user]");

    // Too many arguments
    await mu({
      message: x.message,
      yoshiko: x.yoshiko,
      prefix: "!",
      args: ["mu", "<@102>", "extra"],
    });
    assert.equal(x.sent.at(-1), "Usage: !mu [@user]");
    await ru({
      message: x.message,
      yoshiko: x.yoshiko,
      prefix: "!",
      args: ["ru", "<@102>", "extra"],
    });
    assert.equal(x.sent.at(-1), "Usage: !ru [@user]");
  } finally {
    Date.now = originalNow;
  }
});
