import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  initGameConfig,
  getConfigView,
  saveConfigSection,
} from "../lib/gameConfig.js";
import {
  GAME_CONFIG_DEFAULTS,
  validateGameConfig,
} from "../lib/gameConfigSchema.js";
import {
  getResolvedItemDefinition,
  getResolvedItemDefinitions,
  rollVaultOutcome,
} from "../lib/itemRoster.js";

function save(db, section, values) {
  return saveConfigSection(db, {
    guildId: "123",
    section,
    values,
    expectedRevision: getConfigView(db, "123").revision,
  });
}

test("Phase 2 definitions have configured charges, rarity and live Chronicle period", (t) => {
  const db = new DatabaseSync(":memory:");
  initGameConfig(db);
  t.after(() => db.close());
  assert.equal(
    getResolvedItemDefinition(db, "123", "consolation_chit").tier,
    "common",
  );
  assert.equal(
    getResolvedItemDefinition(db, "123", "chronicle_of_return").tier,
    "epic",
  );
  assert.match(
    getResolvedItemDefinition(db, "123", "chronicle_of_return").description,
    /7 days/,
  );
  save(db, "itemEffects", {
    "itemEffects.chronicle_of_return.historyWindowMs": 2 * 86400000,
  });
  save(db, "items", { "items.chronicle_of_return.startingCharges": 2 });
  const definition = getResolvedItemDefinition(
    db,
    "123",
    "chronicle_of_return",
  );
  assert.match(definition.description, /2 days/);
  assert.equal(definition.maxCharges, 2);
  assert.match(
    getResolvedItemDefinition(db, "456", definition.id).description,
    /7 days/,
  );
});

test("Chit weights allow empty tiers but reject no eligible positive-weight pool", () => {
  const config = structuredClone(GAME_CONFIG_DEFAULTS);
  config.vault.enabled = false;
  config.itemEffects.consolation_chit.tierWeights = {
    common: 1,
    rare: 0,
    epic: 0,
    legendary: 0,
    "???": 1,
  };
  config.items.kaimetsu.rewardEligible = false;
  assert.doesNotThrow(() => validateGameConfig(config));
  config.itemEffects.consolation_chit.tierWeights.common = 0;
  assert.throws(() => validateGameConfig(config), /[Cc]onsolation|[Cc]hit/);
});

test("definition resolution can use one captured configuration and random draws must be valid", (t) => {
  const db = new DatabaseSync(":memory:");
  initGameConfig(db);
  t.after(() => db.close());
  const captured = structuredClone(GAME_CONFIG_DEFAULTS);
  captured.items.chronicle_of_return.startingCharges = 4;
  assert.equal(
    getResolvedItemDefinitions(db, "123", captured).find(
      (item) => item.id === "chronicle_of_return",
    ).maxCharges,
    4,
  );
  for (const invalid of [-1, 1, NaN, Infinity])
    assert.throws(
      () =>
        rollVaultOutcome(
          () => 0,
          () => invalid,
        ),
      /random/,
    );
});
