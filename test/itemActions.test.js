import assert from "node:assert/strict";
import { test } from "node:test";
import { openCatalog } from "../lib/catalogDb.js";
import { addItemToInventory, getInventory } from "../lib/itemStorage.js";
import { getItemsInTier } from "../lib/itemRoster.js";
import {
  createItemAction,
  activateItemAction,
  confirmHostageDelivery,
  cancelUndeliveredHostage,
  resolveHostage,
  cancelItemAction,
  recoverItemActions,
} from "../lib/itemActions.js";
import { executeItemUse } from "../commands/use.js";
import {
  startForcedEscape,
  recoverForcedEscapes,
} from "../lib/characterRollRuntime.js";
import { marryCharacter, getMarriage } from "../lib/characterMarriage.js";

test("confirmation reserves its source against duplicate starts and releases on cancellation", () => {
  const db = openCatalog(":memory:");
  try {
    const source = addItemToInventory(db, "1", "101", "kaimetsu", 2).item;
    const request = {
      guildId: "1",
      actorId: "101",
      channelId: "10",
      inventoryId: source.id,
    };
    const first = createItemAction(db, request);
    assert.equal(first.state, "confirming");
    assert.equal(createItemAction(db, request).status, "invalid");
    assert.equal(cancelItemAction(db, first.id, "1", "101"), true);
    assert.equal(createItemAction(db, request).state, "confirming");
  } finally {
    db.close();
  }
});

function expiryFixture(db, itemId, charges = 2) {
  const source = addItemToInventory(db, "1", "101", itemId, charges).item;
  db.prepare("UPDATE user_inventory SET expires_at=2000 WHERE id=?").run(
    source.id,
  );
  return source;
}

test("expiry gates only start: a reserved confirmation survives recovery and spends one charge once", () => {
  const db = openCatalog(":memory:");
  try {
    db.exec(
      "INSERT INTO characters(id,rank,favourites,name_full) VALUES(1,50,1,'Target')",
    );
    const target = marryCharacter(db, "1", 1, "202").marriage;
    const source = expiryFixture(db, "severed_fate");
    const request = {
      guildId: "1",
      actorId: "101",
      channelId: "10",
      inventoryId: source.id,
      selections: {
        targets: [{ characterId: 1, ownerId: "202", marriageId: target.id }],
      },
    };
    assert.equal(
      createItemAction(db, { ...request, now: 2000 }).status,
      "invalid",
    );
    const action = createItemAction(db, { ...request, now: 1999 });
    recoverItemActions(db, 2001);
    assert.equal(
      activateItemAction(db, {
        actionId: action.id,
        guildId: "1",
        actorId: "101",
        now: 2001,
      }).status,
      "resolved",
    );
    assert.equal(getMarriage(db, "1", 1), null);
    assert.equal(getInventory(db, "1", "101", 1999)[0].charges, 1);
    assert.deepEqual(getInventory(db, "1", "101", 2001), []);
    assert.equal(
      createItemAction(db, { ...request, now: 2001 }).status,
      "invalid",
    );
    assert.equal(
      activateItemAction(db, {
        actionId: action.id,
        guildId: "1",
        actorId: "101",
        now: 2002,
      }).status,
      "resolved",
    );
    assert.equal(getInventory(db, "1", "101", 1999)[0].charges, 1);
  } finally {
    db.close();
  }
});

for (const ending of ["cancel", "timeout", "invalid"])
  test(`expired confirmation ${ending} never revives leftover charges`, () => {
    const db = openCatalog(":memory:");
    try {
      const source = expiryFixture(db, "severed_fate");
      const request = {
        guildId: "1",
        actorId: "101",
        channelId: "10",
        inventoryId: source.id,
        now: 1999,
      };
      const action = createItemAction(db, request);
      if (ending === "cancel") cancelItemAction(db, action.id, "1", "101");
      else if (ending === "timeout") recoverItemActions(db, action.expires_at);
      else
        assert.equal(
          activateItemAction(db, {
            actionId: action.id,
            guildId: "1",
            actorId: "101",
            now: 2001,
          }).status,
          "invalid",
        );
      assert.deepEqual(getInventory(db, "1", "101", 2001), []);
      assert.equal(
        createItemAction(db, { ...request, now: 2001 }).status,
        "invalid",
      );
    } finally {
      db.close();
    }
  });

for (const delivered of [false, true])
  test(`Hostage reserved before expiry settles delivery=${delivered} after expiry`, () => {
    const db = openCatalog(":memory:");
    try {
      db.exec(
        "INSERT INTO characters(id,rank,favourites,name_full) VALUES(1,50,1,'Own'),(2,100,1,'Target')",
      );
      const own = marryCharacter(db, "1", 1, "101").marriage;
      const target = marryCharacter(db, "1", 2, "202").marriage;
      const source = expiryFixture(db, "hostage_note");
      const action = createItemAction(db, {
        guildId: "1",
        actorId: "101",
        channelId: "10",
        inventoryId: source.id,
        now: 1999,
        selections: {
          own: { characterId: 1, ownerId: "101", marriageId: own.id },
          targets: [{ characterId: 2, ownerId: "202", marriageId: target.id }],
        },
      });
      assert.equal(
        activateItemAction(db, {
          actionId: action.id,
          guildId: "1",
          actorId: "101",
          now: 2001,
        }).status,
        "awaiting_delivery",
      );
      if (delivered) {
        assert.equal(
          confirmHostageDelivery(db, action.id, "message", 2002),
          true,
        );
        assert.equal(
          confirmHostageDelivery(db, action.id, "message", 2003),
          false,
        );
        assert.equal(
          resolveHostage(db, {
            actionId: action.id,
            guildId: "1",
            userId: "202",
            choice: "exchange",
            now: 2004,
          }).status,
          "resolved",
        );
      } else assert.equal(cancelUndeliveredHostage(db, action.id), true);
      assert.deepEqual(getInventory(db, "1", "101", 2004), []);
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      db.close();
    }
  });

test("Alchemist continuation cannot grandfather expired additional materials", () => {
  const db = openCatalog(":memory:");
  try {
    const source = expiryFixture(db, "alchemist");
    const costs = Array.from(
      { length: 3 },
      () => expiryFixture(db, "hourglass_of_haste").id,
    );
    const action = createItemAction(db, {
      guildId: "1",
      actorId: "101",
      channelId: "10",
      inventoryId: source.id,
      selections: { inventoryIds: costs },
      now: 1999,
    });
    assert.equal(
      activateItemAction(db, {
        actionId: action.id,
        guildId: "1",
        actorId: "101",
        now: 2001,
      }).status,
      "invalid",
    );
    assert.deepEqual(getInventory(db, "1", "101", 2001), []);
  } finally {
    db.close();
  }
});

test("Masquerade rolls back defenses, costs, and all transfers when persistence fails", () => {
  const db = openCatalog(":memory:");
  try {
    const choices = [];
    for (let i = 1; i <= 4; i++) {
      db.prepare(
        "INSERT INTO characters(id,rank,favourites,name_full) VALUES(?,?,1,?)",
      ).run(i, 100 + i, `Character ${i}`);
      const marriage = marryCharacter(db, "1", i, `${i}01`).marriage;
      choices.push({
        characterId: i,
        ownerId: `${i}01`,
        marriageId: marriage.id,
      });
    }
    const item = addItemToInventory(db, "1", "101", "grand_masquerade").item;
    const action = createItemAction(db, {
      guildId: "1",
      actorId: "101",
      channelId: "10",
      inventoryId: item.id,
      selections: { own: choices[0], targets: choices.slice(1) },
    });
    db.exec(
      "CREATE TRIGGER reject_transfer BEFORE UPDATE ON marriages WHEN OLD.character_id=3 BEGIN SELECT RAISE(ABORT,'simulated persistence failure'); END",
    );
    assert.throws(
      () =>
        activateItemAction(db, {
          actionId: action.id,
          guildId: "1",
          actorId: "101",
          random: () => 0,
        }),
      /simulated persistence failure/,
    );
    choices.forEach((row) =>
      assert.equal(getMarriage(db, "1", row.characterId).ownerId, row.ownerId),
    );
    assert.deepEqual(getInventory(db, "1", "101"), [item]);
    assert.equal(
      db.prepare("SELECT state FROM item_actions WHERE id=?").get(action.id)
        .state,
      "confirming",
    );
  } finally {
    db.close();
  }
});

test("Siren delivery failure retries the committed effective escape without another cost", async () => {
  const db = openCatalog(":memory:");
  try {
    db.exec(
      "INSERT INTO characters(id,rank,favourites,name_full) VALUES(1,50,1,'Victim')",
    );
    marryCharacter(db, "1", 1, "202");
    addItemToInventory(db, "1", "101", "sirens_call");
    const result = executeItemUse(db, "1", "101", "sirens_call", ["202"], {
      channelId: "10",
      random: () => 0,
    });
    await assert.rejects(
      startForcedEscape({
        db,
        guildId: "1",
        channelId: "10",
        channel: {
          send: async () => {
            throw Error("offline");
          },
        },
        ...result.escapeAttempt,
      }),
    );
    assert.equal(
      db.prepare("SELECT state FROM character_rolls").get().state,
      "pending",
    );
    assert.equal(getInventory(db, "1", "101").length, 0);
    let sends = 0;
    await recoverForcedEscapes(db, {
      channels: {
        fetch: async () => ({
          send: async () => {
            sends++;
            return { id: "999", edit: async () => {}, react: async () => {} };
          },
        }),
      },
    });
    assert.equal(sends, 1);
    assert.equal(
      db.prepare("SELECT state FROM character_rolls").get().state,
      "open",
    );
    await recoverForcedEscapes(db, {
      channels: {
        fetch: async () => {
          throw Error("must not retry");
        },
      },
    });
    assert.equal(getInventory(db, "1", "101").length, 0);
  } finally {
    db.close();
  }
});

test("Crown redirects only defender after rank validation and Shield preserves both characters", () => {
  const db = openCatalog(":memory:");
  try {
    db.exec(
      "INSERT INTO characters(id,rank,favourites,name_full) VALUES(1,50,1,'Own'),(2,100,1,'Original'),(3,1,1,'Decoy')",
    );
    const snapshots = [
      marryCharacter(db, "1", 1, "101").marriage,
      marryCharacter(db, "1", 2, "202").marriage,
      marryCharacter(db, "1", 3, "202").marriage,
    ];
    const choice = (i, ownerId) => ({
      characterId: i,
      ownerId,
      marriageId: snapshots[i - 1].id,
    });
    const use = (kind, actorId, selections) => {
      const item = addItemToInventory(db, "1", actorId, kind).item;
      const action = createItemAction(db, {
        guildId: "1",
        actorId,
        channelId: "10",
        inventoryId: item.id,
        selections,
      });
      return activateItemAction(db, {
        actionId: action.id,
        guildId: "1",
        actorId,
      });
    };
    assert.equal(
      use("counterfeit_crown", "202", { own: choice(3, "202") }).status,
      "resolved",
    );
    addItemToInventory(db, "1", "202", "mirror_shield");
    assert.equal(
      use("heart_for_a_heart", "101", {
        own: choice(1, "101"),
        targets: [choice(2, "202")],
      }).blocked,
      true,
    );
    assert.ok(getMarriage(db, "1", 1));
    assert.ok(db.prepare("SELECT 1 FROM counterfeit_crowns").get());
    const result = use("heart_for_a_heart", "101", {
      own: choice(1, "101"),
      targets: [choice(2, "202")],
    });
    assert.equal(result.status, "resolved");
    assert.equal(getMarriage(db, "1", 1), null);
    assert.equal(getMarriage(db, "1", 3), null);
    assert.equal(getMarriage(db, "1", 2).ownerId, "202");
  } finally {
    db.close();
  }
});

test("Grand Masquerade redistributes all contributions with no fixed points and ignores Shield", () => {
  const db = openCatalog(":memory:");
  try {
    const choices = [];
    for (let i = 1; i <= 4; i++) {
      db.prepare(
        "INSERT INTO characters(id,rank,favourites,name_full) VALUES(?,?,1,?)",
      ).run(i, 100 + i, `Character ${i}`);
      const marriage = marryCharacter(db, "1", i, `${i}01`).marriage;
      choices.push({
        characterId: i,
        ownerId: `${i}01`,
        marriageId: marriage.id,
      });
    }
    addItemToInventory(db, "1", "201", "mirror_shield");
    const item = addItemToInventory(db, "1", "101", "grand_masquerade").item;
    const action = createItemAction(db, {
      guildId: "1",
      actorId: "101",
      channelId: "10",
      inventoryId: item.id,
      selections: { own: choices[0], targets: choices.slice(1) },
    });
    const result = activateItemAction(db, {
      actionId: action.id,
      guildId: "1",
      actorId: "101",
      random: () => 0,
    });
    assert.equal(result.status, "resolved");
    const owners = choices.map(
      (row) => getMarriage(db, "1", row.characterId).ownerId,
    );
    assert.equal(new Set(owners).size, choices.length);
    choices.forEach((row, i) => assert.notEqual(owners[i], row.ownerId));
    assert.equal(getInventory(db, "1", "201")[0].item_id, "mirror_shield");
  } finally {
    db.close();
  }
});

for (const [ownRank, targetRank, expected] of [
  [101, 10000, "resolved"], // No 2× cap.
  [101, 41, "resolved"], // ceil(0.4 × 101).
  [101, 40, "invalid"],
  [100, 1, "resolved"], // Top-100 exception.
  [101, 1, "invalid"],
])
  test(`Grand Masquerade rank ${ownRank} targeting ${targetRank}: ${expected}`, () => {
    const db = openCatalog(":memory:");
    try {
      const choices = [ownRank, targetRank, 150, 160].map((rank, index) => {
        const id = index + 1;
        const ownerId = `${id}01`;
        db.prepare(
          "INSERT INTO characters(id,rank,favourites,name_full) VALUES(?,?,1,?)",
        ).run(id, rank, `Character ${id}`);
        const marriage = marryCharacter(db, "1", id, ownerId).marriage;
        return { characterId: id, ownerId, marriageId: marriage.id };
      });
      const item = addItemToInventory(db, "1", "101", "grand_masquerade").item;
      const action = createItemAction(db, {
        guildId: "1",
        actorId: "101",
        channelId: "10",
        inventoryId: item.id,
        selections: { own: choices[0], targets: choices.slice(1) },
        now: 1000,
      });
      assert.equal(action.expires_at, 181000);
      const result = activateItemAction(db, {
        actionId: action.id,
        guildId: "1",
        actorId: "101",
        now: 180999,
        random: () => 0,
      });
      assert.equal(result.status, expected);
      if (expected === "invalid") {
        assert.deepEqual(getInventory(db, "1", "101"), [item]);
        choices.forEach((choice) =>
          assert.equal(
            getMarriage(db, "1", choice.characterId).ownerId,
            choice.ownerId,
          ),
        );
      }
    } finally {
      db.close();
    }
  });

test("Chaos Exchange empty pool preserves sacrifice and item", () => {
  const db = openCatalog(":memory:");
  try {
    db.exec(
      "INSERT INTO characters(id,rank,favourites,name_full) VALUES(1,100,1,'Own')",
    );
    const marriage = marryCharacter(db, "1", 1, "101").marriage;
    const item = addItemToInventory(db, "1", "101", "chaos_exchange").item;
    const action = createItemAction(db, {
      guildId: "1",
      actorId: "101",
      channelId: "10",
      inventoryId: item.id,
      selections: {
        own: { characterId: 1, ownerId: "101", marriageId: marriage.id },
      },
    });
    assert.equal(
      activateItemAction(db, {
        actionId: action.id,
        guildId: "1",
        actorId: "101",
      }).status,
      "invalid",
    );
    assert.equal(getMarriage(db, "1", 1).id, marriage.id);
    assert.deepEqual(getInventory(db, "1", "101"), [item]);
  } finally {
    db.close();
  }
});

test("Hostage delivery failure restores exact Note and confirmed Exchange resolves once", () => {
  const db = openCatalog(":memory:");
  try {
    db.exec(
      "INSERT INTO characters(id,rank,favourites,name_full) VALUES(1,50,1,'Stake'),(2,100,1,'Victim')",
    );
    const a = marryCharacter(db, "1", 1, "101").marriage;
    const b = marryCharacter(db, "1", 2, "202").marriage;
    const source = addItemToInventory(db, "1", "101", "hostage_note").item;
    const request = {
      guildId: "1",
      actorId: "101",
      channelId: "10",
      inventoryId: source.id,
      selections: {
        own: { characterId: 1, ownerId: "101", marriageId: a.id },
        targets: [{ characterId: 2, ownerId: "202", marriageId: b.id }],
      },
    };
    const first = createItemAction(db, request);
    assert.equal(
      activateItemAction(db, {
        actionId: first.id,
        guildId: "1",
        actorId: "101",
      }).status,
      "awaiting_delivery",
    );
    assert.deepEqual(getInventory(db, "1", "101"), [source]);
    assert.equal(cancelUndeliveredHostage(db, first.id), true);
    assert.deepEqual(getInventory(db, "1", "101"), [source]);
    const second = createItemAction(db, request);
    activateItemAction(db, {
      actionId: second.id,
      guildId: "1",
      actorId: "101",
    });
    confirmHostageDelivery(db, second.id, "999");
    assert.equal(getInventory(db, "1", "101").length, 0);
    const result = resolveHostage(db, {
      actionId: second.id,
      guildId: "1",
      userId: "202",
      choice: "exchange",
    });
    assert.equal(result.status, "resolved");
    assert.equal(getMarriage(db, "1", 1).ownerId, "202");
    assert.equal(getMarriage(db, "1", 2).ownerId, "101");
    resolveHostage(db, {
      actionId: second.id,
      guildId: "1",
      userId: "202",
      choice: "gamble",
      random: () => {
        throw Error("reroll");
      },
    });
    assert.equal(getMarriage(db, "1", 1).ownerId, "202");
  } finally {
    db.close();
  }
});

for (const timeout of [false, true])
  for (const draw of [0, 0.499999, 0.5, 0.999999]) {
    test(`Hostage ${timeout ? "timeout" : "decline"} draw ${draw} risks only the victim and settles once`, () => {
      const db = openCatalog(":memory:");
      try {
        db.exec(
          "INSERT INTO characters(id,rank,favourites,name_full) VALUES(1,50,1,'Stake'),(2,100,1,'Victim')",
        );
        const own = marryCharacter(db, "1", 1, "101").marriage;
        const victim = marryCharacter(db, "1", 2, "202").marriage;
        const item = addItemToInventory(db, "1", "101", "hostage_note").item;
        const action = createItemAction(db, {
          guildId: "1",
          actorId: "101",
          channelId: "10",
          inventoryId: item.id,
          selections: {
            own: { characterId: 1, ownerId: "101", marriageId: own.id },
            targets: [
              { characterId: 2, ownerId: "202", marriageId: victim.id },
            ],
          },
          now: 100,
        });
        activateItemAction(db, {
          actionId: action.id,
          guildId: "1",
          actorId: "101",
          now: 101,
        });
        confirmHostageDelivery(db, action.id, "999", 102);
        const request = {
          actionId: action.id,
          guildId: "1",
          userId: "202",
          choice: timeout ? "exchange" : "gamble",
          now: timeout ? 60102 : 103,
          random: () => draw,
        };
        const result = resolveHostage(db, request);
        assert.equal(result.status, "resolved");
        assert.equal(result.choice, "gamble");
        assert.equal(getMarriage(db, "1", 1).id, own.id);
        assert.equal(getMarriage(db, "1", 1).ownerId, "101");
        assert.equal(result.loser?.characterId ?? null, draw < 0.5 ? 2 : null);
        if (draw < 0.5) {
          assert.equal(getMarriage(db, "1", 2), null);
          assert.match(result.message, /Victim.*was divorced/);
        } else {
          assert.equal(getMarriage(db, "1", 2).id, victim.id);
          assert.match(result.message, /Both characters remain/);
        }
        assert.equal(
          db
            .prepare("SELECT COUNT(*) AS n FROM item_character_reservations")
            .get().n,
          0,
        );
        assert.equal(getInventory(db, "1", "101").length, 0);
        resolveHostage(db, {
          ...request,
          random: () => {
            throw Error("reroll");
          },
        });
        assert.equal(getMarriage(db, "1", 1).id, own.id);
      } finally {
        db.close();
      }
    });
  }

test("Severed Fate divorces its target without an owned contribution", () => {
  const db = openCatalog(":memory:");
  try {
    db.exec(
      "INSERT INTO characters(id,rank,favourites,name_full) VALUES(1,50,1,'Target')",
    );
    const target = marryCharacter(db, "1", 1, "202").marriage;
    const item = addItemToInventory(db, "1", "101", "severed_fate").item;
    const action = createItemAction(db, {
      guildId: "1",
      actorId: "101",
      channelId: "10",
      inventoryId: item.id,
      selections: {
        targets: [{ characterId: 1, ownerId: "202", marriageId: target.id }],
      },
    });
    const result = activateItemAction(db, {
      actionId: action.id,
      guildId: "1",
      actorId: "101",
    });
    assert.equal(result.status, "resolved");
    assert.equal(getMarriage(db, "1", 1), null);
    assert.equal(getInventory(db, "1", "101").length, 0);
  } finally {
    db.close();
  }
});

test("Alchemist confirmation consumes exact entries once and awards one item", () => {
  const db = openCatalog(":memory:");
  try {
    const grant = (id) => addItemToInventory(db, "1", "101", id).item.id;
    const source = grant("alchemist");
    const common = getItemsInTier("common")[0].id;
    const costs = [grant(common), grant(common), grant(common)];
    const action = createItemAction(db, {
      guildId: "1",
      actorId: "101",
      channelId: "10",
      inventoryId: source,
      selections: { inventoryIds: costs },
      now: 1000,
    });
    assert.equal(getInventory(db, "1", "101").length, 4);
    const result = activateItemAction(db, {
      actionId: action.id,
      guildId: "1",
      actorId: "101",
      now: 1001,
      random: () => 0,
    });
    assert.equal(result.status, "resolved");
    const inventory = getInventory(db, "1", "101", 1001);
    assert.equal(inventory.length, 1);
    assert.equal(costs.includes(inventory[0].id), false);
    activateItemAction(db, {
      actionId: action.id,
      guildId: "1",
      actorId: "101",
      now: 1002,
      random: () => {
        throw Error("reroll");
      },
    });
    assert.deepEqual(getInventory(db, "1", "101", 1002), inventory);
  } finally {
    db.close();
  }
});
