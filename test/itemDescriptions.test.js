import test from "node:test";
import assert from "node:assert/strict";
import { openCatalog } from "../lib/catalogDb.js";
import {
  getItemDefinition,
  getResolvedItemDefinition,
} from "../lib/itemRoster.js";
import { getConfigView, saveConfigSection } from "../lib/gameConfig.js";
import { getItemHelpBullet } from "../commands/inv.js";

function fixture(t) {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  return db;
}

function save(db, section, values) {
  saveConfigSection(db, {
    guildId: "1",
    section,
    values,
    expectedRevision: getConfigView(db, "1").revision,
  });
}

function plain(text) {
  return text.replace(/\*/g, "");
}

test("Piñata describes shared rolls and a separate personal cooldown bypass", (t) => {
  const db = fixture(t);
  for (const item of [
    getItemDefinition("pinata"),
    getResolvedItemDefinition(db, "1", "pinata"),
  ]) {
    assert.match(
      plain(item.description),
      /next 10 (?:qualifying )?rolls.*server/i,
    );
    assert.match(item.description, /rank.*#1500.*better/i);
    assert.match(item.description, /you.*1 personal extra claim token/i);
    assert.doesNotMatch(item.description, /2x|double|reset/i);
  }
  assert.match(
    getResolvedItemDefinition(db, "1", "pinata").description,
    /bypasses.*cooldown/i,
  );
  for (const item of [
    getItemDefinition("pinata"),
    getResolvedItemDefinition(db, "1", "pinata"),
  ]) {
    assert.match(getItemHelpBullet(item), /1 personal extra claim token/);
    assert.doesNotMatch(getItemHelpBullet(item), /reset your claim cooldown/);
  }
});

test("resolved Piñata description follows effective server settings", (t) => {
  const db = fixture(t);
  save(db, "itemEffects", {
    "itemEffects.pinata.rolls": 4,
    "itemEffects.pinata.claimTokens": 2,
    "itemEffects.pinata.maxRank": 500,
  });
  const text = getResolvedItemDefinition(db, "1", "pinata").description;
  assert.match(plain(text), /next 4 rolls/);
  assert.match(text, /2 personal extra claim tokens/);
  assert.match(text, /rank.*#500.*better/);
  assert.match(
    plain(getResolvedItemDefinition(db, "2", "pinata").description),
    /next 10 rolls/,
  );
});

test("Double Date describes two timed free claims and cooldown bypass", (t) => {
  const db = fixture(t);
  for (const item of [
    getItemDefinition("double_date"),
    getResolvedItemDefinition(db, "1", "double_date"),
  ]) {
    assert.match(plain(item.description), /10 minutes after activation/);
    assert.match(plain(item.description), /2 free claim(?:s| tokens)/);
    assert.match(item.description, /even during your normal claim cooldown/);
    assert.doesNotMatch(item.description, /2nd claim|when you marry/i);
  }
});

test("franchise summons describe availability and do not promise a Blood Pact rank upgrade", (t) => {
  const db = fixture(t);
  for (const resolve of [
    (id) => getItemDefinition(id),
    (id) => getResolvedItemDefinition(db, "1", id),
  ]) {
    assert.match(plain(resolve("wish_upon_a_star").description), /top 3/);
    assert.match(
      resolve("wish_upon_a_star").description,
      /otherwise.*best-ranked available/,
    );
    assert.match(
      plain(resolve("blood_pact").description),
      /best-ranked (?:available )?unowned/,
    );
    assert.doesNotMatch(
      resolve("blood_pact").description,
      /higher.rank|better than/i,
    );
  }
});

test("action descriptions explain the stakes without internal terminology", () => {
  assert.match(
    getItemDefinition("double_or_nothing").description,
    /lose.*reward/,
  );
  assert.match(
    plain(getItemDefinition("hostage_note").description),
    /their character has a 50% chance of divorce/,
  );
  assert.match(
    plain(getItemDefinition("counterfeit_crown").description),
    /decoy.*redirect.*attack/i,
  );
  assert.match(
    getItemDefinition("grand_masquerade").description,
    /nobody gets their own character back/,
  );
  assert.doesNotMatch(
    getItemDefinition("chaos_exchange").description,
    /rank interval/,
  );
  assert.match(
    plain(getItemDefinition("heart_for_a_heart").description),
    /larger rank number/,
  );
});

test("resolved timed and counted effects use effective values rather than historical defaults", (t) => {
  const db = fixture(t);
  save(db, "itemEffects", {
    "itemEffects.adrenaline_rush.durationMs": 120000,
    "itemEffects.adrenaline_rush.allowanceMultiplier": 3,
    "itemEffects.rolling_fever.rolls": 4,
    "itemEffects.rolling_fever.refundRolls": 3,
    "itemEffects.rolling_fever.maxRank": 2500,
  });
  assert.match(
    plain(getResolvedItemDefinition(db, "1", "adrenaline_rush").description),
    /3x.*2 minutes/,
  );
  assert.match(
    getResolvedItemDefinition(db, "1", "rolling_fever").description,
    /4 character rolls.*ranked #2500.*better.*3 rolls/,
  );
});

test("Aegis description shows its current effective duration", (t) => {
  const db = fixture(t);
  assert.match(
    plain(getResolvedItemDefinition(db, "1", "aegis_of_fidelity").description),
    /for 7 days/,
  );
  save(db, "itemEffects", {
    "itemEffects.aegis_of_fidelity.protectionMs": 5_400_000,
  });
  assert.match(
    plain(getResolvedItemDefinition(db, "1", "aegis_of_fidelity").description),
    /for 1 hour 30 minutes/,
  );
  assert.match(
    plain(getResolvedItemDefinition(db, "2", "aegis_of_fidelity").description),
    /for 7 days/,
  );
  assert.match(
    plain(
      getItemHelpBullet(
        getResolvedItemDefinition(db, "1", "aegis_of_fidelity"),
      ),
    ),
    /for 1 hour 30 minutes/,
  );
});

test("resolved action descriptions follow configured costs and rank bounds", (t) => {
  const db = fixture(t);
  save(db, "itemActions", {
    "itemActions.alchemistCost": 4,
    "itemActions.chaosMinRankMultiplier": 0.75,
    "itemActions.chaosMaxRankMultiplier": 1.5,
  });
  assert.match(
    getResolvedItemDefinition(db, "1", "alchemist").description,
    /4 Common inventory items/,
  );
  assert.match(
    getResolvedItemDefinition(db, "1", "chaos_exchange").description,
    /0.75x and 1.5x/,
  );
});

test("legacy help no longer promises unlimited rolls or guaranteed rank upgrades", () => {
  assert.doesNotMatch(
    getItemHelpBullet(getItemDefinition("golden_hour")),
    /unlimited|Happy Hour/,
  );
  assert.match(
    getItemHelpBullet(getItemDefinition("golden_hour")),
    /everyone's hourly rolls in this server/,
  );
  assert.doesNotMatch(
    getItemHelpBullet(getItemDefinition("blood_pact")),
    /guaranteed rank upgrade/i,
  );
  assert.match(
    plain(getItemHelpBullet(getItemDefinition("double_date"))),
    /2 free claims/,
  );
  assert.match(
    getItemHelpBullet(getItemDefinition("wish_upon_a_star")),
    /otherwise/,
  );
});

test("approved Kaimetsu normal description remains exact in both definitions", (t) => {
  const db = fixture(t);
  assert.equal(
    plain(getItemDefinition("kaimetsu").description),
    "Divorce half the harem of EVERY user.",
  );
  assert.equal(
    plain(getResolvedItemDefinition(db, "1", "kaimetsu").description),
    "Divorce half the harem of EVERY user.",
  );
});
