import test from "node:test";
import assert from "node:assert/strict";
import { createFinalCatalog } from "../lib/catalogDb.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addActiveBuff } from "../lib/itemStorage.js";
import { marryCharacter } from "../lib/characterMarriage.js";
import { reserveRoll } from "../lib/characterRolls.js";
import { deliverReservedRoll } from "../lib/rollDelivery.js";

test("Misfire owner notification is attempted once even when Discord accepts a send but loses its response", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "misfire-notification-"));
  const db = createFinalCatalog(join(dir, "catalog.sqlite"));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const id = "12345678-1234-4123-8123-123456789abc";
  const now = Date.now();
  db.prepare(
    "INSERT INTO character_identities(id,creation_method) VALUES (?,'manual')",
  ).run(id);
  db.prepare(
    "INSERT INTO characters(id,rank,favourites,tie_order,likes_source,name_full,gender) VALUES (?,1,2000,1,'generated','Target','female')",
  ).run(id);
  marryCharacter(db, "1", id, "202", now);
  addActiveBuff(db, "1", "101", "cupids_misfire", null, null, 1);
  const r = reserveRoll(db, {
    guildId: "1",
    channelId: "10",
    commandMessageId: "100",
    userId: "101",
    pool: "w",
    now,
    random: () => 0,
  });
  let attempts = 0;
  const channel = {
    id: "10",
    guildId: "1",
    messages: { fetch: async () => ({ react: async () => {} }) },
    send: async (payload) => {
      attempts++;
      assert.deepEqual(
        payload.allowedMentions.users,
        attempts === 1 ? ["202"] : [],
      );
      if (attempts === 1) throw new Error("accepted remotely, response lost");
      return { id: "500" };
    },
  };
  await assert.rejects(
    deliverReservedRoll(db, null, { rollId: r.rollId, channel }),
    /response lost/,
  );
  assert.equal(
    (await deliverReservedRoll(db, null, { rollId: r.rollId, channel })).status,
    "published",
  );
  await deliverReservedRoll(db, null, { rollId: r.rollId, channel });
  assert.equal(attempts, 2);
});
