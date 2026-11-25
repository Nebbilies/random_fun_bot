import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openCatalog,
  openCatalogReadOnly,
} from "./helpers/preRankingCatalog.js";
import { initializeLegacyCatalog } from "../lib/catalogDb.js";
import {
  inventoryCharacterIdentities,
  convertLegacyCatalogToFinal,
  validateRetainedVaultOverflow,
} from "../lib/characterIdentityMigration.js";
import { settleCharacterMigration } from "../lib/characterMigrationSettlement.js";
import { inspectCatalogRuntimeRestart } from "../lib/catalogRuntimeRecovery.js";
import { getResolvedItemDefinition, ITEM_TIERS } from "../lib/itemRoster.js";
import {
  addItemToInventory,
  getInventory,
  getInventoryCapacity,
  removeItemFromInventory,
} from "../lib/itemStorage.js";
import {
  revealVaultReward,
  decideVaultReward,
  markVaultRewardDelivered,
} from "../lib/vaultRewards.js";

// Only authoritative synthetic v10 fixtures on explicit temporary paths.
const scope = {
  vaultId: "synthetic-overflow",
  guildId: "1",
  userId: "101",
  channelId: "10",
  messageId: "501",
  sourceMessageId: "100",
};
const now = 1_800_000_000_000;
const row = (db) => db.prepare("SELECT * FROM vault_rewards").get();
const inventory = (db) => getInventory(db, scope.guildId, scope.userId, now);
const counts = (db) =>
  Object.fromEntries(
    db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )
      .all()
      .map(({ name }) => [
        name,
        db.prepare(`SELECT count(*) n FROM "${name}"`).get().n,
      ]),
  );
function fixture(t, kind = "kept", acknowledged = false) {
  const directory = mkdtempSync(join(tmpdir(), "migration-overflow-"));
  const path = join(directory, "synthetic.sqlite");
  let db = new DatabaseSync(path);
  initializeLegacyCatalog(db);
  db.exec(
    "INSERT INTO characters(id,rank,favourites,name_full) VALUES(12,1,50,'Synthetic'); INSERT INTO character_identities VALUES(12,'Synthetic',NULL)",
  );
  if (kind !== "kept")
    addItemToInventory(
      db,
      scope.guildId,
      scope.userId,
      "double_or_nothing",
      2,
      { now },
    );
  while (
    inventory(db).length < getInventoryCapacity(db, scope.guildId, scope.userId)
  )
    addItemToInventory(
      db,
      scope.guildId,
      scope.userId,
      "hourglass_of_haste",
      undefined,
      { now },
    );
  const item = getResolvedItemDefinition(
    db,
    scope.guildId,
    "hourglass_of_haste",
  );
  revealVaultReward(db, {
    ...scope,
    outcome: { tier: "common", tierData: ITEM_TIERS.common, item },
    now,
  });
  if (kind !== "kept")
    decideVaultReward(db, {
      ...scope,
      action: kind === "won" ? "gamble" : "keep",
      now: now + 1,
      random: () => 0,
    });
  assert.equal(row(db).state, "overflow");
  if (acknowledged) markVaultRewardDelivered(db, scope.vaultId, now + 2);
  t.after(() => {
    if (db.isOpen) db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    get db() {
      return db;
    },
    path,
    reopen(readOnly) {
      db.close();
      db = (readOnly ? openCatalogReadOnly : openCatalog)(path);
    },
  };
}
for (const kind of ["kept", "decision-kept", "won"])
  for (const acknowledged of [false, true]) {
    test(`${kind} overflow acknowledged=${acknowledged} converts unchanged and accepts exactly once after reopen`, (t) => {
      const f = fixture(t, kind, acknowledged);
      const before = row(f.db),
        items = inventory(f.db),
        totals = counts(f.db);
      const sequence = f.db
        .prepare("SELECT * FROM sqlite_sequence ORDER BY name")
        .all();
      const settlement = settleCharacterMigration(f.db, {
        offline: true,
        backupVerified: true,
        retainOverflow: true,
        now: now + 10,
      });
      assert.deepEqual(settlement.retainedOverflow, [scope.vaultId]);
      assert.deepEqual(settlement.deliveredVaults, []);
      assert.deepEqual(inventory(f.db), items);
      assert.deepEqual(inventoryCharacterIdentities(f.db).blockers, []);
      assert.deepEqual(row(f.db), before);
      convertLegacyCatalogToFinal(f.db);
      assert.equal(f.db.prepare("PRAGMA user_version").get().user_version, 10);
      assert.deepEqual(row(f.db), before);
      convertLegacyCatalogToFinal(f.db, { dryRun: false });
      assert.deepEqual(row(f.db), before);
      assert.deepEqual(inventory(f.db), items);
      const afterCounts = counts(f.db);
      for (const [table, count] of Object.entries(totals))
        assert.equal(afterCounts[table], count, table);
      assert.deepEqual(
        f.db.prepare("SELECT * FROM sqlite_sequence ORDER BY name").all(),
        sequence,
      );
      assert.match(
        f.db.prepare("SELECT id FROM characters").get().id,
        /^[0-9a-f-]{36}$/,
      );
      f.reopen(true);
      const bytes = readFileSync(f.path);
      const restart = inspectCatalogRuntimeRestart(f.db);
      assert.equal(restart.ready, true, JSON.stringify(restart.blockers));
      assert.ok(
        restart.recoverable.some(
          (work) => work.kind === "vault_reward" && work.id === scope.vaultId,
        ),
      );
      assert.deepEqual(row(f.db), before);
      assert.deepEqual(inventory(f.db), items);
      assert.throws(() => f.db.exec("DELETE FROM vault_rewards"), /readonly/);
      assert.deepEqual(readFileSync(f.path), bytes);
      f.reopen(false);
      assert.equal(inspectCatalogRuntimeRestart(f.db).ready, true);
      assert.deepEqual(row(f.db), before);
      const accept = () =>
        decideVaultReward(f.db, {
          ...scope,
          action: "accept",
          now: now + 10,
          random: () => {
            throw Error("must not reroll");
          },
        });
      assert.equal(accept().reward.state, "overflow");
      assert.deepEqual(inventory(f.db), items);
      assert.equal(row(f.db).reward_json, before.reward_json);
      assert.equal(row(f.db).result, before.result);
      assert.ok(removeItemFromInventory(f.db, items[0].id));
      assert.equal(accept().reward.state, "delivered");
      assert.equal(accept().status, "stale");
      const after = inventory(f.db);
      assert.equal(after.length, items.length);
      const inserted = after.filter(
        (entry) => !items.some((old) => old.id === entry.id),
      );
      assert.equal(inserted.length, 1);
      const expected = JSON.parse(before.reward_json).item;
      assert.equal(inserted[0].item_id, expected.id);
      assert.equal(inserted[0].charges, expected.maxCharges ?? 1);
      assert.equal(row(f.db).reward_json, before.reward_json);
      assert.equal(row(f.db).result, before.result);
    });
  }
const jsonChange = (r, column, change) => {
  const value = JSON.parse(r[column]);
  change(value);
  r[column] = JSON.stringify(value);
};
test("retained overflow rejects invalid item fields even with matching Keep provenance", (t) => {
  const f = fixture(t);
  const before = row(f.db);
  for (const [field, value] of [
    ["tier", { characterId: 123 }],
    ["tier", "rare"],
    ["tier", null],
    ["id", { characterId: 123 }],
    ["type", { characterId: 123 }],
    ["name", { characterId: 123 }],
    ["description", { characterId: 123 }],
    ["maxCharges", null],
    ["startingCharges", { characterId: 123 }],
    ["rewardEligible", { characterId: 123 }],
    ["rules", { characterId: 123 }],
    ["rules", { rewardEligible: false }],
    ["unexpected", { characterId: 123 }],
  ]) {
    const changed = { ...before };
    for (const column of ["original_json", "reward_json"]) {
      jsonChange(changed, column, (o) => {
        o.item[field] = value;
      });
    }
    assert.throws(
      () => validateRetainedVaultOverflow(changed),
      /Invalid retained/,
      field,
    );
  }
  const changed = { ...before };
  for (const column of ["original_json", "reward_json"]) {
    jsonChange(changed, column, (o) => {
      o._rewardPools.epic[0].tier = { characterId: 123 };
    });
  }
  assert.throws(
    () => validateRetainedVaultOverflow(changed),
    /Invalid retained/,
  );
  assert.deepEqual(row(f.db), before);
});

test("captured action rules require complete weights and field-specific semantics", (t) => {
  const f = fixture(t),
    before = row(f.db);
  for (const patch of [
    { alchemistRewardWeights: { rare: 1 } },
    { doubleRewardWeights: { epic: 1 } },
    { alchemistCost: 0.5 },
    { alchemistCost: 0 },
    { alchemistCost: 1_000_001 },
    { masqueradeTopRank: 1.5 },
    { confirmationMs: 2_147_483_648 },
    { chaosMinRankMultiplier: 0 },
    { chaosMaxRankMultiplier: 101 },
    { chaosMinRankMultiplier: 3, chaosMaxRankMultiplier: 2 },
    { doubleWinChance: 1.1 },
    { alchemistRewardWeights: { rare: 1, epic: 0, legendary: 1_000_001 } },
    { alchemistRewardWeights: { rare: 0, epic: 0, legendary: 0 } },
  ]) {
    const changed = { ...before };
    for (const column of ["original_json", "reward_json"]) {
      jsonChange(changed, column, (o) => {
        Object.assign(o._rules, patch);
      });
    }
    assert.throws(
      () => validateRetainedVaultOverflow(changed),
      /Invalid retained/,
      JSON.stringify(patch),
    );
  }
  assert.deepEqual(row(f.db), before);
});

test("captured item effect rules retain their configured value semantics", (t) => {
  const f = fixture(t),
    before = row(f.db);
  for (const [id, field, value] of [
    ["bag_of_holding", "capacityIncrease", 0.5],
    ["bag_of_holding", "capacityIncrease", 0],
    ["double_date", "durationMs", 2_147_483_648],
  ]) {
    const changed = { ...before };
    for (const column of ["original_json", "reward_json"]) {
      jsonChange(changed, column, (o) => {
        o._rewardPools.epic.find((item) => item.id === id).rules[field] = value;
      });
    }
    assert.throws(
      () => validateRetainedVaultOverflow(changed),
      /Invalid retained/,
      `${id}.${field}`,
    );
  }
});

test("valid customized producer snapshots are validated without live default reconstruction", (t) => {
  const f = fixture(t),
    captured = { ...row(f.db) };
  for (const column of ["original_json", "reward_json"]) {
    jsonChange(captured, column, (o) => {
      o.item.name = "Captured custom hourglass";
      o.item.description = "Captured custom description";
      o.item.maxCharges =
        o.item.startingCharges =
        o.item.rules.startingCharges =
          7;
      o._rules.alchemistCost = 5;
      o._rules.doubleWinChance = 0.25;
      o._rules.chaosMinRankMultiplier = 0.25;
      o._rules.alchemistRewardWeights = { rare: 0.5, epic: 0, legendary: 2.5 };
      const item = o._rewardPools.epic[0];
      item.name = "Captured custom pool item";
      item.maxCharges = item.startingCharges = item.rules.startingCharges = 4;
    });
  }
  const before = structuredClone(captured);
  assert.doesNotThrow(() => validateRetainedVaultOverflow(captured));
  assert.deepEqual(captured, before);
});

const corruptions = {
  "malformed JSON": (r) => {
    r.reward_json = "{broken";
  },
  "missing determined reward": (r) => {
    r.reward_json = null;
  },
  "unknown outcome field": (r) =>
    jsonChange(r, "original_json", (o) => {
      o.character_id = 12;
    }),
  "unknown item": (r) =>
    jsonChange(r, "reward_json", (o) => {
      o.item.id = "unknown";
    }),
  "zero charges": (r) =>
    jsonChange(r, "reward_json", (o) => {
      o.item.maxCharges = 0;
    }),
  "fractional charges": (r) =>
    jsonChange(r, "reward_json", (o) => {
      o.item.maxCharges = 1.5;
    }),
  "unknown result": (r) => {
    r.result = "maybe";
  },
  "kept mismatch": (r) =>
    jsonChange(r, "reward_json", (o) => {
      o.item.description = "Changed";
    }),
  "missing rules": (r) =>
    jsonChange(r, "original_json", (o) => {
      delete o._rules;
    }),
  "unknown pool item": (r) =>
    jsonChange(r, "original_json", (o) => {
      o._rewardPools.epic.push({ id: "unknown" });
    }),
  "empty guild": (r) => {
    r.guild_id = "";
  },
  "empty message": (r) => {
    r.message_id = "";
  },
  "invalid deadline": (r) => {
    r.deadline = now - 1;
  },
  "missing resolution": (r) => {
    r.resolved_at = null;
  },
  "invalid acknowledgement": (r) => {
    r.delivered_at = -1;
  },
  "forged win": (r) => {
    r.result = "won";
  },
  "live decision": (r) => {
    r.state = "decision";
  },
  "unknown state": (r) => {
    r.state = "unknown";
  },
};
for (const [name, corrupt] of Object.entries(corruptions))
  test(`${name} blocks without mutation`, (t) => {
    const f = fixture(t),
      changed = { ...row(f.db) };
    corrupt(changed);
    const columns = Object.keys(changed).filter((key) => key !== "vault_id");
    f.db
      .prepare(
        `UPDATE vault_rewards SET ${columns.map((key) => `${key}=?`).join(",")} WHERE vault_id=?`,
      )
      .run(...columns.map((key) => changed[key]), changed.vault_id);
    const before = row(f.db),
      items = inventory(f.db);
    assert.ok(
      inventoryCharacterIdentities(f.db).blockers.some((message) =>
        message.includes("vault_rewards"),
      ),
    );
    assert.throws(
      () => convertLegacyCatalogToFinal(f.db, { dryRun: false }),
      /Migration preflight refused/,
    );
    assert.deepEqual(row(f.db), before);
    assert.deepEqual(inventory(f.db), items);
    assert.equal(f.db.prepare("PRAGMA user_version").get().user_version, 10);
  });

function historicalRules(value) {
  delete value._rules.masqueradeConfirmationMs;
  value._rules.masqueradeMaxRankMultiplier = 2;
}
test("exact pre-Masquerade-update captured rules survive settlement, conversion and reward acceptance unchanged", (t) => {
  const f = fixture(t);
  const saved = row(f.db);
  for (const column of ["original_json", "reward_json"])
    jsonChange(saved, column, historicalRules);
  f.db
    .prepare("UPDATE vault_rewards SET original_json=?,reward_json=?")
    .run(saved.original_json, saved.reward_json);
  const before = row(f.db);
  assert.doesNotThrow(() => validateRetainedVaultOverflow(before));
  assert.deepEqual(
    settleCharacterMigration(f.db, {
      offline: true,
      backupVerified: true,
      retainOverflow: true,
      now: now + 10,
    }).retainedOverflow,
    [scope.vaultId],
  );
  assert.deepEqual(inventoryCharacterIdentities(f.db).blockers, []);
  convertLegacyCatalogToFinal(f.db, { dryRun: false });
  f.reopen(false);
  assert.deepEqual(row(f.db), before);
  assert.equal(inspectCatalogRuntimeRestart(f.db).ready, true);
  assert.ok(removeItemFromInventory(f.db, inventory(f.db)[0].id));
  assert.equal(
    decideVaultReward(f.db, { ...scope, action: "accept", now: now + 10 })
      .reward.state,
    "delivered",
  );
  assert.equal(row(f.db).original_json, before.original_json);
  assert.equal(row(f.db).reward_json, before.reward_json);
});
test("historical rules reject hybrids, partial shapes and invalid removed multiplier values", (t) => {
  const f = fixture(t);
  const before = row(f.db);
  for (const mutate of [
    (value) => {
      value._rules.masqueradeConfirmationMs = 180000;
    },
    (value) => {
      delete value._rules.masqueradeMaxRankMultiplier;
    },
    (value) => {
      delete value._rules.hostageDecisionMs;
    },
    (value) => {
      value._rules.unknown = 1;
    },
    ...[null, "2", {}, 0, 101, 0.2].map((max) => (value) => {
      value._rules.masqueradeMaxRankMultiplier = max;
    }),
  ]) {
    const changed = { ...before };
    for (const column of ["original_json", "reward_json"])
      jsonChange(changed, column, (value) => {
        historicalRules(value);
        mutate(value);
      });
    assert.throws(
      () => validateRetainedVaultOverflow(changed),
      /Invalid retained/,
    );
  }
  assert.deepEqual(row(f.db), before);
});
