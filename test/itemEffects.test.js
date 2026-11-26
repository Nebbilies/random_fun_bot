import assert from "node:assert/strict";
import { test } from "node:test";
import { openCatalog } from "../lib/catalogDb.js";
import { ensureMainFranchiseTable } from "./helpers/mainFranchiseTable.js";
import {
  useHourglassOfHaste,
  useLoveLetter,
  useBagOfHolding,
  usePickpocketsHook,
  useMasterKey,
  useAegisOfFidelity,
  useWishUponAStar,
} from "../lib/itemEffects.js";
import {
  addItemToInventory,
  getInventory,
  getInventoryCapacity,
  isCharacterLocked,
} from "../lib/itemStorage.js";
import { marryCharacter, getMarriage } from "../lib/characterMarriage.js";

test("Hourglass of Haste resets roll allowance", () => {
  const db = openCatalog(":memory:");
  const guildId = "1001";
  const userId = "3001";

  db.prepare(
    `INSERT INTO roll_allowances (guild_id, user_id, period, used)
    VALUES (?, ?, 100, 7)`,
  ).run(guildId, userId);

  const res = useHourglassOfHaste(db, guildId, userId, 100 * 3600 * 1000);
  assert.equal(res.success, true);

  const allowance = db
    .prepare(
      "SELECT used FROM roll_allowances WHERE guild_id = ? AND user_id = ?",
    )
    .get(guildId, userId);
  assert.equal(allowance.used, 0);
});

test("Love Letter resets claim allowance", () => {
  const db = openCatalog(":memory:");
  const guildId = "1001";
  const userId = "3001";

  db.prepare(
    `INSERT INTO claim_allowances (guild_id, user_id, period)
    VALUES (?, ?, 50)`,
  ).run(guildId, userId);

  const res = useLoveLetter(db, guildId, userId);
  assert.equal(res.success, true);

  const claim = db
    .prepare(
      "SELECT 1 FROM claim_allowances WHERE guild_id = ? AND user_id = ?",
    )
    .get(guildId, userId);
  assert.equal(claim, undefined);
});

test("Bag of Holding permanently expands capacity up to 8 max", () => {
  const db = openCatalog(":memory:");
  const guildId = "1001";
  const userId = "3001";

  assert.equal(getInventoryCapacity(db, guildId, userId), 5);
  const res = useBagOfHolding(db, guildId, userId);
  assert.equal(res.success, true);
  assert.equal(res.newCapacity, 6);
});

test("Pickpockets Hook steals character unless Mirror Shield blocks it", () => {
  const db = openCatalog(":memory:");
  const guildId = "1001";
  const attackerId = "3001";
  const victimId = "3002";

  db.exec(`
    INSERT INTO characters (id, rank, favourites, name_full, gender)
    VALUES (10, 5, 2000, 'Aqua', 'female');
  `);
  marryCharacter(db, guildId, 10, victimId);

  // Victim has Mirror Shield in inventory
  addItemToInventory(db, guildId, victimId, "mirror_shield", 1);

  // Attempt steal
  const blockedRes = usePickpocketsHook(db, guildId, attackerId, victimId);
  assert.equal(blockedRes.blocked, true);
  assert.equal(blockedRes.blockedBy, "mirror_shield");
  // Character remains with victim
  assert.equal(getMarriage(db, guildId, 10).ownerId, victimId);
  // Mirror shield is now consumed
  assert.equal(getInventory(db, guildId, victimId).length, 0);

  // Now attempt steal again (shield is gone)
  const successRes = usePickpocketsHook(db, guildId, attackerId, victimId);
  assert.equal(successRes.success, true);
  assert.equal(getMarriage(db, guildId, 10).ownerId, attackerId);

  // Stolen character has 24h theft lock
  const lock = isCharacterLocked(db, guildId, 10);
  assert.equal(lock.locked, true);
  assert.equal(lock.lockType, "theft_cooldown");
});

test("Master Key respects an active Aegis soulbind until its configured deadline", () => {
  const db = openCatalog(":memory:");
  const guildId = "1001";
  const attackerId = "3001";
  const victimId = "3002";
  const now = 1_000;
  db.prepare(
    "INSERT INTO game_config_overrides(scope_id,key,value_json) VALUES(?,?,?)",
  ).run(
    guildId,
    "itemEffects.aegis_of_fidelity.protectionMs",
    JSON.stringify(1_000),
  );

  db.exec(`
    INSERT INTO characters (id, rank, favourites, name_full, gender)
    VALUES (20, 2, 10000, 'Megumin', 'female');
  `);
  marryCharacter(db, guildId, 20, victimId);

  // Soulbind Megumin with Aegis
  const soulbindRes = useAegisOfFidelity(db, guildId, victimId, "Megumin", now);
  assert.equal(soulbindRes.success, true);
  assert.equal(
    db
      .prepare(
        "SELECT protected_until FROM character_protection_locks WHERE guild_id=? AND character_id=?",
      )
      .get(guildId, 20).protected_until,
    now + 1_000,
  );
  assert.equal(isCharacterLocked(db, guildId, 20, now).locked, true);

  // Attempt steal with Master Key
  const stealRes = useMasterKey(
    db,
    guildId,
    attackerId,
    victimId,
    "Megumin",
    now + 999,
  );
  assert.equal(stealRes.blocked, true);
  assert.equal(stealRes.blockedBy, "soulbind");
  assert.equal(getMarriage(db, guildId, 20).ownerId, victimId);

  const expiredSteal = useMasterKey(
    db,
    guildId,
    attackerId,
    victimId,
    "Megumin",
    now + 1_000,
  );
  assert.equal(expiredSteal.success, true);
  assert.equal(getMarriage(db, guildId, 20).ownerId, attackerId);
});

test("Wish Upon A Star marries unowned top 3 character of franchise", () => {
  const db = openCatalog(":memory:");
  const guildId = "1001";
  const userId = "3001";

  db.exec(`
    INSERT INTO franchises (id, display_name, created_at) VALUES (1, 'Re:Zero', '2026');
    INSERT INTO characters (id, rank, favourites, name_full, gender) VALUES
      (1, 1, 15000, 'Rem', 'female'),
      (2, 2, 12000, 'Emilia', 'female'),
      (3, 3, 9000, 'Ram', 'female');
    INSERT INTO character_anime (character_id, anime_id) VALUES (1, 1), (2, 1), (3, 1);
    INSERT INTO franchise_anime (franchise_id, anime_id) VALUES (1, 1);
  `);

  ensureMainFranchiseTable(db);
  db.exec("INSERT INTO character_main_franchises VALUES(1,1),(2,1),(3,1)");
  // Suppose Rem (#1) is already married to another user
  marryCharacter(db, guildId, 1, "9999");

  // Wish should pick from Emilia (#2) or Ram (#3)
  const res = useWishUponAStar(db, guildId, userId, "Re:Zero", () => 0.0);
  assert.equal(res.success, true);
  assert.equal(res.character.name_full, "Emilia");
  assert.equal(getMarriage(db, guildId, 2).ownerId, userId);
});
