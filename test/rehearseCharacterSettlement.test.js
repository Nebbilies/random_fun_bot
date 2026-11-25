import assert from "node:assert/strict";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { initializeLegacyCatalog } from "../lib/catalogDb.js";
import { addItemToInventory } from "../lib/itemStorage.js";
import { createItemAction } from "../lib/itemActions.js";
import { revealVaultReward } from "../lib/vaultRewards.js";
import { getResolvedItemDefinition, ITEM_TIERS } from "../lib/itemRoster.js";

const script = fileURLToPath(
  new URL("../scripts/rehearseCharacterSettlement.js", import.meta.url),
);
const secret = "PRIVATE_SYNTHETIC_CHARACTER_NAME_NOT_FOR_REPORTS";
function directory(t) {
  const dir = mkdtempSync(join(tmpdir(), "test-settlement-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function fixture(t, setup = () => {}) {
  const path = join(directory(t), "working.sqlite");
  const db = new DatabaseSync(path);
  try {
    initializeLegacyCatalog(db);
    db.prepare(
      "INSERT INTO characters(id,rank,favourites,name_full) VALUES(1,1,1,?)",
    ).run(secret);
    db.exec(`INSERT INTO character_rolls(guild_id,channel_id,command_message_id,character_id,character_name,state,published_at)
      VALUES('1','10','historic',1,'Historical','closed',100)`);
    setup(db);
  } finally {
    db.close();
  }
  return path;
}
function snapshot(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return JSON.stringify({
      version: db.prepare("PRAGMA user_version").get().user_version,
      schema: db.prepare("SELECT * FROM sqlite_schema ORDER BY name").all(),
      rows: db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name",
        )
        .all()
        .map(({ name }) => [
          name,
          db
            .prepare(
              `SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`,
            )
            .all(),
        ]),
    });
  } finally {
    db.close();
  }
}
function run(args, cwd) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}
function rehearse(t, path, { relative = false } = {}) {
  const before = readFileSync(path),
    rows = snapshot(path);
  const result = run(
    ["--database", relative ? basename(path) : path],
    dirname(path),
  );
  assert.deepEqual(readFileSync(path), before, "source bytes unchanged");
  assert.equal(snapshot(path), rows, "source schema and rows unchanged");
  const report = JSON.parse(result.stdout);
  assert.ok(report.clonePath);
  assert.notEqual(report.clonePath, path);
  assert.match(
    basename(dirname(report.clonePath)),
    /^catalog-settlement-rehearsal-/,
  );
  t.after(() =>
    rmSync(dirname(report.clonePath), { recursive: true, force: true }),
  );
  assert.ok(
    readFileSync(report.clonePath).length,
    "clone preserved after process exit",
  );
  assert.equal(report.blockerCount, report.blockers.length);
  assert.equal(report.version, 10);
  assert.match(
    report.acknowledgementScope,
    /NOT verification of an actual production backup restore/,
  );
  assert.ok(
    !result.stdout.includes(secret),
    "inventory does not dump character data",
  );
  assert.ok(
    !Object.hasOwn(report, "identities"),
    "huge identity arrays omitted",
  );
  return { result, report };
}

test("real CLI accepts explicit relative offline file; terminal/no-work rehearsal succeeds without conversion", (t) => {
  const path = fixture(t);
  const { result, report } = rehearse(t, path, { relative: true });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(report.blockers, []);
  assert.deepEqual(report.settlement.canceledActions, []);
  assert.equal(snapshot(report.clonePath), snapshot(path));
});

test("real CLI settles a safe confirmation only on its generated clone", (t) => {
  let actionId;
  const path = fixture(t, (db) => {
    const item = addItemToInventory(db, "1", "303", "alchemist").item;
    actionId = createItemAction(db, {
      guildId: "1",
      actorId: "303",
      channelId: "10",
      inventoryId: item.id,
      now: 100,
    }).id;
  });
  const { result, report } = rehearse(t, path);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(report.settlement.canceledActions, [actionId]);
  const db = new DatabaseSync(report.clonePath, { readOnly: true });
  try {
    assert.equal(
      db.prepare("SELECT state FROM item_actions WHERE id=?").get(actionId)
        .state,
      "canceled",
    );
  } finally {
    db.close();
  }
});

test("malformed overflow fails actionably, retains clone and rolls back settlement", (t) => {
  const path = fixture(t, (db) => {
    for (let i = 0; i < 5; i++)
      addItemToInventory(db, "1", "404", "hostage_note");
    const outcome = JSON.stringify({
      tier: "rare",
      item: { id: "hostage_note", maxCharges: 1 },
    });
    db.prepare(
      `INSERT INTO vault_rewards(vault_id,guild_id,user_id,channel_id,original_json,reward_json,state,result,created_at,deadline)
      VALUES('full','1','404','10',?,?,'overflow','won',100,200)`,
    ).run(outcome, outcome);
  });
  const { result, report } = rehearse(t, path);
  assert.equal(result.status, 1);
  assert.match(
    report.blockers.join("\n"),
    /Invalid retained vault_rewards overflow/,
  );
  assert.equal(report.settlement, null);
  assert.ok(result.stderr.includes(report.clonePath));
  assert.match(result.stderr, /reconcile/);
  assert.equal(
    snapshot(report.clonePath),
    snapshot(path),
    "failed clone settlement rolled back",
  );
});

test("valid overflow remains pending and byte-preserved in full inventory on clone", (t) => {
  const path = fixture(t, (db) => {
    for (let i = 0; i < 5; i++)
      addItemToInventory(db, "1", "404", "hostage_note");
    const item = getResolvedItemDefinition(db, "1", "hourglass_of_haste");
    revealVaultReward(db, {
      vaultId: "full-valid",
      guildId: "1",
      userId: "404",
      channelId: "10",
      sourceMessageId: "100",
      outcome: { tier: "common", tierData: ITEM_TIERS.common, item },
      now: 100,
    });
    assert.equal(
      db.prepare("SELECT state FROM vault_rewards").get().state,
      "overflow",
    );
  });
  const { result, report } = rehearse(t, path);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(report.settlement.retainedOverflow, ["full-valid"]);
  assert.deepEqual(report.settlement.deliveredVaults, []);
  assert.equal(snapshot(report.clonePath), snapshot(path));
});

test("all inventory blockers are retained without dumping large identity arrays or row contents", (t) => {
  const path = fixture(t, (db) => {
    db.exec(`CREATE TABLE unreviewed(character_id INTEGER, private_json TEXT);
      INSERT INTO unreviewed VALUES(999,'{"private":"not for reports"}')`);
  });
  const { result, report } = rehearse(t, path);
  assert.equal(result.status, 1);
  assert.equal(report.settlement, null);
  assert.ok(
    report.blockers.some((message) =>
      /Unsupported legacy v10 schema/.test(message),
    ),
  );
  assert.ok(
    report.blockers.some((message) =>
      /Unclassified reference unreviewed.character_id/.test(message),
    ),
  );
  assert.ok(
    report.blockers.some((message) =>
      /Unclassified JSON unreviewed.private_json/.test(message),
    ),
  );
  assert.ok(!result.stdout.includes("not for reports"));
});

test("older version is refused without automatic normalization, preserving source and clone", (t) => {
  const path = fixture(t, (db) => db.exec("PRAGMA user_version=9"));
  const before = readFileSync(path),
    rows = snapshot(path);
  const result = run(["--database", path]);
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  t.after(() =>
    rmSync(dirname(report.clonePath), { recursive: true, force: true }),
  );
  assert.equal(report.version, 9);
  assert.match(report.blockers.join("\n"), /expected current legacy schema 10/);
  assert.deepEqual(readFileSync(path), before);
  assert.equal(snapshot(path), rows);
  assert.equal(snapshot(report.clonePath), rows);
});

test("strict arguments and help never open a default file or create a clone", (t) => {
  const cwd = directory(t);
  for (const args of [
    [],
    ["working.sqlite"],
    ["--database"],
    ["--database", ""],
    ["--database=working.sqlite"],
    ["--database", "working.sqlite", "--database", "other.sqlite"],
    ["--database", "working.sqlite", "--commit"],
    ["--help", "--database", "working.sqlite"],
    ["--unknown"],
  ]) {
    const result = run(args, cwd);
    assert.equal(result.status, 1, JSON.stringify(args));
    assert.match(result.stderr, /--database PATH/);
    assert.equal(result.stdout, "");
  }
  for (const flag of ["--help", "-h"]) {
    const result = run([flag], cwd);
    assert.equal(result.status, 0);
    assert.match(
      result.stdout,
      /NOT verify an actual production backup restore/,
    );
  }
  assert.deepEqual(readdirSync(cwd), []);
});

test("invalid files, default/live basenames, and hardlinked aliases are refused before cloning", (t) => {
  const cwd = directory(t);
  const live = join(cwd, "bot.sqlite");
  writeFileSync(live, "synthetic only");
  const upper = join(cwd, "BOT.SQLITE");
  mkdirSync(join(cwd, "folder"));
  const hardlink = join(cwd, "hardlink.sqlite");
  const path = fixture(t);
  linkSync(path, hardlink);
  const before = readFileSync(path);
  for (const refused of [
    live,
    upper,
    hardlink,
    path,
    join(cwd, "folder"),
    join(cwd, "missing.sqlite"),
  ]) {
    const result = run(["--database", refused], cwd);
    assert.equal(result.status, 1, refused);
    assert.equal(result.stdout, "", "no generated clone on path refusal");
    assert.match(result.stderr, /Refusing|regular file|ENOENT/);
  }
  assert.deepEqual(readFileSync(path), before);
  assert.equal(readFileSync(live, "utf8"), "synthetic only");
});

test("symlink aliases and symlinked parent directories are refused", (t) => {
  const cwd = directory(t),
    path = fixture(t);
  const live = join(cwd, "bot.sqlite");
  writeFileSync(live, "synthetic only");
  const alias = join(cwd, "alias.sqlite"),
    liveAlias = join(cwd, "live-alias.sqlite");
  try {
    symlinkSync(path, alias, "file");
    symlinkSync(live, liveAlias, "file");
    symlinkSync(
      dirname(path),
      join(cwd, "parent"),
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    if (["EPERM", "EACCES", "ENOSYS"].includes(error.code)) {
      t.skip("Creating symlinks requires platform permission");
      return;
    }
    throw error;
  }
  const before = readFileSync(path);
  for (const refused of [
    alias,
    liveAlias,
    join(cwd, "parent", basename(path)),
  ]) {
    const result = run(["--database", refused]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Refusing symlink/);
  }
  assert.deepEqual(readFileSync(path), before);
});

test("non-SQLite input fails with retained clone path and never changes input bytes", (t) => {
  const path = join(directory(t), "invalid.sqlite");
  writeFileSync(path, "not a sqlite database");
  const before = readFileSync(path);
  const result = run(["--database", path]);
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.ok(report.clonePath);
  t.after(() =>
    rmSync(dirname(report.clonePath), { recursive: true, force: true }),
  );
  assert.ok(result.stderr.includes(report.clonePath));
  assert.ok(report.blockerCount > 0);
  assert.deepEqual(readFileSync(path), before);
});
