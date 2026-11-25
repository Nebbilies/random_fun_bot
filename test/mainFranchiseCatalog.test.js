import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { AFFECTION_AWARDS_DDL } from "../lib/affectionSchema.js";
import {
  openCatalog,
  openFinalCatalog,
  openFinalCatalogReadOnly,
  setMeta,
  validateCatalogForDeployment,
} from "../lib/catalogDb.js";
import {
  installEmptyFinalCatalog,
  isPreMainFranchiseCatalogSchema,
  isPreSoulmateReclaimCatalogSchema,
  validateFinalCatalogSchema,
} from "../lib/catalogFinalSchema.js";
import { characterAppearanceSourceToken } from "../lib/catalogFreshness.js";
import {
  mergeFranchises,
  publishFranchiseCatalog,
} from "../lib/franchiseCatalog.js";
import { installSeasonSchema } from "../lib/seasonSchema.js";
import { upgradeMainFranchiseCatalog } from "../lib/vaultFortuneUpgrade.js";

const first = "00000000-0000-4000-8000-000000000001";
const second = "00000000-0000-4000-8000-000000000002";

function seed(db) {
  db.exec(
    "INSERT INTO franchises(id,display_name,created_at) VALUES(1,'First series','test'),(2,'Second series','test')",
  );
  for (const [index, id] of [first, second].entries()) {
    db.prepare(
      "INSERT INTO character_identities(id,creation_method) VALUES(?,'manual')",
    ).run(id);
    db.prepare(
      "INSERT INTO characters(id,rank,favourites,tie_order,likes_source) VALUES(?,?,0,?,'generated')",
    ).run(id, index + 1, index + 1);
  }
}

const legacyColumnDDL = `ALTER TABLE characters ADD COLUMN main_franchise_id INTEGER REFERENCES franchises(id) ON DELETE SET NULL;
  CREATE INDEX characters_by_main_franchise ON characters(main_franchise_id);`;

function assignments(db) {
  return db
    .prepare(
      "SELECT character_id, franchise_id FROM character_main_franchises ORDER BY character_id, franchise_id",
    )
    .all()
    .map((row) => [row.character_id, row.franchise_id]);
}

function predecessorFile(t, { column = false, season = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "main-franchise-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "catalog.sqlite");
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA foreign_keys=ON");
    installEmptyFinalCatalog(db);
    seed(db);
    db.exec("BEGIN IMMEDIATE");
    db.exec("DROP TABLE character_main_franchises");
    if (column) {
      db.exec(legacyColumnDDL);
      db.prepare("UPDATE characters SET main_franchise_id=1 WHERE id=?").run(
        first,
      );
    }
    if (season) installSeasonSchema(db);
    db.exec("COMMIT");
    if (!column) assert.equal(isPreMainFranchiseCatalogSchema(db), true);
  } finally {
    db.close();
  }
  return path;
}

for (const season of [false, true]) {
  test(`writable startup preserves populated column assignments with season tables ${season ? "present" : "absent"}`, (t) => {
    const path = predecessorFile(t, { column: true, season });
    assert.throws(
      () => openFinalCatalogReadOnly(path),
      /main franchise schema update needed/i,
    );
    const db = openFinalCatalog(path);
    try {
      assert.deepEqual(assignments(db), [[first, 1]]);
      assert.equal(
        db
          .prepare(
            "SELECT name FROM pragma_table_info('characters') WHERE name='main_franchise_id'",
          )
          .get(),
        undefined,
      );
      db.prepare("INSERT INTO character_main_franchises VALUES (?,2)").run(
        first,
      );
    } finally {
      db.close();
    }

    const reopened = openFinalCatalogReadOnly(path);
    try {
      assert.deepEqual(assignments(reopened), [
        [first, 1],
        [first, 2],
      ]);
    } finally {
      reopened.close();
    }
  });
}

test("a fresh catalog enforces distinct main franchise pairs and clears them when either parent is deleted", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("PRAGMA foreign_keys=ON");
  installEmptyFinalCatalog(db);
  seed(db);

  assert.deepEqual(assignments(db), []);
  const insert = db.prepare(
    "INSERT INTO character_main_franchises VALUES (?,?)",
  );
  insert.run(first, 1);
  insert.run(first, 2);
  insert.run(second, 2);
  assert.deepEqual(assignments(db), [
    [first, 1],
    [first, 2],
    [second, 2],
  ]);
  assert.throws(() => insert.run(first, 2), /UNIQUE/);
  assert.throws(() => insert.run(first, 99), /FOREIGN KEY/);
  assert.throws(() => insert.run("missing", 2), /FOREIGN KEY/);
  db.exec("DELETE FROM franchises WHERE id=1");
  assert.deepEqual(assignments(db), [
    [first, 2],
    [second, 2],
  ]);
  db.prepare("DELETE FROM characters WHERE id=?").run(second);
  assert.deepEqual(assignments(db), [[first, 2]]);
  assert.equal(validateFinalCatalogSchema(db), true);
});

for (const open of [openCatalog, openFinalCatalog]) {
  test(`${open.name} upgrades the exact predecessor without backfilling or losing rows`, (t) => {
    const path = predecessorFile(t);
    assert.throws(
      () => openFinalCatalogReadOnly(path),
      /main franchise schema update needed/i,
    );
    const db = open(path);
    try {
      assert.deepEqual(assignments(db), []);
      assert.deepEqual(
        db
          .prepare("SELECT id FROM characters ORDER BY rank")
          .all()
          .map((row) => row.id),
        [first, second],
      );
      assert.deepEqual(
        db
          .prepare("SELECT id FROM franchises ORDER BY id")
          .all()
          .map((row) => row.id),
        [1, 2],
      );
      assert.equal(db.prepare("PRAGMA user_version").get().user_version, 12);
      assert.equal(
        db.prepare("SELECT version FROM season_schema").get().version,
        1,
      );
      db.exec(
        "INSERT INTO character_main_franchises SELECT id, 2 FROM characters",
      );
    } finally {
      db.close();
    }

    const reopened = open(path);
    try {
      assert.deepEqual(assignments(reopened), [
        [first, 2],
        [second, 2],
      ]);
    } finally {
      reopened.close();
    }
    const readOnly = openFinalCatalogReadOnly(path);
    try {
      assert.deepEqual(assignments(readOnly), [
        [first, 2],
        [second, 2],
      ]);
    } finally {
      readOnly.close();
    }
  });
}

test("merging a franchise moves and deduplicates main assignments on the surviving ID", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("PRAGMA foreign_keys=ON");
  installEmptyFinalCatalog(db);
  seed(db);
  db.prepare(
    "INSERT INTO character_main_franchises VALUES (?,1), (?,2), (?,1)",
  ).run(first, first, second);
  db.prepare("INSERT INTO character_franchise_memberships VALUES(?,1)").run(
    first,
  );

  mergeFranchises(db, 1, 2);

  assert.deepEqual(assignments(db), [
    [first, 2],
    [second, 2],
  ]);
  assert.equal(
    db
      .prepare(
        "SELECT franchise_id FROM character_franchise_memberships WHERE character_id=?",
      )
      .get(first).franchise_id,
    2,
  );
  assert.equal(
    db.prepare("SELECT 1 FROM franchises WHERE id=1").get(),
    undefined,
  );
  assert.equal(validateFinalCatalogSchema(db), true);
});

test("franchise publication clears a designation when it prunes the unused franchise", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("PRAGMA foreign_keys=ON");
  installEmptyFinalCatalog(db);
  seed(db);
  db.exec(
    "UPDATE franchises SET name_source='manual' WHERE id=2; INSERT INTO character_main_franchises SELECT id, rank FROM characters",
  );
  setMeta(db, "franchise_import_source_published_at", "fixture");
  setMeta(
    db,
    "franchise_import_source_token",
    characterAppearanceSourceToken(db),
  );

  publishFranchiseCatalog(db);

  assert.deepEqual(assignments(db), [[second, 2]]);
  assert.deepEqual(
    db
      .prepare("SELECT id FROM franchises")
      .all()
      .map((row) => row.id),
    [2],
  );
});

test("the deployment gate backs up legacy assignments before upgrading the column layout", async (t) => {
  const path = predecessorFile(t, { column: true, season: true });
  const backupDirectory = join(dirname(path), "backups");
  const writer = new DatabaseSync(path);
  try {
    writer
      .prepare(
        "INSERT INTO character_protection_locks VALUES('1',?,'soulbind',NULL)",
      )
      .run(first);
    writer
      .prepare("UPDATE characters SET main_franchise_id=2 WHERE id=?")
      .run(second);
  } finally {
    writer.close();
  }

  const { backupPath } = await validateCatalogForDeployment(path, {
    backupDirectory,
  });
  const backup = new DatabaseSync(backupPath, { readOnly: true });
  try {
    assert.equal(
      validateFinalCatalogSchema(backup, { mainFranchiseColumn: true }),
      true,
    );
    assert.deepEqual(
      backup
        .prepare("SELECT main_franchise_id FROM characters ORDER BY id")
        .all()
        .map((row) => row.main_franchise_id),
      [1, 2],
    );
  } finally {
    backup.close();
  }
  assert.equal(
    (await validateCatalogForDeployment(path, { backupDirectory })).backupPath,
    null,
  );

  const db = openFinalCatalogReadOnly(path);
  try {
    assert.deepEqual(assignments(db), [
      [first, 1],
      [second, 2],
    ]);
    assert.equal(
      db.prepare("SELECT protected_until FROM character_protection_locks").get()
        .protected_until,
      null,
    );
  } finally {
    db.close();
  }
});

test("the deployment gate preserves the column layout if its backup fails", async (t) => {
  const path = predecessorFile(t, { column: true });
  const backupDirectory = join(dirname(path), "blocked");
  writeFileSync(backupDirectory, "fixture");

  await assert.rejects(
    validateCatalogForDeployment(path, { backupDirectory }),
    /EEXIST|ENOTDIR/,
  );
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(
      validateFinalCatalogSchema(db, { mainFranchiseColumn: true }),
      true,
    );
    assert.equal(
      db
        .prepare("SELECT main_franchise_id FROM characters WHERE id=?")
        .get(first).main_franchise_id,
      1,
    );
  } finally {
    db.close();
  }
});

test("the deployment gate rejects a partial schema without repairing it", async (t) => {
  const path = predecessorFile(t);
  const db = new DatabaseSync(path);
  try {
    db.exec("ALTER TABLE characters ADD COLUMN main_franchise_id INTEGER");
    const schema = db
      .prepare("SELECT type,name,sql FROM sqlite_schema ORDER BY name")
      .all();
    await assert.rejects(
      validateCatalogForDeployment(path),
      /invalid final catalog schema/,
    );
    assert.deepEqual(
      db.prepare("SELECT type,name,sql FROM sqlite_schema ORDER BY name").all(),
      schema,
    );
  } finally {
    db.close();
  }
});

test("an older ranked catalog runs its existing writable upgrades while the deploy gate stays narrow", async (t) => {
  const path = predecessorFile(t);
  const writer = new DatabaseSync(path);
  try {
    const previousAwards = AFFECTION_AWARDS_DDL.replace(
      "base IN (1,5,8,10,12,20,100)",
      "base IN (1,5,10,12,20,100)",
    );
    writer.exec(`DROP TABLE affection_awards; ${previousAwards}`);
    assert.equal(isPreSoulmateReclaimCatalogSchema(writer), true);
    await assert.rejects(
      validateCatalogForDeployment(path),
      /soulmate reclaim schema update needed/i,
    );
    assert.equal(isPreSoulmateReclaimCatalogSchema(writer), true);
  } finally {
    writer.close();
  }

  const db = openFinalCatalog(path);
  try {
    assert.deepEqual(assignments(db), []);
  } finally {
    db.close();
  }
});

test("a late upgrade failure and a dry run preserve the exact predecessor", (t) => {
  const path = predecessorFile(t, { column: true });
  const db = new DatabaseSync(path);
  try {
    const rows = db.prepare("SELECT * FROM characters ORDER BY rank").all();
    assert.equal(upgradeMainFranchiseCatalog(db).committed, false);
    assert.equal(
      validateFinalCatalogSchema(db, { mainFranchiseColumn: true }),
      true,
    );
    const connection = {
      get isTransaction() {
        return db.isTransaction;
      },
      prepare: (sql) => db.prepare(sql),
      exec(sql) {
        db.exec(sql);
        if (sql.includes("DROP COLUMN main_franchise_id"))
          throw new Error("injected after main-franchise DDL");
      },
    };
    assert.throws(
      () => upgradeMainFranchiseCatalog(connection, { dryRun: false }),
      /injected after/,
    );
    assert.equal(db.isTransaction, false);
    assert.equal(
      validateFinalCatalogSchema(db, { mainFranchiseColumn: true }),
      true,
    );
    assert.deepEqual(
      db.prepare("SELECT * FROM characters ORDER BY rank").all(),
      rows,
    );

    assert.equal(
      upgradeMainFranchiseCatalog(db, { dryRun: false }).committed,
      true,
    );
    assert.deepEqual(assignments(db), [[first, 1]]);
    assert.deepEqual(
      db
        .prepare("SELECT * FROM characters ORDER BY rank")
        .all()
        .map((row) => ({ ...row })),
      rows.map(({ main_franchise_id, ...character }) => character),
    );
    assert.equal(validateFinalCatalogSchema(db), true);
  } finally {
    db.close();
  }
});

test("concurrent upgrades serialize and both see the complete assignments", async (t) => {
  const path = predecessorFile(t, { column: true });
  const gate = new SharedArrayBuffer(4);
  const module = new URL("../lib/vaultFortuneUpgrade.js", import.meta.url).href;
  const workers = Array.from(
    { length: 2 },
    () =>
      new Worker(
        `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { DatabaseSync } = await import('node:sqlite');
      const { upgradeMainFranchiseCatalog } = await import(workerData.module);
      const gate = new Int32Array(workerData.gate);
      const db = new DatabaseSync(workerData.path);
      let result;
      try {
        if (Atomics.add(gate, 0, 1) === 0) Atomics.wait(gate, 0, 1, 10000);
        else Atomics.notify(gate, 0);
        const { committed } = upgradeMainFranchiseCatalog(db, { dryRun: false });
        result = { committed, franchises: db.prepare('SELECT franchise_id FROM character_main_franchises').all().map(row => row.franchise_id) };
      } finally { db.close(); }
      parentPort.postMessage(result);
    })().catch(error => { throw error; });
  `,
        { eval: true, workerData: { path, gate, module } },
      ),
  );
  try {
    const results = await Promise.all(
      workers.map(async (worker) => (await once(worker, "message"))[0]),
    );
    assert.equal(results.filter((result) => result.committed).length, 1);
    assert.deepEqual(
      results.map((result) => result.franchises),
      [[1], [1]],
    );
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
});
