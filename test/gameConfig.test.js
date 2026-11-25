import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCatalog, openCatalogReadOnly } from "../lib/catalogDb.js";
import {
  getGameConfig,
  getConfigView,
  saveConfigSection,
  initGameConfig,
} from "../lib/gameConfig.js";
import {
  GAME_CONFIG_DEFAULTS,
  GAME_CONFIG_REGISTRY,
  validateGameConfig,
  validateConfigValue,
} from "../lib/gameConfigSchema.js";
import { ALL_ITEMS } from "../lib/items/index.js";

function save(db, section, values, extra = {}) {
  return saveConfigSection(db, {
    section,
    values,
    expectedRevision: getConfigView(db).revision,
    ...extra,
  });
}
function memory(t) {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  return db;
}

test("built-in fallback is complete, immutable internally, and valid", () => {
  assert.doesNotThrow(() => validateGameConfig(getGameConfig()));
  const config = getGameConfig();
  config.items.golden_whistle.startingCharges = 99;
  assert.equal(getGameConfig().items.golden_whistle.startingCharges, 3);
  assert.equal(config.rolls.maxRolls, 7);
  assert.equal(config.mysteryEvents.treasure_hunt.enabled, false);
  assert.equal(Object.keys(GAME_CONFIG_REGISTRY).length > 140, true);
  assert.equal(Object.isFrozen(GAME_CONFIG_DEFAULTS.items), true);
});

test("item lifetimes are whole days for all five tiers, independent of timer limits", () => {
  assert.deepEqual(getGameConfig().itemExpiryDays, {
    common: 2,
    rare: 4,
    epic: 7,
    legendary: 14,
    "???": 30,
  });
  for (const tier of ["common", "rare", "epic", "legendary", "???"]) {
    const key = `itemExpiryDays.${tier}`;
    for (const days of [1, 30, 365])
      assert.equal(validateConfigValue(key, days), days);
    for (const days of [0, 1.5, 366, "2"])
      assert.throws(() => validateConfigValue(key, days));
  }
});

test("timer durations reject values that Node would execute immediately", () => {
  assert.throws(() =>
    validateConfigValue("controls.lifetimeMs", 2_147_483_648),
  );
  assert.equal(
    validateConfigValue("controls.lifetimeMs", 2_147_483_647),
    2_147_483_647,
  );
});

test("Aegis duration is configurable globally and per guild in milliseconds", (t) => {
  const db = memory(t);
  const key = "itemEffects.aegis_of_fidelity.protectionMs";
  assert.equal(
    GAME_CONFIG_DEFAULTS.itemEffects.aegis_of_fidelity.protectionMs,
    604_800_000,
  );
  assert.equal(GAME_CONFIG_REGISTRY[key].section, "itemEffects");
  assert.equal(GAME_CONFIG_REGISTRY[key].default, 604_800_000);
  for (const invalid of [0, -1, 1.5, 2_147_483_648, "604800000"]) {
    assert.throws(() => validateConfigValue(key, invalid));
  }

  save(db, "itemEffects", { [key]: 86_400_000 });
  save(db, "itemEffects", { [key]: 3_600_000 }, { guildId: "123" });
  assert.equal(
    getGameConfig(db, "123").itemEffects.aegis_of_fidelity.protectionMs,
    3_600_000,
  );
  assert.equal(
    getGameConfig(db, "456").itemEffects.aegis_of_fidelity.protectionMs,
    86_400_000,
  );
});

test("registry includes every current item and matching starting charges", () => {
  assert.deepEqual(
    Object.keys(GAME_CONFIG_DEFAULTS.items).sort(),
    ALL_ITEMS.map((item) => item.id).sort(),
  );
  for (const item of ALL_ITEMS)
    assert.equal(
      GAME_CONFIG_DEFAULTS.items[item.id].startingCharges,
      item.maxCharges,
    );
});

test("global/guild precedence, origins, partial saves and resets", (t) => {
  const db = memory(t);
  save(db, "rolls", { "rolls.maxRolls": 9 });
  const view = save(db, "rolls", { "rolls.maxRolls": 11 }, { guildId: "123" });
  assert.equal(view.effective.rolls.maxRolls, 11);
  assert.equal(view.sources["rolls.maxRolls"], "guild");
  assert.equal(view.sources["rolls.prankRate"], "builtin");
  assert.equal(getConfigView(db, "456").sources["rolls.maxRolls"], "global");
  const reset = save(
    db,
    "rolls",
    {},
    { guildId: "123", reset: ["rolls.maxRolls"] },
  );
  assert.equal(reset.effective.rolls.maxRolls, 9);
  assert.deepEqual(reset.overrides, {});
  save(db, "rolls", {}, { reset: true });
  assert.equal(getGameConfig(db, "123").rolls.maxRolls, 7);
});

test("item lifetime saves inherit and reset atomically without accepting stale revisions", (t) => {
  const db = memory(t);
  save(db, "itemExpiryDays", {
    "itemExpiryDays.???": 365,
    "itemExpiryDays.common": 1,
  });
  const inherited = getConfigView(db, "123");
  assert.equal(inherited.effective.itemExpiryDays["???"], 365);
  assert.equal(inherited.sources["itemExpiryDays.???"], "global");
  save(db, "itemExpiryDays", { "itemExpiryDays.???": 30 }, { guildId: "123" });
  assert.equal(getGameConfig(db, "123").itemExpiryDays["???"], 30);
  assert.equal(getGameConfig(db, "456").itemExpiryDays["???"], 365);
  assert.throws(
    () =>
      saveConfigSection(db, {
        section: "itemExpiryDays",
        values: { "itemExpiryDays.rare": 2 },
        expectedRevision: inherited.revision,
      }),
    { code: "CONFIG_STALE" },
  );
  const revision = getConfigView(db).revision;
  assert.throws(
    () =>
      save(db, "itemExpiryDays", {
        "itemExpiryDays.epic": 10,
        "itemExpiryDays.rare": 366,
      }),
    { code: "CONFIG_VALIDATION" },
  );
  assert.equal(getConfigView(db).revision, revision);
  assert.equal(getGameConfig(db).itemExpiryDays.epic, 7);
  const reset = save(
    db,
    "itemExpiryDays",
    {},
    { guildId: "123", reset: ["itemExpiryDays.???"] },
  );
  assert.equal(reset.effective.itemExpiryDays["???"], 365);
  assert.equal(reset.sources["itemExpiryDays.???"], "global");
  save(db, "itemExpiryDays", {}, { reset: true });
  assert.equal(getGameConfig(db, "123").itemExpiryDays["???"], 30);
});

test("optimistic revision rejects stale edits across sections and scopes", (t) => {
  const db = memory(t);
  const revision = getConfigView(db).revision;
  save(db, "rolls", { "rolls.maxRolls": 9 }, { guildId: "1" });
  assert.throws(
    () =>
      saveConfigSection(db, {
        section: "vault",
        values: { "vault.dropRate": 0.2 },
        expectedRevision: revision,
      }),
    { code: "CONFIG_STALE" },
  );
  assert.equal(getGameConfig(db).vault.dropRate, 0.01);
});

test("validation is atomic, rejects unknown keys, coercions and unsafe values", (t) => {
  const db = memory(t);
  const revision = getConfigView(db).revision;
  for (const values of [
    { "rolls.maxRolls": 0 },
    { "rolls.maxRolls": "8" },
    { "rolls.maxRolls": Infinity },
    { "rolls.maxRolls": 8, "rolls.secret": "x" },
    { "vault.enabled": false },
    JSON.parse('{"__proto__.polluted":true}'),
    { "rolls.prankRate": 1.1 },
  ])
    assert.throws(() => save(db, "rolls", values), {
      code: "CONFIG_VALIDATION",
    });
  assert.equal(getConfigView(db).revision, revision);
  assert.equal(getGameConfig(db).rolls.maxRolls, 7);
  assert.equal({}.polluted, undefined);
  assert.throws(() => save(db, "rolls", {}, { reset: ["constructor"] }), {
    code: "CONFIG_VALIDATION",
  });
  assert.throws(() => saveConfigSection(db, { section: "rolls" }), {
    code: "CONFIG_VALIDATION",
  });
});

test("global changes and resets validate inherited guild combinations", (t) => {
  const db = memory(t);
  save(db, "capacity", { "capacity.inventoryBase": 7 }, { guildId: "1" });
  const revision = getConfigView(db).revision;
  assert.throws(() => save(db, "capacity", { "capacity.inventoryMax": 6 }), {
    code: "CONFIG_VALIDATION",
  });
  assert.equal(getConfigView(db).revision, revision);
  assert.equal(getGameConfig(db).capacity.inventoryMax, 8);
  save(db, "capacity", { "capacity.inventoryMax": 12 });
  save(db, "capacity", { "capacity.inventoryBase": 10 }, { guildId: "1" });
  assert.throws(() => save(db, "capacity", {}, { reset: true }), {
    code: "CONFIG_VALIDATION",
  });
});

test("mystery availability and array/range invariants", (t) => {
  const db = memory(t);
  const disable = Object.fromEntries(
    ["doors", "clue_reveal", "greed_chamber", "deadlock", "glass_bridge"].map(
      (id) => [`mysteryEvents.${id}.enabled`, false],
    ),
  );
  assert.throws(() => save(db, "mysteryEvents", disable), {
    code: "CONFIG_VALIDATION",
  });
  save(db, "mystery", { "mystery.enabled": false });
  save(db, "mysteryEvents", disable);
  assert.throws(() => save(db, "mystery", { "mystery.enabled": true }), {
    code: "CONFIG_VALIDATION",
  });
  assert.throws(
    () =>
      save(db, "mystery", {
        "mystery.oddsAnchors": [
          { rank: 1, chance: 0.1 },
          { rank: 2, chance: 0.2 },
        ],
      }),
    { code: "CONFIG_VALIDATION" },
  );
  assert.throws(
    () =>
      save(db, "mysteryEvents", { "mysteryEvents.greed_chamber.rounds": 4 }),
    { code: "CONFIG_VALIDATION" },
  );
  assert.throws(
    () =>
      save(db, "mysteryEvents", {
        "mysteryEvents.treasure_hunt.clueTimesMs": [0, 2, 1],
      }),
    { code: "CONFIG_VALIDATION" },
  );
  assert.throws(() =>
    validateConfigValue("mystery.oddsAnchors", [
      { rank: 1, chance: 1, code: "x" },
      { rank: 2, chance: 0.2 },
    ]),
  );
});

test("reward eligibility is independent, requires eligible pools and positive weights", (t) => {
  const db = memory(t);
  save(db, "items", { "items.hourglass_of_haste.rewardEligible": false });
  assert.equal(getGameConfig(db).items.hourglass_of_haste.startingCharges, 1);
  assert.throws(
    () =>
      save(db, "items", {
        "items.four_leaf_clover.rewardEligible": false,
        "items.binoculars.rewardEligible": false,
        "items.consolation_chit.rewardEligible": false,
      }),
    { code: "CONFIG_VALIDATION" },
  );
  assert.throws(
    () =>
      save(
        db,
        "vault",
        Object.fromEntries(
          ["common", "rare", "epic", "legendary", "???"].map((tier) => [
            `vault.tierWeights.${tier}`,
            0,
          ]),
        ),
      ),
    { code: "CONFIG_VALIDATION" },
  );
});

test("explicit schedule activation resets only affected allowance cycles and retains daily/player state", (t) => {
  const db = memory(t);
  for (const guild of ["1", "2"]) {
    db.prepare("INSERT INTO roll_allowances VALUES(?,?,?,?)").run(
      guild,
      "9",
      1,
      7,
    );
    db.prepare("INSERT INTO claim_allowances VALUES(?,?,?)").run(guild, "9", 1);
    db.prepare("INSERT INTO claim_events VALUES(?,?,?)").run(guild, "9", 123);
    db.prepare(
      "INSERT INTO daily_roll_claims(guild_id,user_id,period) VALUES(?,?,?)",
    ).run(guild, "9", 1);
  }
  db.prepare(
    "INSERT INTO marriages(guild_id,character_id,owner_id,married_at) VALUES(?,?,?,?)",
  ).run("1", 1, "9", "today");
  assert.throws(
    () => save(db, "schedules", { "schedules.rollIntervalMs": 7_200_000 }),
    { code: "CONFIG_ACTIVATION_REQUIRED" },
  );
  save(
    db,
    "schedules",
    { "schedules.rollIntervalMs": 7_200_000 },
    { guildId: "1", activateSchedule: true },
  );
  assert.equal(db.prepare("SELECT count(*) n FROM roll_allowances").get().n, 1);
  assert.equal(
    db.prepare("SELECT count(*) n FROM claim_allowances").get().n,
    2,
  );
  save(
    db,
    "schedules",
    { "schedules.claimIntervalMs": 7_200_000 },
    { activateSchedule: true },
  );
  assert.equal(
    db.prepare("SELECT count(*) n FROM claim_allowances").get().n,
    0,
  );
  assert.equal(db.prepare("SELECT count(*) n FROM claim_events").get().n, 0);
  assert.equal(
    db.prepare("SELECT count(*) n FROM daily_roll_claims").get().n,
    2,
  );
  assert.equal(db.prepare("SELECT count(*) n FROM marriages").get().n, 1);
});

test("legacy migration, idempotency, admin setter bridging and old schema fallback", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`CREATE TABLE guild_game_rates(guild_id TEXT PRIMARY KEY,vault_rate REAL,prank_rate REAL);
    CREATE TABLE guild_roll_limits(guild_id TEXT PRIMARY KEY,max_rolls INTEGER);
    INSERT INTO guild_game_rates VALUES('1',0.2,0.3);
    INSERT INTO guild_roll_limits VALUES('1',13);`);
  assert.equal(getGameConfig(db, "1").rolls.maxRolls, 13);
  initGameConfig(db);
  assert.equal(getGameConfig(db, "1").vault.dropRate, 0.2);
  assert.equal(getGameConfig(db, "1").rolls.prankRate, 0.3);
  save(db, "rolls", {}, { guildId: "1", reset: true });
  initGameConfig(db);
  assert.equal(getGameConfig(db, "1").rolls.maxRolls, 7);
  const revision = getConfigView(db).revision;
  db.exec("UPDATE guild_roll_limits SET max_rolls=12 WHERE guild_id='1'");
  assert.equal(getGameConfig(db, "1").rolls.maxRolls, 12);
  assert.equal(getConfigView(db).revision, revision + 1);
  const empty = new DatabaseSync(":memory:");
  t.after(() => empty.close());
  assert.deepEqual(getGameConfig(empty), getGameConfig());
});

test("catalog version 9 upgrades preserving settings; separate connections see committed updates immediately", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "game-config-"));
  const path = join(dir, "bot.sqlite");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const old = new DatabaseSync(path);
  old.exec(`PRAGMA user_version=9;
    CREATE TABLE guild_roll_limits(guild_id TEXT PRIMARY KEY,max_rolls INTEGER NOT NULL);
    CREATE TABLE guild_game_rates(guild_id TEXT PRIMARY KEY,vault_rate REAL,prank_rate REAL,updated_at INTEGER);
    INSERT INTO guild_roll_limits VALUES('1',15);
    INSERT INTO guild_game_rates VALUES('1',0.25,0.4,0);`);
  old.exec(`CREATE TABLE daily_roll_claims(guild_id TEXT,user_id TEXT,period INTEGER,PRIMARY KEY(guild_id,user_id));
    INSERT INTO daily_roll_claims VALUES('1','9',42);`);
  old.close();
  const writer = openCatalog(path);
  const reader = openCatalogReadOnly(path);
  try {
    assert.equal(writer.prepare("PRAGMA user_version").get().user_version, 10);
    assert.equal(
      writer
        .prepare("SELECT period FROM daily_roll_claims WHERE guild_id='1'")
        .get().period,
      42,
    );
    assert.equal(
      writer
        .prepare("SELECT reset_at FROM daily_roll_claims WHERE guild_id='1'")
        .get().reset_at,
      null,
    );
    assert.ok(
      writer
        .prepare("PRAGMA table_info(character_rolls)")
        .all()
        .some((column) => column.name === "rules_json"),
    );
    assert.equal(getGameConfig(reader, "1").rolls.maxRolls, 15);
    assert.equal(getGameConfig(reader, "1").vault.dropRate, 0.25);
    const stale = getConfigView(reader, "1").revision;
    save(writer, "rolls", { "rolls.maxRolls": 17 }, { guildId: "1" });
    assert.equal(getGameConfig(reader, "1").rolls.maxRolls, 17);
    assert.notEqual(getConfigView(reader).revision, stale);
  } finally {
    reader.close();
    writer.close();
  }
});
