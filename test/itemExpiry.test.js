import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { upgradeFortuneCatalog } from "../lib/catalogPreRankingUpgrade.js";
import { FORTUNE_DDL } from "../lib/vaultFortuneSchema.js";
import { initGameConfig, saveConfigSection } from "../lib/gameConfig.js";
import { validateFinalCatalogSchema } from "../lib/catalogPreRankingSchema.js";
import {
  initItemStorage,
  addItemToInventory,
  getInventory,
  getUsableInventory,
} from "../lib/itemStorage.js";

test("canonical upgrade backfills once from one rollout instant and retains confirming source authority", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      readFileSync(
        new URL("./fixtures/preFortuneV12.sql", import.meta.url),
        "utf8",
      ),
    );
    db.exec(`INSERT INTO user_inventory VALUES(42,'123','456','hourglass_of_haste',3,'old-date');
      INSERT INTO item_actions(id,kind,guild_id,actor_id,channel_id,inventory_id,state,selections_json,created_at,expires_at)
      VALUES('started','hourglass_of_haste','123','456','789',42,'confirming','{}',5,1000000);`);
    upgradeFortuneCatalog(db, { dryRun: false, now: 1000 });
    assert.equal(getInventory(db, "123", "456", 1000)[0].expires_at, 172801000);
    assert.equal(getUsableInventory(db, "123", "456", 1000).length, 0);
    assert.equal(validateFinalCatalogSchema(db), true);
    upgradeFortuneCatalog(db, { dryRun: false, now: 5000 });
    assert.equal(getInventory(db, "123", "456", 1000)[0].expires_at, 172801000);
    assert.equal(
      db.prepare("SELECT rollout_at FROM item_expiry_schema").get().rollout_at,
      1000,
    );
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    db.close();
  }
});

test("historical pre-expiry competing confirmations preserve the oldest source authority with id tie-breaking", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      readFileSync(
        new URL("./fixtures/preExpiryV12.sql", import.meta.url),
        "utf8",
      ),
    );
    db.exec(`INSERT INTO user_inventory VALUES(42,'123','456','hourglass_of_haste',3,'old-date');
      INSERT INTO item_actions(id,kind,guild_id,actor_id,channel_id,inventory_id,state,selections_json,created_at,expires_at,message_id)
      VALUES('newer','hourglass_of_haste','123','456','789',42,'confirming','{}',6,1000000,'prompt-newer'),
        ('z-oldest','hourglass_of_haste','123','456','789',42,'confirming','{}',5,1000000,'prompt-z'),
        ('a-oldest','hourglass_of_haste','123','456','789',42,'confirming','{}',5,1000000,'prompt-a');`);
    upgradeFortuneCatalog(db, { dryRun: false, now: 1000 });
    assert.deepEqual(
      db
        .prepare("SELECT * FROM item_use_reservations")
        .all()
        .map((row) => ({ ...row })),
      [{ action_id: "a-oldest", inventory_id: 42, started_at: 5 }],
    );
    for (const id of ["newer", "z-oldest"]) {
      const action = db
        .prepare("SELECT * FROM item_actions WHERE id=?")
        .get(id);
      assert.equal(action.state, "canceled");
      assert.equal(action.delivery_pending, 1);
      assert.ok(action.message_id);
      const result = JSON.parse(action.result_json);
      assert.equal(result.status, "canceled");
      assert.match(result.message, /another confirmation/i);
      assert.match(result.message, /no cost/i);
    }
    assert.equal(
      db.prepare("SELECT state FROM item_actions WHERE id='a-oldest'").get()
        .state,
      "confirming",
    );
    assert.equal(
      db.prepare("SELECT charges FROM user_inventory WHERE id=42").get()
        .charges,
      3,
    );
    upgradeFortuneCatalog(db, { dryRun: false, now: 2000 });
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM item_use_reservations").get().n,
      1,
    );
    assert.equal(validateFinalCatalogSchema(db), true);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    db.close();
  }
});

test("historical pre-expiry Fortune and Hostage holds outrank competing confirmations without changing escrow", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      readFileSync(
        new URL("./fixtures/preExpiryV12.sql", import.meta.url),
        "utf8",
      ),
    );
    db.exec(`INSERT INTO user_inventory VALUES(42,'123','456','hostage_note',2,'old-date'),
      (43,'123','456','fortunes_recast',1,'old-date');
      INSERT INTO item_actions(id,kind,guild_id,actor_id,channel_id,inventory_id,state,selections_json,created_at,expires_at)
      VALUES('hostage','hostage_note','123','456','789',42,'awaiting_delivery','{}',9,1000000),
        ('competing-hostage','hostage_note','123','456','789',42,'confirming','{}',1,1000000),
        ('competing-fortune','fortunes_recast','123','456','789',43,'confirming','{}',1,1000000);
      INSERT INTO fortune_holds VALUES(43,'123','456','recast','armed');
      INSERT INTO fortune_armed VALUES('123','456',43,9);`);
    const source = db.prepare("SELECT * FROM user_inventory WHERE id=42").get();
    db.prepare("INSERT INTO item_action_costs VALUES(?,?,?)").run(
      "hostage",
      42,
      JSON.stringify(source),
    );
    const holds = db.prepare("SELECT * FROM fortune_holds").all();
    const armed = db.prepare("SELECT * FROM fortune_armed").all();
    upgradeFortuneCatalog(db, { dryRun: false, now: 1000 });
    for (const id of ["competing-hostage", "competing-fortune"]) {
      const action = db
        .prepare("SELECT * FROM item_actions WHERE id=?")
        .get(id);
      assert.equal(action.state, "canceled");
      assert.equal(action.delivery_pending, 1);
      assert.match(JSON.parse(action.result_json).message, /held.*no cost/i);
    }
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM item_use_reservations").get().n,
      0,
    );
    assert.equal(
      db.prepare("SELECT state FROM item_actions WHERE id='hostage'").get()
        .state,
      "awaiting_delivery",
    );
    assert.deepEqual(
      JSON.parse(
        db.prepare("SELECT snapshot_json FROM item_action_costs").get()
          .snapshot_json,
      ),
      { ...db.prepare("SELECT * FROM user_inventory WHERE id=42").get() },
    );
    assert.deepEqual(db.prepare("SELECT * FROM fortune_holds").all(), holds);
    assert.deepEqual(db.prepare("SELECT * FROM fortune_armed").all(), armed);
    assert.deepEqual(
      db
        .prepare("SELECT id,charges FROM user_inventory ORDER BY id")
        .all()
        .map((row) => ({ ...row })),
      [
        { id: 42, charges: 2 },
        { id: 43, charges: 1 },
      ],
    );
    assert.equal(validateFinalCatalogSchema(db), true);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    db.close();
  }
});

test("historical pre-expiry missing and spent confirmation sources cancel without consuming anything", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      readFileSync(
        new URL("./fixtures/preExpiryV12.sql", import.meta.url),
        "utf8",
      ),
    );
    db.exec(`INSERT INTO user_inventory VALUES(42,'123','456','hourglass_of_haste',0,'old-date');
      INSERT INTO item_actions(id,kind,guild_id,actor_id,channel_id,inventory_id,state,selections_json,created_at,expires_at)
      VALUES('spent','hourglass_of_haste','123','456','789',42,'confirming','{}',5,1000000),
        ('missing','hourglass_of_haste','123','456','789',99,'confirming','{}',5,1000000);`);
    upgradeFortuneCatalog(db, { dryRun: false, now: 1000 });
    for (const action of db.prepare("SELECT * FROM item_actions").all()) {
      assert.equal(action.state, "canceled");
      assert.equal(action.delivery_pending, 1);
      const result = JSON.parse(action.result_json);
      assert.equal(result.status, "canceled");
      assert.match(result.message, /source.*(missing|spent).*no cost/i);
    }
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM item_use_reservations").get().n,
      0,
    );
    assert.equal(
      db.prepare("SELECT charges FROM user_inventory WHERE id=42").get()
        .charges,
      0,
    );
    assert.equal(validateFinalCatalogSchema(db), true);
  } finally {
    db.close();
  }
});

test("historical pre-expiry confirmation with its own exact escrow keeps that authority without a duplicate reservation", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      readFileSync(
        new URL("./fixtures/preExpiryV12.sql", import.meta.url),
        "utf8",
      ),
    );
    db.exec(`INSERT INTO user_inventory VALUES(42,'123','456','hostage_note',2,'old-date');
      INSERT INTO item_actions(id,kind,guild_id,actor_id,channel_id,inventory_id,state,selections_json,created_at,expires_at)
      VALUES('escrow-owner','hostage_note','123','456','789',42,'confirming','{}',9,1000000),
        ('older-prompt','hostage_note','123','456','789',42,'confirming','{}',1,1000000);`);
    db.prepare("INSERT INTO item_action_costs VALUES(?,?,?)").run(
      "escrow-owner",
      42,
      JSON.stringify(
        db.prepare("SELECT * FROM user_inventory WHERE id=42").get(),
      ),
    );
    upgradeFortuneCatalog(db, { dryRun: false, now: 1000 });
    assert.equal(
      db.prepare("SELECT state FROM item_actions WHERE id='escrow-owner'").get()
        .state,
      "confirming",
    );
    assert.equal(
      db.prepare("SELECT state FROM item_actions WHERE id='older-prompt'").get()
        .state,
      "canceled",
    );
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM item_use_reservations").get().n,
      0,
    );
    assert.equal(
      db.prepare("SELECT action_id FROM item_action_costs").get().action_id,
      "escrow-owner",
    );
  } finally {
    db.close();
  }
});

test("historical pre-expiry reconciliation still rejects ambiguous sources and invalid escrow atomically", () => {
  for (const scenario of [
    "owner mismatch",
    "kind mismatch",
    "missing escrow source",
    "altered escrow",
    "invalid escrow JSON",
  ]) {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(
        readFileSync(
          new URL("./fixtures/preExpiryV12.sql", import.meta.url),
          "utf8",
        ),
      );
      db.exec(`INSERT INTO user_inventory VALUES(42,'123','456','hostage_note',2,'old-date');
        INSERT INTO item_actions(id,kind,guild_id,actor_id,channel_id,inventory_id,state,selections_json,created_at,expires_at)
        VALUES('prompt','hostage_note','123','456','789',42,'confirming','{}',5,1000000);`);
      const source = {
        ...db.prepare("SELECT * FROM user_inventory WHERE id=42").get(),
      };
      if (scenario === "owner mismatch")
        db.exec("UPDATE item_actions SET actor_id='other'");
      else if (scenario === "kind mismatch")
        db.exec("UPDATE item_actions SET kind='hourglass_of_haste'");
      else {
        const snapshot =
          scenario === "invalid escrow JSON"
            ? "{"
            : JSON.stringify({
                ...source,
                ...(scenario === "altered escrow" ? { charges: 1 } : {}),
              });
        db.prepare("INSERT INTO item_action_costs VALUES(?,?,?)").run(
          "prompt",
          42,
          snapshot,
        );
        if (scenario === "missing escrow source")
          db.exec("DELETE FROM user_inventory");
      }
      const schema = db
        .prepare("SELECT * FROM sqlite_schema ORDER BY name")
        .all();
      const actions = db.prepare("SELECT * FROM item_actions").all();
      const costs = db.prepare("SELECT * FROM item_action_costs").all();
      const inventory = db.prepare("SELECT * FROM user_inventory").all();
      assert.throws(
        () => upgradeFortuneCatalog(db, { dryRun: false, now: 1000 }),
        /Item expiry action|[Ii]nvalid item expiry escrow|Item expiry escrow/,
        scenario,
      );
      assert.deepEqual(
        db.prepare("SELECT * FROM sqlite_schema ORDER BY name").all(),
        schema,
        scenario,
      );
      assert.deepEqual(
        db.prepare("SELECT * FROM item_actions").all(),
        actions,
        scenario,
      );
      assert.deepEqual(
        db.prepare("SELECT * FROM item_action_costs").all(),
        costs,
        scenario,
      );
      assert.deepEqual(
        db.prepare("SELECT * FROM user_inventory").all(),
        inventory,
        scenario,
      );
      assert.equal(db.isTransaction, false);
    } finally {
      db.close();
    }
  }
});

test("expired retained sources free capacity and live duplicates sort by deadline then id", () => {
  const db = new DatabaseSync(":memory:");
  try {
    initItemStorage(db);
    const held = addItemToInventory(db, "123", "456", "hourglass_of_haste", 3, {
      now: 0,
    }).item;
    db.prepare(
      `INSERT INTO item_actions(id,kind,guild_id,actor_id,channel_id,inventory_id,state,selections_json,created_at,expires_at)
      VALUES('held','alchemist','123','456','789',?,'confirming','{}',0,999999999)`,
    ).run(held.id);
    db.prepare("INSERT INTO item_use_reservations VALUES(?,?,?)").run(
      "held",
      held.id,
      0,
    );
    const later = addItemToInventory(
      db,
      "123",
      "456",
      "hourglass_of_haste",
      1,
      { now: 2000 },
    ).item;
    const sooner = addItemToInventory(
      db,
      "123",
      "456",
      "hourglass_of_haste",
      1,
      { now: 1000 },
    ).item;
    assert.deepEqual(
      getInventory(db, "123", "456", 172800000).map((row) => row.id),
      [sooner.id, later.id],
    );
    for (let i = 0; i < 3; i++)
      assert.equal(
        addItemToInventory(db, "123", "456", "love_letter", 1, {
          now: 172800000,
        }).status,
        "added",
      );
    assert.equal(
      addItemToInventory(db, "123", "456", "love_letter", 1, { now: 172800000 })
        .status,
      "full",
    );
    assert.equal(
      db.prepare("SELECT charges FROM user_inventory WHERE id=?").get(held.id)
        .charges,
      3,
    );
  } finally {
    db.close();
  }
});

test("unknown legacy definitions abort the entire upgrade without installing either extension", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      readFileSync(
        new URL("./fixtures/preFortuneV12.sql", import.meta.url),
        "utf8",
      ),
    );
    db.exec(
      "INSERT INTO user_inventory VALUES(1,'123','456','unknown',1,'old')",
    );
    const before = db
      .prepare("SELECT * FROM sqlite_schema ORDER BY name")
      .all();
    assert.throws(
      () => upgradeFortuneCatalog(db, { dryRun: false, now: 1000 }),
      /Unknown inventory item definition: unknown/,
    );
    assert.deepEqual(
      db.prepare("SELECT * FROM sqlite_schema ORDER BY name").all(),
      before,
    );
    assert.equal(db.isTransaction, false);
  } finally {
    db.close();
  }
});

test("held Hostage snapshots acquire the same deadline while Fortune raw references survive upgrade", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      readFileSync(
        new URL("./fixtures/preFortuneV12.sql", import.meta.url),
        "utf8",
      ),
    );
    db.exec(`INSERT INTO user_inventory VALUES(42,'123','456','hostage_note',2,'old-date');
      INSERT INTO item_actions(id,kind,guild_id,actor_id,channel_id,inventory_id,state,selections_json,created_at,expires_at)
      VALUES('started','hostage_note','123','456','789',42,'awaiting_delivery','{}',5,1000000);`);
    db.exec(FORTUNE_DDL);
    db.exec("INSERT INTO fortune_holds VALUES(42,'123','456','recast','ref')");
    const source = db.prepare("SELECT * FROM user_inventory WHERE id=42").get();
    db.prepare("INSERT INTO item_action_costs VALUES(?,?,?)").run(
      "started",
      42,
      JSON.stringify(source),
    );
    upgradeFortuneCatalog(db, { dryRun: false, now: 1000 });
    const upgraded = db
      .prepare("SELECT * FROM user_inventory WHERE id=42")
      .get();
    assert.deepEqual(
      JSON.parse(
        db.prepare("SELECT snapshot_json FROM item_action_costs").get()
          .snapshot_json,
      ),
      { ...upgraded },
    );
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM item_use_reservations").get().n,
      0,
    );
    assert.equal(
      db.prepare("SELECT reference_id FROM fortune_holds").get().reference_id,
      "ref",
    );
    assert.equal(getInventory(db, "123", "456", upgraded.expires_at).length, 0);
    assert.equal(
      db.prepare("SELECT charges FROM user_inventory WHERE id=42").get()
        .charges,
      2,
    );
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    db.close();
  }
});

test("effective lifetime overrides stamp future acquisitions only, including 365-day deadlines", () => {
  const db = new DatabaseSync(":memory:");
  try {
    initItemStorage(db);
    initGameConfig(db);
    const first = addItemToInventory(
      db,
      "123",
      "456",
      "hourglass_of_haste",
      1,
      { now: 1000 },
    ).item;
    saveConfigSection(db, {
      section: "itemExpiryDays",
      values: { "itemExpiryDays.common": 365 },
      expectedRevision: 0,
    });
    const second = addItemToInventory(
      db,
      "123",
      "456",
      "hourglass_of_haste",
      1,
      { now: 1000 },
    ).item;
    assert.equal(second.expires_at, 31536001000);
    assert.equal(
      getInventory(db, "123", "456", 1000).find((row) => row.id === first.id)
        .expires_at,
      172801000,
    );
    saveConfigSection(db, {
      guildId: "123",
      section: "itemExpiryDays",
      values: { "itemExpiryDays.common": 4 },
      expectedRevision: 1,
    });
    assert.equal(
      addItemToInventory(db, "123", "456", "hourglass_of_haste", 1, {
        now: 1000,
      }).item.expires_at,
      345601000,
    );
  } finally {
    db.close();
  }
});

test("invalid rollout configuration rolls back and a corrected retry uses only its committed instant", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      readFileSync(
        new URL("./fixtures/preFortuneV12.sql", import.meta.url),
        "utf8",
      ),
    );
    db.exec(`INSERT INTO user_inventory VALUES(1,'123','456','hourglass_of_haste',1,'old');
      INSERT INTO game_config_overrides VALUES('123','itemExpiryDays.common','0');`);
    assert.throws(
      () => upgradeFortuneCatalog(db, { dryRun: false, now: 1000 }),
      /Invalid item expiry days/,
    );
    assert.equal(
      db
        .prepare("SELECT 1 FROM sqlite_schema WHERE name='item_expiry_schema'")
        .get(),
      undefined,
    );
    db.exec(
      "UPDATE game_config_overrides SET value_json='4' WHERE key='itemExpiryDays.common'",
    );
    upgradeFortuneCatalog(db, { dryRun: false, now: 2000 });
    assert.equal(getInventory(db, "123", "456", 2000)[0].expires_at, 345602000);
    assert.equal(
      db.prepare("SELECT rollout_at FROM item_expiry_schema").get().rollout_at,
      2000,
    );
  } finally {
    db.close();
  }
});

// Agreed seam: public inventory storage, with controlled operation clocks.
test("acquisition stamps a fixed deadline and expiry excludes the exact boundary without deleting provenance", () => {
  const db = new DatabaseSync(":memory:");
  try {
    initItemStorage(db);
    const added = addItemToInventory(
      db,
      "123",
      "456",
      "hourglass_of_haste",
      3,
      { now: 1000 },
    );
    assert.equal(added.item.expires_at, 172801000);
    assert.equal(added.item.acquired_at, "1970-01-01T00:00:01.000Z");
    assert.equal(getInventory(db, "123", "456", 172800999).length, 1);
    assert.equal(getInventory(db, "123", "456", 172801000).length, 0);
    assert.equal(getUsableInventory(db, "123", "456", 172801000).length, 0);
    assert.equal(
      db
        .prepare("SELECT charges FROM user_inventory WHERE id=?")
        .get(added.item.id).charges,
      3,
    );
  } finally {
    db.close();
  }
});
