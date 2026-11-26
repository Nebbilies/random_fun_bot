import assert from "node:assert/strict";
import { test } from "node:test";
import { openCatalog } from "../lib/catalogDb.js";
import { ensureMainFranchiseTable } from "./helpers/mainFranchiseTable.js";
import {
  reserveRoll,
  claimRoll,
  getRollStatus,
  getClaimStatus,
} from "../lib/characterRolls.js";
import { addActiveBuff, getActiveBuffs } from "../lib/itemStorage.js";
import { franchisePassport } from "../lib/items/franchisePassport.js";

test("Franchise Passport requires main assignments and consumes a qualifying roll", () => {
  const db = openCatalog(":memory:");
  const guildId = "1001";
  const channelId = "2001";
  const userId = "3001";

  db.exec(`
    INSERT INTO franchises (id, display_name, created_at) VALUES (1, 'Frieren', '2026');
    INSERT INTO anime (id, title_english, title_romaji, fetched_at) VALUES
      (1, 'Sousou no Frieren', 'Sousou no Frieren', '2026'),
      (2, 'Other Anime', 'Other', '2026');
    INSERT INTO franchise_anime (franchise_id, anime_id) VALUES (1, 1);

    INSERT INTO characters (id, rank, favourites, name_full, gender) VALUES
      (1, 10, 5000, 'Frieren', 'female'),
      (2, 20, 4000, 'Fern', 'female'),
      (3, 500, 100, 'Random Girl', 'female');

    INSERT INTO character_anime (character_id, anime_id) VALUES (1, 1), (2, 1), (3, 2);
  `);

  ensureMainFranchiseTable(db);

  const params = { db, guildId, userId, args: ["Frieren"] };
  assert.equal(franchisePassport.execute(params).success, false);
  assert.deepEqual(getActiveBuffs(db, guildId, userId), []);
  db.exec("INSERT INTO character_main_franchises VALUES(1,1),(2,1)");
  assert.equal(franchisePassport.execute(params).success, true);

  const res = reserveRoll(db, {
    guildId,
    channelId,
    commandMessageId: "1001001",
    userId,
    pool: "w",
    random: () => 0.0,
  });

  assert.equal(res.status, "reserved");
  // Character must be Frieren or Fern (from franchise 1)
  assert.ok(["Frieren", "Fern"].includes(res.character.name_full));

  // Buff roll should have decremented from 5 to 4
  const buffs = getActiveBuffs(db, guildId, userId);
  assert.equal(buffs[0].remaining_rolls, 4);
});

test("Rolling Fever refunds +2 rolls when rolling a character with >1000 favorites", () => {
  const db = openCatalog(":memory:");
  const guildId = "1001";
  const channelId = "2001";
  const userId = "3001";

  db.exec(`
    INSERT INTO characters (id, rank, favourites, name_full, gender) VALUES
      (1, 10, 5000, 'Aqua', 'female');
  `);

  // Set 3 rolls already used
  db.prepare(
    "INSERT INTO roll_allowances (guild_id, user_id, period, used) VALUES (?, ?, 10, 3)",
  ).run(guildId, userId);

  // Activate Rolling Fever
  addActiveBuff(db, guildId, userId, "rolling_fever", null, null, 10);

  const res = reserveRoll(db, {
    guildId,
    channelId,
    commandMessageId: "1001002",
    userId,
    pool: "w",
    now: 10 * 3600 * 1000,
  });

  assert.equal(res.status, "reserved");
  // Used was 3, +1 roll consumed = 4, then fever refunds -2 = 2 used!
  // Remaining from 7 max: 7 - 2 = 5!
  assert.equal(
    getRollStatus(db, guildId, userId, 10 * 3600 * 1000).remaining,
    5,
  );
});

test("Crown of the Sovereign bypasses claim cooldown and consumes 1 charge", () => {
  const db = openCatalog(":memory:");
  const guildId = "1001";
  const channelId = "2001";
  const userId = "3001";
  const now = 1000000;

  db.exec(`
    INSERT INTO characters (id, rank, favourites, name_full, gender) VALUES
      (1, 10, 5000, 'Megumin', 'female');
    INSERT INTO character_rolls (id, guild_id, channel_id, command_message_id, message_id, character_id, character_name, state, published_at, expires_at)
    VALUES (1, '1001', '2001', '100001', '200001', 1, 'Megumin', 'open', 1000000, 2000000);
  `);

  // Put user on claim cooldown
  const period = Math.floor((now + 7 * 3600 * 1000) / (3 * 3600 * 1000));
  db.prepare(
    "INSERT INTO claim_allowances (guild_id, user_id, period) VALUES (?, ?, ?)",
  ).run(guildId, userId, period);

  // Normally cannot claim
  assert.equal(getClaimStatus(db, guildId, userId, now).canClaim, false);

  // Add Crown of the Sovereign buff (3 charges)
  addActiveBuff(db, guildId, userId, "crown_of_the_sovereign", null, null, 3);

  // Claim should now succeed!
  const claimRes = claimRoll(db, {
    guildId,
    channelId,
    messageId: "200001",
    userId,
    now,
  });
  assert.equal(claimRes.status, "married");

  // Buff should have 2 charges left
  const buffs = getActiveBuffs(db, guildId, userId, now);
  assert.equal(buffs[0].remaining_rolls, 2);
});
