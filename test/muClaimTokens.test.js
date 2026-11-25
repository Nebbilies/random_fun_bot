import assert from "node:assert/strict";
import { test } from "node:test";
import { openCatalog } from "../lib/catalogDb.js";
import { addActiveBuff, consumeBuffRoll } from "../lib/itemStorage.js";
import { run as mu } from "../commands/mu.js";

function fixture(t) {
  t.mock.method(Date, "now", () => Date.parse("2026-10-24T17:30:00Z"));
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  const sent = [];
  const message = {
    guildId: "1",
    author: { id: "101" },
    reply: async (text) => sent.push(text),
  };
  const show = async (target) => {
    await mu({
      message,
      yoshiko: { catalogDb: db },
      args: target ? ["mu", target] : ["mu"],
    });
    return sent.at(-1);
  };
  return { db, show };
}

test("mu displays summed personal extra claim tokens under the unchanged normal cooldown", async (t) => {
  const { db, show } = fixture(t);
  const now = Date.now();
  const period = Math.floor((now + 7 * 3_600_000) / (3 * 3_600_000));
  db.prepare(
    "INSERT INTO claim_allowances(guild_id,user_id,period) VALUES(?,?,?)",
  ).run("1", "101", period);
  const before = await show();
  assert.match(before, /can't claim right now/);
  const pinata = addActiveBuff(
    db,
    "1",
    "101",
    "pinata_claim_token",
    "{}",
    null,
    1,
  );
  addActiveBuff(db, "1", "101", "crown_of_the_sovereign", "{}", null, 3);
  addActiveBuff(
    db,
    "1",
    "101",
    "pinata_claim_token",
    '{"snapshot":2}',
    null,
    2,
  );
  addActiveBuff(db, "1", "202", "pinata_claim_token", "{}", null, 99);
  addActiveBuff(db, "2", "101", "pinata_claim_token", "{}", null, 99);
  addActiveBuff(db, "1", "101", "pinata", "{}", null, 10);
  assert.equal(
    await show(),
    `${before.replace("can't claim right now.", "have a normal claim on cooldown.")}\nExtra claim tokens: **6** — usable during the normal cooldown.`,
  );
  consumeBuffRoll(db, pinata.id);
  assert.match(await show(), /\nExtra claim tokens: \*\*5\*\*/);
});

test("mu shows tokens for the requested user, excludes expired/exhausted tokens, and hides empty totals", async (t) => {
  const { db, show } = fixture(t);
  addActiveBuff(db, "1", "202", "pinata_claim_token", "{}", null, 1);
  addActiveBuff(
    db,
    "1",
    "202",
    "crown_of_the_sovereign",
    "{}",
    Date.now() - 1000,
    9,
  );
  addActiveBuff(db, "1", "202", "crown_of_the_sovereign", "{}", null, 0);
  assert.doesNotMatch(await show(), /Extra claim/);
  assert.match(await show("202"), /\nExtra claim tokens: \*\*1\*\*/);
  assert.match(await show("<@202>"), /\nExtra claim tokens: \*\*1\*\*/);
});
