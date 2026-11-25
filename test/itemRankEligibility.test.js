import test from "node:test";
import assert from "node:assert/strict";
import { openCatalog } from "../lib/catalogDb.js";
import { reserveRoll } from "../lib/characterRolls.js";
import { addActiveBuff } from "../lib/itemStorage.js";
import { getGameConfig } from "../lib/gameConfig.js";
import { useWishUponAStar } from "../lib/itemEffects.js";
test("rank-only item defaults use 1500 and Clover excludes high-favourite rank 1501", () => {
  const db = openCatalog(":memory:");
  try {
    const config = getGameConfig(db, "1");
    for (const id of ["four_leaf_clover", "pinata", "rolling_fever"])
      assert.equal(config.itemEffects[id].maxRank, 1500);
    db.exec(
      "INSERT INTO characters(id,rank,favourites,name_full,gender) VALUES(1,1500,0,'Boundary','Female'),(2,1501,99999,'Outside','Female')",
    );
    addActiveBuff(
      db,
      "1",
      "2",
      "four_leaf_clover",
      JSON.stringify({ maxRank: 1500 }),
      null,
      5,
    );
    const result = reserveRoll(db, {
      guildId: "1",
      channelId: "3",
      commandMessageId: "4",
      userId: "2",
      pool: "w",
      now: 1000,
      random: () => 0.999,
    });
    assert.equal(result.character.id, 1);
  } finally {
    db.close();
  }
});

test("server Piñata includes rank 1500 and leaves its personal claim token intact", () => {
  const db = openCatalog(":memory:");
  try {
    db.exec(
      "INSERT INTO characters(id,rank,favourites,name_full,gender) VALUES(1,1500,0,'Boundary','Female'),(2,1501,99999,'Outside','Female')",
    );
    addActiveBuff(
      db,
      "1",
      "",
      "pinata",
      JSON.stringify({ maxRank: 1500 }),
      null,
      10,
    );
    addActiveBuff(
      db,
      "1",
      "2",
      "pinata_claim_token",
      JSON.stringify({ claimTokens: 1 }),
      null,
      1,
    );
    const result = reserveRoll(db, {
      guildId: "1",
      channelId: "3",
      commandMessageId: "4",
      userId: "2",
      pool: "w",
      now: 1000,
      random: () => 0.999,
    });
    assert.equal(result.character.id, 1);
    assert.equal(
      db
        .prepare(
          "SELECT remaining_rolls FROM active_user_buffs WHERE buff_id='pinata'",
        )
        .get().remaining_rolls,
      9,
    );
    assert.equal(
      db
        .prepare(
          "SELECT remaining_rolls FROM active_user_buffs WHERE buff_id='pinata_claim_token'",
        )
        .get().remaining_rolls,
      1,
    );
  } finally {
    db.close();
  }
});

for (const rank of [1500, 1501])
  test(`Rolling Fever refund is inclusive at 1500: rank ${rank}`, () => {
    const db = openCatalog(":memory:");
    try {
      db.prepare(
        "INSERT INTO characters(id,rank,favourites,name_full,gender) VALUES(1,?,99999,'Example','Female')",
      ).run(rank);
      db.exec("INSERT INTO roll_allowances VALUES('1','2',0,3)");
      addActiveBuff(
        db,
        "1",
        "2",
        "rolling_fever",
        JSON.stringify({ maxRank: 1500, refundRolls: 2 }),
        null,
        10,
      );
      reserveRoll(db, {
        guildId: "1",
        channelId: "3",
        commandMessageId: "4",
        userId: "2",
        pool: "w",
        now: 1000,
        random: () => 0.5,
      });
      assert.equal(
        db.prepare("SELECT used FROM roll_allowances").get().used,
        rank === 1500 ? 2 : 4,
      );
      assert.equal(
        db.prepare("SELECT remaining_rolls FROM active_user_buffs").get()
          .remaining_rolls,
        9,
      );
    } finally {
      db.close();
    }
  });

test("Wish Upon A Star selects by gameplay rank when favourites disagree", () => {
  const db = openCatalog(":memory:");
  try {
    db.exec(`INSERT INTO franchises(id,display_name,created_at) VALUES(1,'Series','test');
      INSERT INTO franchise_anime(franchise_id,anime_id) VALUES(1,1);
      INSERT INTO characters(id,rank,favourites,name_full) VALUES(1,1,0,'Best'),(2,2,1,'Second'),(3,3,2,'Third'),(4,4,99999,'Popular');
      INSERT INTO character_anime VALUES(1,1),(2,1),(3,1),(4,1)`);
    const result = useWishUponAStar(db, "1", "2", "Series", () => 0);
    assert.equal(result.character.id, 1);
  } finally {
    db.close();
  }
});
