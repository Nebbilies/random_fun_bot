import assert from "node:assert/strict";
import test from "node:test";
import { openCatalog } from "../lib/catalogDb.js";
import { getConfigView, saveConfigSection } from "../lib/gameConfig.js";
import { addCharacterLock } from "../lib/itemStorage.js";
import {
  AEGIS_DURATION_ROLLOUT_KEY,
  isAegisDurationMigrationPending,
  migrateAegisDuration,
} from "../lib/aegisDurationMigration.js";

test("Aegis rollout gives legacy soulbinds each guild duration once and preserves other locks", (t) => {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  db.prepare(
    "DELETE FROM game_config_overrides WHERE scope_id=? AND key=?",
  ).run("", AEGIS_DURATION_ROLLOUT_KEY);
  const key = "itemEffects.aegis_of_fidelity.protectionMs";
  saveConfigSection(db, {
    section: "itemEffects",
    values: { [key]: 1_000 },
    expectedRevision: getConfigView(db).revision,
  });
  saveConfigSection(db, {
    guildId: "1",
    section: "itemEffects",
    values: { [key]: 5_000 },
    expectedRevision: getConfigView(db).revision,
  });
  addCharacterLock(db, "1", 11, "soulbind", null);
  addCharacterLock(db, "2", 22, "soulbind", null);
  addCharacterLock(db, "2", 23, "theft_cooldown", null);

  assert.equal(isAegisDurationMigrationPending(db), true);
  db.exec("BEGIN IMMEDIATE");
  assert.equal(migrateAegisDuration(db, { now: 10_000 }), true);
  db.exec("COMMIT");

  assert.equal(
    db
      .prepare(
        "SELECT protected_until FROM character_protection_locks WHERE guild_id=? AND character_id=?",
      )
      .get("1", 11).protected_until,
    15_000,
  );
  assert.equal(
    db
      .prepare(
        "SELECT protected_until FROM character_protection_locks WHERE guild_id=? AND character_id=?",
      )
      .get("2", 22).protected_until,
    11_000,
  );
  assert.equal(
    db
      .prepare(
        "SELECT protected_until FROM character_protection_locks WHERE guild_id=? AND character_id=?",
      )
      .get("2", 23).protected_until,
    null,
  );
  assert.equal(
    JSON.parse(
      db
        .prepare(
          "SELECT value_json FROM game_config_overrides WHERE scope_id=? AND key=?",
        )
        .get("", AEGIS_DURATION_ROLLOUT_KEY).value_json,
    ),
    10_000,
  );
  assert.equal(isAegisDurationMigrationPending(db), false);

  db.exec("BEGIN IMMEDIATE");
  assert.equal(migrateAegisDuration(db, { now: 900_000 }), false);
  db.exec("COMMIT");
  assert.equal(
    db
      .prepare(
        "SELECT protected_until FROM character_protection_locks WHERE guild_id=? AND character_id=?",
      )
      .get("1", 11).protected_until,
    15_000,
  );
});
