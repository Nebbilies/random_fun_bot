import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCatalog } from "../lib/catalogDb.js";
import { loadCharacterIndex } from "../lib/gameCharacterLookup.js";
import { addWish, getWishes } from "../lib/characterWishlist.js";
import { run as wish, listWishes } from "../commands/wish.js";
import { run as wl } from "../commands/wl.js";
import { run as wishlist } from "../commands/wishlist.js";
import { runRoll, startForcedEscape } from "../lib/characterRollRuntime.js";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "wishlist-command-"));
  const db = openCatalog(join(dir, "catalog.sqlite"));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  db.exec(`INSERT INTO characters (id,rank,favourites,name_full,name_native,name_alternatives,gender,image_url,anime_titles) VALUES
    (1,1,100,'One','Mot','["Uno"]','Female','https://example.com/1.png','["Show"]'),
    (2,2,90,'Two',NULL,NULL,'Male','https://example.com/2.png','["Show"]'),
    (3,3,80,'Three',NULL,NULL,'Female','https://example.com/3.png','["Show"]'),
    (4,4,70,'Four',NULL,NULL,'Female','https://example.com/4.png','["Show"]'),
    (5,5,60,'Five',NULL,NULL,'Female','https://example.com/5.png','["Show"]'),
    (6,6,50,'Six',NULL,NULL,'Female','https://example.com/6.png','["Show"]'),
    (7,7,40,'Seven',NULL,NULL,'Female','https://example.com/7.png','["Show"]'),
    (8,8,30,'Eight',NULL,NULL,'Female','https://example.com/8.png','["Show"]'),
    (9,9,20,'Shared','Shiro','["Shared Two"]','Female','https://example.com/9.png','["Show"]'),
    (10,10,10,'Shared','Kuro','["Shared One"]','Female','https://example.com/10.png','["Show"]')`);
  db.exec(`INSERT INTO character_identities (id, name_full, image_url)
    SELECT id, name_full, image_url FROM characters`);
  return db;
}

function context(db, args, { authorId = "101" } = {}) {
  const collector = Object.assign(new EventEmitter(), {
    stop: () => collector.emit("end"),
  });
  const replies = [];
  let payload;
  const reply = {
    id: "900",
    edit: async (value) => {
      payload = value;
      return reply;
    },
    createMessageComponentCollector: () => collector,
  };
  const ctx = {
    args,
    prefix: "!",
    yoshiko: { catalogDb: db, characterIndex: loadCharacterIndex(db) },
    message: {
      id: "100",
      guildId: "1",
      channelId: "10",
      author: { id: authorId },
      reply: async (value) => {
        payload = value;
        replies.push(value);
        return reply;
      },
    },
  };
  return { ctx, collector, replies, payload: () => payload };
}

function content(payload) {
  if (typeof payload === "string") return payload;
  if (payload.content) return payload.content;
  return payload.components
    .map((component) => {
      const json = component.toJSON ? component.toJSON() : component;
      if (json.content) return json.content;
      return (json.components ?? [])
        .flatMap((child) => child.components ?? [child])
        .map((child) => child.content ?? child.label ?? "")
        .join("\n");
    })
    .join("\n");
}

function selectMenu(payload) {
  for (const component of payload?.components ?? []) {
    const json = component.toJSON ? component.toJSON() : component;
    for (const child of json.components ?? []) {
      if (child.type === 1) {
        const menu = (child.components ?? []).find((item) => item.type === 3);
        if (menu) return menu;
      }
    }
  }
  return null;
}

async function choose(collector, characterId, userId = "101") {
  let updated;
  const interaction = {
    user: { id: userId },
    customId: "wish:choose",
    values: [String(characterId)],
    update: async (value) => {
      updated = value;
    },
    reply: async () => {},
    deferUpdate: async () => {},
  };
  collector.emit("collect", interaction);
  for (let attempt = 0; attempt < 50 && updated === undefined; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return updated;
}

test("!wish adds an exact match and answers with the wishlist", async (t) => {
  const db = fixture(t);
  const mock = context(db, ["wish", "Two"]);
  await wish(mock.ctx);
  assert.deepEqual(
    getWishes(db, { guildId: "1", userId: "101" }).map(
      (entry) => entry.characterId,
    ),
    [2],
  );
  assert.match(content(mock.payload()), /## Wishlist \(1\/7\)/);
  assert.match(content(mock.payload()), /#2 • Two/);
});

test("!wish accepts a rank, a native name, and an alternative name", async (t) => {
  const db = fixture(t);
  await wish(context(db, ["wish", "#3"]).ctx);
  await wish(context(db, ["wish", "Mot"]).ctx);
  await wish(context(db, ["wish", "Uno"]).ctx);
  assert.deepEqual(
    getWishes(db, { guildId: "1", userId: "101" }).map(
      (entry) => entry.characterId,
    ),
    [3, 1],
  );
});

test("!wish reports an unknown character and saves nothing", async (t) => {
  const db = fixture(t);
  const mock = context(db, ["wish", "Nobody"]);
  await wish(mock.ctx);
  assert.match(content(mock.payload()), /No character found/);
  assert.equal(getWishes(db, { guildId: "1", userId: "101" }).length, 0);
});

test("!wish with several matches shows a picker labellled rank and name, then saves the pick", async (t) => {
  const db = fixture(t);
  const mock = context(db, ["wish", "Shared"]);
  await wish(mock.ctx);
  const menu = selectMenu(mock.payload());
  assert.ok(menu, "expected a select menu");
  assert.deepEqual(
    menu.options.map((option) => option.label),
    ["#9 • Shared", "#10 • Shared"],
  );
  assert.equal(getWishes(db, { guildId: "1", userId: "101" }).length, 0);

  await choose(mock.collector, 9);
  assert.deepEqual(
    getWishes(db, { guildId: "1", userId: "101" }).map(
      (entry) => entry.characterId,
    ),
    [9],
  );
  const updated = await choose(mock.collector, 10, "999");
  assert.equal(updated, undefined, "a stranger must not save a wish");
  assert.deepEqual(
    getWishes(db, { guildId: "1", userId: "101" }).map(
      (entry) => entry.characterId,
    ),
    [9],
  );
});

test("the picker edits itself into the wishlist view after a choice", async (t) => {
  const db = fixture(t);
  const mock = context(db, ["wish", "Shared"]);
  await wish(mock.ctx);
  const updated = await choose(mock.collector, 9);
  assert.match(content(updated), /## Wishlist \(1\/7\)/);
  assert.match(content(updated), /#9 • Shared/);
});

test("!wish refuses an eighth wish and reports the duplicate", async (t) => {
  const db = fixture(t);
  for (const characterId of [1, 2, 3, 4, 5, 6, 7]) {
    addWish(db, { guildId: "1", userId: "101", characterId, now: characterId });
  }
  const full = context(db, ["wish", "Eight"]);
  await wish(full.ctx);
  assert.match(content(full.payload()), /wishlist is full \(7\/7\)/);
  assert.match(content(full.payload()), /!wish remove/);
  assert.equal(getWishes(db, { guildId: "1", userId: "101" }).length, 7);

  const duplicate = context(db, ["wish", "Two"]);
  await wish(duplicate.ctx);
  assert.match(content(duplicate.payload()), /already on your wishlist/i);
  assert.equal(getWishes(db, { guildId: "1", userId: "101" }).length, 7);
});

test("bare !wish, !wl, and !wishlist all render the same list and ignore trailing arguments", async (t) => {
  const db = fixture(t);
  addWish(db, { guildId: "1", userId: "101", characterId: 3, now: 1 });
  const bare = context(db, ["wish"]);
  await wish(bare.ctx);
  const aliased = context(db, ["wl"]);
  await wl(aliased.ctx);
  const spelled = context(db, ["wishlist", "remove", "Three"]);
  await wishlist(spelled.ctx);
  assert.equal(content(bare.payload()), content(aliased.payload()));
  assert.equal(content(bare.payload()), content(spelled.payload()));
  assert.match(content(spelled.payload()), /#3 • Three/);
  assert.equal(getWishes(db, { guildId: "1", userId: "101" }).length, 1);
});

test("!wish lists a wish whose character left the catalog without a rank", async (t) => {
  const db = fixture(t);
  addWish(db, { guildId: "1", userId: "101", characterId: 3, now: 1 });
  db.exec("DELETE FROM characters WHERE id = 3");
  const mock = context(db, ["wish"]);
  await wish(mock.ctx);
  assert.match(content(mock.payload()), /#\? • Three \(not in catalog\)/);
});

test("!wish shows how many slots are used and an empty state", async (t) => {
  const db = fixture(t);
  const empty = context(db, ["wish"]);
  await wish(empty.ctx);
  assert.match(content(empty.payload()), /## Wishlist \(0\/7\)/);
  assert.match(content(empty.payload()), /!wish <name>/);
});

test("!wish remove deletes only the caller's own wish", async (t) => {
  const db = fixture(t);
  addWish(db, { guildId: "1", userId: "101", characterId: 1, now: 1 });
  addWish(db, { guildId: "1", userId: "102", characterId: 2, now: 2 });
  const mock = context(db, ["wish", "remove", "One"]);
  await wish(mock.ctx);
  assert.deepEqual(getWishes(db, { guildId: "1", userId: "101" }), []);
  assert.equal(getWishes(db, { guildId: "1", userId: "102" }).length, 1);
  assert.match(content(mock.payload()), /## Wishlist \(0\/7\)/);
});

test("!wish remove reports a character that is not on the list", async (t) => {
  const db = fixture(t);
  addWish(db, { guildId: "1", userId: "101", characterId: 1, now: 1 });
  const mock = context(db, ["wish", "remove", "Two"]);
  await wish(mock.ctx);
  assert.match(content(mock.payload()), /isn't on your wishlist/);
  assert.equal(getWishes(db, { guildId: "1", userId: "101" }).length, 1);
});

test("!wish remove with several of your own matches picks from your entries only", async (t) => {
  const db = fixture(t);
  addWish(db, { guildId: "1", userId: "101", characterId: 9, now: 1 });
  addWish(db, { guildId: "1", userId: "101", characterId: 10, now: 2 });
  const mock = context(db, ["wish", "remove", "Shared"]);
  await wish(mock.ctx);
  const menu = selectMenu(mock.payload());
  assert.deepEqual(
    menu.options.map((option) => option.label),
    ["#9 • Shared", "#10 • Shared"],
  );
  await choose(mock.collector, 10);
  assert.deepEqual(
    getWishes(db, { guildId: "1", userId: "101" }).map(
      (entry) => entry.characterId,
    ),
    [9],
  );
});

test("!wish clear empties the list and reports it", async (t) => {
  const db = fixture(t);
  addWish(db, { guildId: "1", userId: "101", characterId: 1, now: 1 });
  addWish(db, { guildId: "1", userId: "101", characterId: 2, now: 2 });
  const mock = context(db, ["wish", "clear"]);
  await wish(mock.ctx);
  assert.equal(getWishes(db, { guildId: "1", userId: "101" }).length, 0);
  assert.match(content(mock.payload()), /## Wishlist \(0\/7\)/);
});

test("!wish without a name shows the usage hint", async (t) => {
  const db = fixture(t);
  const mock = context(db, ["wish"]);
  await wish(mock.ctx);
  assert.match(content(mock.payload()), /## Wishlist \(0\/7\)/);
  assert.match(content(mock.payload()), /!wish <name>/);
});

test("listWishes is the argument-free entry point used by the aliases", async (t) => {
  const db = fixture(t);
  addWish(db, { guildId: "1", userId: "101", characterId: 4, now: 1 });
  const mock = context(db, ["wl", "anything"]);
  await listWishes(mock.ctx);
  assert.match(content(mock.payload()), /#4 • Four/);
});

test("a rolled wishlist character turns the roll green and names every wisher", async (t) => {
  const db = fixture(t);
  db.exec("DELETE FROM characters WHERE id <> 1");
  addWish(db, { guildId: "1", userId: "201", characterId: 1, now: 5 });
  addWish(db, { guildId: "1", userId: "202", characterId: 1, now: 6 });
  const sent = [];
  let replyCard;
  const channel = {
    send: async (value) => {
      sent.push(value);
    },
  };
  replyCard = { id: "500", channel, react: async () => {} };
  const message = {
    id: "100",
    guildId: "1",
    channelId: "10",
    author: { id: "101" },
    channel,
    reply: async (value) => {
      sent.push(value);
      return replyCard;
    },
  };
  const yoshiko = {
    catalogDb: db,
    mysteryEnabled: false,
    vaultEnabled: false,
    imagePicker: { pick: async () => ({ url: "https://example.com/1.png" }) },
  };
  await runRoll({ message, yoshiko }, "w", () => 0.5);
  const payload = sent.at(-1);
  assert.match(content(payload), /⭐ <@201>, <@202>'s Wish/);
  const container = payload.components.find(
    (component) => component.toJSON().type === 17,
  );
  assert.equal(container.toJSON().accent_color, 0x57f287);
  assert.deepEqual(payload.allowedMentions.users, ["201", "202"]);
});

test("a roll nobody wished for stays pink and mentions nobody", async (t) => {
  const db = fixture(t);
  db.exec("DELETE FROM characters WHERE id <> 1");
  const sent = [];
  const channel = {
    send: async (value) => {
      sent.push(value);
    },
  };
  const message = {
    id: "101",
    guildId: "1",
    channelId: "10",
    author: { id: "101" },
    channel,
    reply: async (value) => {
      sent.push(value);
      return { id: "501", channel, react: async () => {} };
    },
  };
  const yoshiko = {
    catalogDb: db,
    mysteryEnabled: false,
    vaultEnabled: false,
    imagePicker: { pick: async () => ({ url: "https://example.com/1.png" }) },
  };
  await runRoll({ message, yoshiko }, "w", () => 0.5);
  const payload = sent.at(-1);
  assert.doesNotMatch(content(payload), /Wish/);
  const container = payload.components.find(
    (component) => component.toJSON().type === 17,
  );
  assert.equal(container.toJSON().accent_color, 0xe91e63);
  assert.deepEqual(payload.allowedMentions.users, []);
});

test("an item-forced escape announces wishers, greens the card, and pings once", async (t) => {
  const db = fixture(t);
  db.exec(`INSERT INTO marriages (guild_id, character_id, owner_id, married_at)
    VALUES ('1', 1, '777', '2024-01-01T00:00:00.000Z')`);
  addWish(db, { guildId: "1", userId: "201", characterId: 1, now: 5 });
  const sent = [];
  const channel = {
    send: async (value) => {
      sent.push(value);
      return {
        id: "502",
        edit: async (next) => {
          sent.push(next);
        },
        react: async () => {},
      };
    },
  };
  const timers = [];
  const result = await startForcedEscape({
    db,
    channel,
    guildId: "1",
    channelId: "10",
    commandMessageId: "100",
    ownerId: "777",
    characterId: 1,
    setTimer: (callback) => {
      timers.push(callback);
      return 1;
    },
    clearTimer: () => {},
  });
  assert.equal(result.status, "started");
  assert.match(content(sent[0]), /⭐ <@201>'s Wish/);
  assert.deepEqual(sent[0].allowedMentions.users, ["777", "201"]);
  assert.equal(
    sent[0].components[0].toJSON().type,
    10,
    "escape text stays first",
  );
  assert.equal(
    sent[0].components[1].toJSON().type,
    10,
    "wish line sits directly above the card",
  );
  const container = sent[0].components.find(
    (component) => component.toJSON().type === 17,
  );
  assert.equal(container.toJSON().accent_color, 0x57f287);
  assert.ok(timers.length > 0);
});

test("wishlist marks current-server marriages, including missing catalog entries", async (t) => {
  const db = fixture(t);
  for (const characterId of [1, 2, 3]) {
    addWish(db, { guildId: "1", userId: "101", characterId });
  }
  db.exec(`INSERT INTO marriages (guild_id, character_id, owner_id, married_at) VALUES
    ('1', 1, 'other', 'now'), ('2', 2, '101', 'now'), ('1', 3, 'other', 'now');
    DELETE FROM characters WHERE id = 3`);
  const harness = context(db, ["wl"]);
  await listWishes(harness.ctx);
  const text = content(harness.payload());
  assert.match(text, /One 💞/);
  assert.doesNotMatch(text, /Two 💞/);
  assert.match(text, /Three 💞 \(not in catalog\)/);
});
