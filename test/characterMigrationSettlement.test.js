import assert from "node:assert/strict";
import { test } from "node:test";
import { openCatalog } from "../lib/catalogDb.js";
import { addItemToInventory } from "../lib/itemStorage.js";
import {
  createItemAction,
  activateItemAction,
  confirmHostageDelivery,
} from "../lib/itemActions.js";
import { marryCharacter } from "../lib/characterMarriage.js";
import {
  settleCharacterMigration,
  CharacterMigrationSettlementError,
} from "../lib/characterMigrationSettlement.js";
import {
  inventoryCharacterIdentities,
  migrateCharacterIdentities,
} from "../lib/characterIdentityMigration.js";

const options = { offline: true, backupVerified: true, now: 10_000 };
const rows = (db, table) =>
  db
    .prepare(`SELECT * FROM ${table} ORDER BY rowid`)
    .all()
    .map((row) => ({ ...row }));
function snapshot(db) {
  return db
    .prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")
    .all()
    .map(({ name }) => [name, rows(db, `"${name}"`)]);
}
function fixture(t) {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  return db;
}
function hostage(db) {
  const choices = [];
  for (const [id, rank, owner] of [
    [1, 100, "101"],
    [2, 200, "202"],
    [3, 300, "202"],
  ]) {
    db.prepare(
      "INSERT INTO characters(id,rank,favourites,name_full) VALUES(?,?,1,?)",
    ).run(id, rank, `Character ${id}`);
    const marriage = marryCharacter(db, "1", id, owner, 100).marriage;
    choices.push({ characterId: id, marriageId: marriage.id, ownerId: owner });
  }
  db.prepare("INSERT INTO counterfeit_crowns VALUES(?,?,?,?,?)").run(
    "1",
    "202",
    3,
    choices[2].marriageId,
    "generation",
  );
  const item = addItemToInventory(db, "1", "101", "hostage_note").item;
  const action = createItemAction(db, {
    guildId: "1",
    actorId: "101",
    channelId: "10",
    inventoryId: item.id,
    selections: { own: choices[0], targets: [choices[1]] },
    now: 100,
  });
  assert.equal(
    activateItemAction(db, {
      actionId: action.id,
      guildId: "1",
      actorId: "101",
      now: 101,
    }).status,
    "awaiting_delivery",
  );
  return { action, item };
}
function confirming(db) {
  const item = addItemToInventory(db, "1", "303", "alchemist").item;
  return createItemAction(db, {
    guildId: "1",
    actorId: "303",
    channelId: "10",
    inventoryId: item.id,
    now: 100,
  });
}
function vault(
  db,
  { id = "v", state = "decision", item = "hostage_note", result = null } = {},
) {
  const outcome = JSON.stringify({
    tier: "rare",
    item: { id: item, maxCharges: 1 },
    captured: "do not reroll",
  });
  db.prepare(
    `INSERT INTO vault_rewards(vault_id,guild_id,user_id,channel_id,original_json,reward_json,state,result,created_at,deadline)
    VALUES(?,'1','404','10',?,?,?,?,100,200)`,
  ).run(id, outcome, state === "overflow" ? outcome : null, state, result);
  return outcome;
}

function expiredRoll(db) {
  db.exec(`INSERT OR IGNORE INTO character_identities(id,name_full) VALUES(50,'Retained character');
    INSERT INTO character_rolls(guild_id,channel_id,command_message_id,message_id,character_id,character_name,state,published_at,expires_at)
    VALUES('1','10','500','501',50,'Published name','open',100,10000)`);
  return Number(db.prepare("SELECT last_insert_rowid() AS id").get().id);
}

test("ordinary expiry closes only state, preserving counts, history and spent costs; retry is inert", (t) => {
  const db = fixture(t);
  const id = expiredRoll(db);
  db.exec(`INSERT INTO roll_allowances(guild_id,user_id,period,used) VALUES('1','101',7,4);
    INSERT INTO claim_allowances(guild_id,user_id,period) VALUES('1','101',7);
    INSERT INTO active_user_buffs(guild_id,user_id,buff_id,data_json,expires_at,remaining_rolls)
      VALUES('1','101','synthetic','{"spent":true}',20000,2);
    INSERT INTO roll_notices(roll_id,user_id) VALUES(${id},'101')`);
  addItemToInventory(db, "1", "101", "hostage_note");
  const before = snapshot(db);
  const original = rows(db, "character_rolls")[0];
  const report = settleCharacterMigration(db, options); // exact expires_at === now
  assert.deepEqual(report.closedExpiredRolls, [id]);
  assert.equal(report.refundedConsumedCosts, 0);
  assert.deepEqual(rows(db, "character_rolls"), [
    { ...original, state: "closed" },
  ]);
  assert.deepEqual(
    snapshot(db).filter(([name]) => name !== "character_rolls"),
    before.filter(([name]) => name !== "character_rolls"),
  );
  const after = snapshot(db);
  assert.deepEqual(
    settleCharacterMigration(db, options).closedExpiredRolls,
    [],
  );
  assert.deepEqual(snapshot(db), after);
});

test("legacy live catalog reference is sufficient without a retained snapshot", (t) => {
  const db = fixture(t);
  const id = expiredRoll(db);
  db.exec(`DELETE FROM character_identities WHERE id=50;
    INSERT INTO characters(id,rank,favourites,name_full) VALUES(50,1,1,'Current renamed character')`);
  assert.deepEqual(settleCharacterMigration(db, options).closedExpiredRolls, [
    id,
  ]);
});

test("unsafe SQLite integer fails closed and rolls back without coercion", (t) => {
  const db = fixture(t);
  confirming(db);
  expiredRoll(db);
  db.exec("UPDATE character_rolls SET expires_at=9007199254740992");
  const readExact = () => {
    const statement = db.prepare("SELECT * FROM character_rolls");
    statement.setReadBigInts(true);
    return statement.all();
  };
  const before = readExact();
  const actions = rows(db, "item_actions");
  assert.throws(() => settleCharacterMigration(db, options), /too large/);
  assert.deepEqual(readExact(), before);
  assert.deepEqual(rows(db, "item_actions"), actions);
  assert.equal(db.isTransaction, false);
});

test("captured ordinary rules validate without live defaults; retained identity needs no live catalog row", (t) => {
  const db = fixture(t);
  const id = expiredRoll(db);
  db.prepare(
    "UPDATE character_rolls SET rules_json=?,expires_at=9999 WHERE id=?",
  ).run(
    JSON.stringify({
      claimMs: 9899,
      escapeProtectionMs: 1,
      escapeClaimMs: 2,
      reportMs: 3,
    }),
    id,
  );
  assert.deepEqual(settleCharacterMigration(db, options).closedExpiredRolls, [
    id,
  ]);
});

for (const change of [
  "state='pending'",
  "state='unknown'",
  "expires_at=10001",
  "published_at=10001,expires_at=10002",
  "published_at=NULL",
  "published_at=0",
  "published_at=-1",
  "published_at=1.5",
  "expires_at=NULL",
  "expires_at=0",
  "expires_at=100",
  "expires_at=99",
  "expires_at=9999.5",
  "published_at=1e100",
  "guild_id=''",
  "channel_id='bad'",
  "command_message_id=''",
  "command_message_id='siren:synthetic'",
  "message_id=NULL",
  "message_id='bad'",
  "character_id=0",
  "character_id=999",
  "character_name=''",
  "character_name='   '",
  "mystery_session_id=1",
  "exclusive_user_id='101'",
  "escape_marriage_id=1",
  "escape_marriage_id=0",
  "escape_owner_id='101'",
  "escape_owner_id=''",
  "protected_until=0",
  "escape_outcome='escaped'",
  "escape_winner_id='101'",
  "escape_resolved_at=0",
  "rules_json='not json'",
  "rules_json='null'",
  `rules_json='{"claimMs":9900}'`,
  `rules_json='{"claimMs":9901,"escapeProtectionMs":1,"escapeClaimMs":2,"reportMs":3}'`,
])
  test(`unproven expiry blocks all settlement and preserves rolls: ${change}`, (t) => {
    const db = fixture(t);
    confirming(db);
    const id = expiredRoll(db);
    db.exec(`UPDATE character_rolls SET ${change} WHERE id=${id}`);
    // A second, independently verified expiry must not close either.
    db.exec(`INSERT INTO character_rolls(guild_id,channel_id,command_message_id,message_id,character_id,character_name,state,published_at,expires_at)
    VALUES('1','10','600','601',50,'Captured','open',100,9999)`);
    const before = snapshot(db);
    assert.throws(
      () => settleCharacterMigration(db, options),
      CharacterMigrationSettlementError,
    );
    assert.deepEqual(snapshot(db), before);
  });

test("even terminal mystery reverse binding blocks ordinary expiry", (t) => {
  const db = fixture(t);
  const id = expiredRoll(db);
  db.prepare(
    `INSERT INTO mystery_sessions(guild_id,origin_roll_id,event_id,character_id,rank_snapshot,state,roller_id,event_channel_id,started_at,deadline_at)
    VALUES('1',?,'doors',50,50,'completed','101','10',100,200)`,
  ).run(id);
  const before = snapshot(db);
  assert.throws(
    () => settleCharacterMigration(db, options),
    CharacterMigrationSettlementError,
  );
  assert.deepEqual(snapshot(db), before);
});

test("non-authoritative optional snapshot schema rejects before settlement", (t) => {
  const db = fixture(t);
  const id = expiredRoll(db);
  db.exec(
    "ALTER TABLE character_rolls ADD COLUMN character_snapshot_json TEXT",
  );
  const captured = {
    version: 1,
    id: 50,
    rank: 1,
    favourites: 0,
    likes_source: "anilist",
    name_full: "Published name",
    image_url: null,
    anime_titles: null,
    gender: null,
    tag_name: null,
  };
  for (const value of [
    "bad JSON",
    "null",
    JSON.stringify({ ...captured, id: 51 }),
    JSON.stringify({ ...captured, name_full: "Mismatch" }),
    JSON.stringify({ ...captured, version: 2 }),
  ]) {
    db.prepare(
      "UPDATE character_rolls SET character_snapshot_json=? WHERE id=?",
    ).run(value, id);
    const before = snapshot(db);
    assert.throws(
      () => settleCharacterMigration(db, options),
      /Unsupported legacy v10 schema/,
    );
    assert.deepEqual(snapshot(db), before);
  }
  db.prepare(
    "UPDATE character_rolls SET character_snapshot_json=? WHERE id=?",
  ).run(JSON.stringify(captured), id);
  const original = rows(db, "character_rolls")[0];
  assert.throws(
    () => settleCharacterMigration(db, options),
    /Unsupported legacy v10 schema/,
  );
  assert.deepEqual(rows(db, "character_rolls"), [original]);
});

test("settled maintenance history passes UUID preflight and converts without losing escrow evidence", (t) => {
  const db = fixture(t);
  const { action } = hostage(db);
  confirming(db);
  assert.equal(
    db
      .prepare("SELECT 1 FROM sqlite_schema WHERE name='affection_schema'")
      .get(),
    undefined,
  );
  const selections = JSON.parse(
    db
      .prepare("SELECT selections_json FROM item_actions WHERE id=?")
      .get(action.id).selections_json,
  );
  assert.equal(Object.hasOwn(selections, "_affectionItemUse"), false);
  settleCharacterMigration(db, options);
  assert.deepEqual(inventoryCharacterIdentities(db).blockers, []);
  const before = db
    .prepare("SELECT result_json FROM item_actions WHERE id=?")
    .get(action.id).result_json;
  migrateCharacterIdentities(db, { dryRun: false, targetVersion: 11 });
  const row = db
    .prepare("SELECT selections_json,result_json FROM item_actions WHERE id=?")
    .get(action.id);
  assert.equal(
    typeof JSON.parse(row.selections_json).own.characterId,
    "string",
  );
  assert.equal(row.result_json, before);
  assert.equal(JSON.parse(row.result_json).releasedEscrow.length, 1);
});

test("explicit acknowledgements, current schema and transaction ownership are required", (t) => {
  const db = fixture(t);
  const before = snapshot(db);
  assert.throws(() => settleCharacterMigration(db), /acknowledgements/);
  assert.throws(
    () => settleCharacterMigration(db, { ...options, now: NaN }),
    /time/,
  );
  db.exec("BEGIN");
  assert.throws(() => settleCharacterMigration(db, options), /transaction/i);
  db.exec("ROLLBACK"); // Caller transaction was not rolled back by the service.
  assert.deepEqual(snapshot(db), before);
  db.exec("PRAGMA user_version=9");
  assert.throws(
    () => settleCharacterMigration(db, options),
    /expected current legacy schema 10/,
  );
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 9);
});

test("undelivered escrow releases without duplicate refund even at capacity; Crown and relationships survive", (t) => {
  const db = fixture(t);
  const { action, item } = hostage(db);
  const confirmation = confirming(db);
  for (let i = 0; i < 4; i++)
    addItemToInventory(db, "1", "101", "hostage_note");
  const inventory = rows(db, "user_inventory");
  const marriages = rows(db, "marriages");
  db.exec(
    "INSERT INTO character_wishes(guild_id,user_id,character_id,created_at) VALUES('1','101',3,100)",
  );
  const wishes = rows(db, "character_wishes");
  const original = db
    .prepare("SELECT * FROM item_actions WHERE id=?")
    .get(action.id);
  const report = settleCharacterMigration(db, options);
  assert.deepEqual(
    new Set(report.canceledActions),
    new Set([action.id, confirmation.id]),
  );
  assert.deepEqual(report.releasedEscrow, [item.id, confirmation.inventory_id]);
  assert.equal(report.refundedConsumedCosts, 0);
  assert.deepEqual(rows(db, "user_inventory"), inventory);
  assert.deepEqual(rows(db, "marriages"), marriages);
  assert.deepEqual(rows(db, "character_wishes"), wishes);
  assert.equal(rows(db, "item_character_reservations").length, 0);
  assert.equal(rows(db, "item_action_costs").length, 0);
  assert.equal(rows(db, "counterfeit_crowns")[0].generation_id, "generation");
  const canceled = db
    .prepare("SELECT * FROM item_actions WHERE id=?")
    .get(action.id);
  assert.equal(canceled.state, "canceled");
  assert.equal(canceled.delivery_pending, 0);
  assert.equal(canceled.selections_json, original.selections_json);
  assert.equal(canceled.crown_json, original.crown_json);
  const result = JSON.parse(canceled.result_json);
  assert.equal(result.canceledBy, "uuid_maintenance");
  assert.deepEqual(JSON.parse(result.releasedEscrow[0].snapshotJson), {
    ...item,
  });
  const after = snapshot(db);
  assert.deepEqual(settleCharacterMigration(db, options).canceledActions, []);
  assert.deepEqual(snapshot(db), after);
});

test("delivered Hostage lacks refund journal and blocks other safe cancellations", (t) => {
  const db = fixture(t);
  const { action } = hostage(db);
  const confirmation = confirming(db);
  assert.equal(confirmHostageDelivery(db, action.id, "999", 200), true);
  const selections = JSON.parse(
    db
      .prepare("SELECT selections_json FROM item_actions WHERE id=?")
      .get(action.id).selections_json,
  );
  assert.equal(Object.hasOwn(selections, "_affectionItemUse"), false);
  assert.equal(Object.hasOwn(selections, "_affectionPayment"), false);
  assert.deepEqual(
    rows(db, "item_action_costs").map((row) => row.action_id),
    [confirmation.id],
  );
  const before = snapshot(db);
  assert.throws(
    () => settleCharacterMigration(db, options),
    (error) =>
      error instanceof CharacterMigrationSettlementError &&
      /delivered Hostage.*exact refund unsupported/.test(error.message),
  );
  assert.deepEqual(snapshot(db), before);
});

for (const change of [
  "UPDATE user_inventory SET charges=charges+1 WHERE user_id='101'",
  "DELETE FROM item_action_costs",
  "DELETE FROM item_character_reservations WHERE character_id=3",
  "UPDATE marriages SET owner_id='changed' WHERE character_id=3",
  "UPDATE item_action_costs SET snapshot_json='not json'",
  "INSERT INTO counterfeit_crowns VALUES('1','202',2,2,'new-generation')",
  "UPDATE item_actions SET state='unknown'",
  "UPDATE item_actions SET kind='unknown'",
])
  test(`unsafe Hostage rejected without mutation: ${change}`, (t) => {
    const db = fixture(t);
    hostage(db);
    db.exec(change);
    const before = snapshot(db);
    assert.throws(
      () => settleCharacterMigration(db, options),
      CharacterMigrationSettlementError,
    );
    assert.deepEqual(snapshot(db), before);
  });

test("orphan and terminal escrow/reservations block rather than deleting evidence", (t) => {
  const db = fixture(t);
  const { action } = hostage(db);
  db.prepare("UPDATE item_actions SET state='canceled' WHERE id=?").run(
    action.id,
  );
  const before = snapshot(db);
  assert.throws(
    () => settleCharacterMigration(db, options),
    /terminal action retains/,
  );
  assert.deepEqual(snapshot(db), before);
  // Deliberately corrupt a disposable fixture; the new provenance FK prevents
  // this orphan through an ordinary writable connection.
  db.exec("PRAGMA foreign_keys=OFF");
  db.prepare("DELETE FROM item_actions WHERE id=?").run(action.id);
  const orphaned = snapshot(db);
  assert.throws(
    () => settleCharacterMigration(db, options),
    /Orphan escrow\/reservation/,
  );
  assert.deepEqual(snapshot(db), orphaned);
});

for (const [state, command] of [
  ["pending", "normal"],
  ["open", "normal"],
  ["pending", "siren:synthetic"],
]) {
  test(`live ${state} ${command} roll blocks without inferring allowance/buff/Siren refunds`, (t) => {
    const db = fixture(t);
    confirming(db);
    db.prepare(
      `INSERT INTO character_rolls(guild_id,channel_id,command_message_id,character_id,character_name,state,published_at)
      VALUES('1','10',?,1,'Captured',?,100)`,
    ).run(command, state);
    const before = snapshot(db);
    assert.throws(
      () => settleCharacterMigration(db, options),
      /missing exact allowance\/buff\/Siren cost provenance/,
    );
    assert.deepEqual(snapshot(db), before);
  });
}

test("live mystery blocks even with a closed origin roll", (t) => {
  const db = fixture(t);
  db.exec(`INSERT INTO character_rolls(guild_id,channel_id,command_message_id,character_id,character_name,state,published_at)
    VALUES('1','10','normal',1,'Captured','closed',100);
    INSERT INTO mystery_sessions(guild_id,origin_roll_id,event_id,character_id,rank_snapshot,state,roller_id,event_channel_id,started_at,deadline_at)
    VALUES('1',1,'doors',1,50,'running','101','10',100,200)`);
  const before = snapshot(db);
  assert.throws(
    () => settleCharacterMigration(db, options),
    /origin roll refund provenance unavailable/,
  );
  assert.deepEqual(snapshot(db), before);
});

test("vault Keep and determined overflow preserve outcomes without gambling or duplicate delivery", (t) => {
  const db = fixture(t);
  const original = vault(db);
  vault(db, { id: "won", state: "overflow", result: "won" });
  assert.deepEqual(settleCharacterMigration(db, options).deliveredVaults, [
    "v",
    "won",
  ]);
  assert.equal(rows(db, "user_inventory").length, 2);
  const rewards = rows(db, "vault_rewards");
  assert.equal(rewards[0].original_json, original);
  assert.equal(rewards[0].reward_json, original);
  assert.equal(rewards[0].result, "kept");
  assert.equal(rewards[1].result, "won");
  assert.ok(
    rewards.every(
      (row) => row.state === "delivered" && row.delivered_at === null,
    ),
  );
  const before = snapshot(db);
  settleCharacterMigration(db, options);
  assert.deepEqual(snapshot(db), before);
});

test("full vault inventory rolls back earlier cancellation, Crown restoration, roll expiry and reward delivery", (t) => {
  const db = fixture(t);
  hostage(db);
  expiredRoll(db);
  for (let i = 0; i < 4; i++)
    addItemToInventory(db, "1", "404", "hostage_note");
  vault(db, { id: "first" });
  vault(db, { id: "second", state: "overflow", result: "won" });
  const before = snapshot(db);
  assert.throws(() => settleCharacterMigration(db, options), /inventory full/);
  assert.deepEqual(snapshot(db), before);
});

test("late SQL failure rolls back all durable settlement; retry succeeds", (t) => {
  const db = fixture(t);
  hostage(db);
  expiredRoll(db);
  vault(db);
  db.exec(
    "CREATE TRIGGER reject_vault BEFORE UPDATE ON vault_rewards BEGIN SELECT RAISE(ABORT,'injected settlement failure'); END",
  );
  const before = snapshot(db);
  assert.throws(
    () => settleCharacterMigration(db, options),
    /Unsupported legacy v10 schema/,
  );
  assert.deepEqual(snapshot(db), before);
  db.exec("DROP TRIGGER reject_vault");
  assert.equal(settleCharacterMigration(db, options).canceledActions.length, 1);
});

test("terminal history and spent costs remain byte-for-byte unchanged", (t) => {
  const db = fixture(t);
  const action = confirming(db);
  db.prepare("DELETE FROM item_action_costs WHERE action_id=?").run(action.id);
  db.prepare("DELETE FROM item_use_reservations WHERE action_id=?").run(
    action.id,
  );
  db.prepare(
    "UPDATE item_actions SET state='resolved',result_json=?,delivery_pending=1 WHERE id=?",
  ).run('{"status":"resolved","message":"historic result"}', action.id);
  db.exec(`INSERT INTO character_rolls(guild_id,channel_id,command_message_id,character_id,character_name,state,published_at)
    VALUES('1','10','historic',1,'Captured','closed',100)`);
  vault(db, { state: "lost" });
  const before = snapshot(db);
  settleCharacterMigration(db, options);
  assert.deepEqual(snapshot(db), before);
});

test("unreviewed ownership-changing trigger is refused before ordinary expiry writes", (t) => {
  const db = fixture(t);
  expiredRoll(db);
  db.exec(
    "CREATE TRIGGER unexpected_owner AFTER UPDATE ON character_rolls BEGIN UPDATE marriages SET owner_id='202'; END",
  );
  const before = snapshot(db);
  assert.throws(
    () => settleCharacterMigration(db, options),
    /Unsupported legacy v10 schema/,
  );
  assert.deepEqual(snapshot(db), before);
});

test("unknown captured rule variant cannot hide alternate expiry semantics", (t) => {
  const db = fixture(t);
  const id = expiredRoll(db);
  db.prepare("UPDATE character_rolls SET rules_json=? WHERE id=?").run(
    JSON.stringify({
      claimMs: 100,
      escapeProtectionMs: 1,
      escapeClaimMs: 1,
      reportMs: 1,
      unknownVariant: { characterId: 999 },
    }),
    id,
  );
  const before = snapshot(db);
  assert.throws(
    () => settleCharacterMigration(db, options),
    CharacterMigrationSettlementError,
  );
  assert.deepEqual(snapshot(db), before);
});
