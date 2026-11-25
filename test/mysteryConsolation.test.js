import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  initItemStorage,
  addItemToInventory,
  getInventory,
} from "../lib/itemStorage.js";
import { initVaultRewards, getVaultReward } from "../lib/vaultRewards.js";
import { resolveMysteryConsolation } from "../lib/mysteryConsolation.js";
import { initGameConfig, saveConfigSection } from "../lib/gameConfig.js";

function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  initItemStorage(db);
  initVaultRewards(db);
  initGameConfig(db);
  db.exec(`CREATE TABLE IF NOT EXISTS item_action_costs(action_id TEXT,inventory_id INTEGER UNIQUE,snapshot_json TEXT);
    CREATE TABLE reward_sources(reward_id TEXT PRIMARY KEY REFERENCES vault_rewards(vault_id),
    source_kind TEXT NOT NULL,source_id TEXT NOT NULL,metadata_json TEXT NOT NULL,UNIQUE(source_kind,source_id));`);
  addItemToInventory(db, "1", "102", "consolation_chit", 2, { now: 100 });
  return db;
}
const session = { id: 1, guildId: "1", eventChannelId: "20" };
function resolve(db, random) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = resolveMysteryConsolation(db, {
      session,
      winnerId: "102",
      canClaim: false,
      now: 101,
      random,
    });
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

test("Chit uses independent captured tier weights and validates both random draws", (t) => {
  const db = fixture(t);
  saveConfigSection(db, {
    section: "itemEffects",
    expectedRevision: 0,
    values: {
      "itemEffects.consolation_chit.tierWeights.common": 0,
      "itemEffects.consolation_chit.tierWeights.rare": 0,
      "itemEffects.consolation_chit.tierWeights.epic": 0,
      "itemEffects.consolation_chit.tierWeights.legendary": 0,
      "itemEffects.consolation_chit.tierWeights.???": 1,
    },
  });
  const before = getInventory(db, "1", "102", 101);
  let calls = 0;
  assert.throws(
    () => resolve(db, () => (++calls === 1 ? 0 : NaN)),
    /Invalid random/,
  );
  assert.deepEqual(getInventory(db, "1", "102", 101), before);
  const decision = resolve(db, () => 0);
  assert.equal(getVaultReward(db, decision.rewardId).reward.tier, "???");
  assert.equal(
    getInventory(db, "1", "102", 101).find(
      (i) => i.item_id === "consolation_chit",
    ).charges,
    1,
  );
});

test("defensive empty Chit pool spends nothing and saves a no-op", (t) => {
  const db = fixture(t);
  // Simulate a damaged runtime snapshot; the portal correctly rejects this configuration.
  for (const tier of ["common", "rare", "epic", "legendary", "???"]) {
    db.prepare(
      "INSERT INTO game_config_overrides(scope_id,key,value_json) VALUES(?,?,?)",
    ).run("", `itemEffects.consolation_chit.tierWeights.${tier}`, "0");
  }
  const before = getInventory(db, "1", "102", 101);
  assert.deepEqual(
    resolve(db, () => {
      throw new Error("no draw");
    }),
    { version: 1, status: "no_reward_pool" },
  );
  assert.deepEqual(getInventory(db, "1", "102", 101), before);
});
