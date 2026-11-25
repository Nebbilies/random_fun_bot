import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function designations(db) {
  return db
    .prepare("SELECT main_franchise_id FROM characters ORDER BY rank")
    .all()
    .map((row) => row.main_franchise_id);
}

const dropMainFranchise =
  "DROP INDEX characters_by_main_franchise; ALTER TABLE characters DROP COLUMN main_franchise_id;";

function predecessorFile(t) {
  const directory = mkdtempSync(join(tmpdir(), "main-franchise-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "catalog.sqlite");
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA foreign_keys=ON");
    installEmptyFinalCatalog(db);
    seed(db);
    db.exec("BEGIN IMMEDIATE");
    db.exec(dropMainFranchise);
    db.exec("COMMIT");
    assert.equal(isPreMainFranchiseCatalogSchema(db), true);
  } finally {
    db.close();
  }
  return path;
}

test("a fresh catalog defaults main franchise to NULL and enforces the indexed relationship", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("PRAGMA foreign_keys=ON");
  installEmptyFinalCatalog(db);
  seed(db);

  assert.deepEqual(designations(db), [null, null]);
  assert.equal(
    db
      .prepare(
        "SELECT name FROM pragma_index_info('characters_by_main_franchise')",
      )
      .get()?.name,
    "main_franchise_id",
  );
  db.exec("UPDATE characters SET main_franchise_id=1");
  assert.deepEqual(designations(db), [1, 1]);
  assert.throws(
    () => db.exec("UPDATE characters SET main_franchise_id=99"),
    /FOREIGN KEY/,
  );
  db.exec("DELETE FROM franchises WHERE id=1");
  assert.deepEqual(designations(db), [null, null]);
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
      assert.deepEqual(designations(db), [null, null]);
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
      db.exec("UPDATE characters SET main_franchise_id = 2");
    } finally {
      db.close();
    }

    const reopened = open(path);
    try {
      assert.deepEqual(designations(reopened), [2, 2]);
    } finally {
      reopened.close();
    }
    const readOnly = openFinalCatalogReadOnly(path);
    try {
      assert.deepEqual(designations(readOnly), [2, 2]);
    } finally {
      readOnly.close();
    }
  });
}

test("merging a franchise moves main references in the existing merge transaction", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("PRAGMA foreign_keys=ON");
  installEmptyFinalCatalog(db);
  seed(db);
  db.prepare("UPDATE characters SET main_franchise_id=1 WHERE id=?").run(first);
  db.prepare("INSERT INTO character_franchise_memberships VALUES(?,1)").run(
    first,
  );

  mergeFranchises(db, 1, 2);

  assert.deepEqual(designations(db), [2, null]);
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
    "UPDATE franchises SET name_source='manual' WHERE id=2; UPDATE characters SET main_franchise_id=rank",
  );
  setMeta(db, "franchise_import_source_published_at", "fixture");
  setMeta(
    db,
    "franchise_import_source_token",
    characterAppearanceSourceToken(db),
  );

  publishFranchiseCatalog(db);

  assert.deepEqual(designations(db), [null, 2]);
  assert.deepEqual(
    db
      .prepare("SELECT id FROM franchises")
      .all()
      .map((row) => row.id),
    [2],
  );
});

test("the deployment gate upgrades only the main-franchise schema before validating it read-only", (t) => {
  const path = predecessorFile(t);
  const writer = new DatabaseSync(path);
  try {
    writer
      .prepare(
        "INSERT INTO character_protection_locks VALUES('1',?,'soulbind',NULL)",
      )
      .run(first);
  } finally {
    writer.close();
  }

  validateCatalogForDeployment(path);
  validateCatalogForDeployment(path);

  const db = openFinalCatalogReadOnly(path);
  try {
    assert.deepEqual(designations(db), [null, null]);
    assert.equal(
      db.prepare("SELECT protected_until FROM character_protection_locks").get()
        .protected_until,
      null,
    );
  } finally {
    db.close();
  }
});

test("the deployment gate rejects a partial schema without repairing it", (t) => {
  const path = predecessorFile(t);
  const db = new DatabaseSync(path);
  try {
    db.exec("ALTER TABLE characters ADD COLUMN main_franchise_id INTEGER");
    const schema = db
      .prepare("SELECT type,name,sql FROM sqlite_schema ORDER BY name")
      .all();
    assert.throws(
      () => validateCatalogForDeployment(path),
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

test("an older ranked catalog runs its existing writable upgrades while the deploy gate stays narrow", (t) => {
  const path = predecessorFile(t);
  const writer = new DatabaseSync(path);
  try {
    const previousAwards = AFFECTION_AWARDS_DDL.replace(
      "base IN (1,5,8,10,12,20,100)",
      "base IN (1,5,10,12,20,100)",
    );
    writer.exec(`DROP TABLE affection_awards; ${previousAwards}`);
    assert.equal(isPreSoulmateReclaimCatalogSchema(writer), true);
    assert.throws(
      () => validateCatalogForDeployment(path),
      /soulmate reclaim schema update needed/i,
    );
    assert.equal(isPreSoulmateReclaimCatalogSchema(writer), true);
  } finally {
    writer.close();
  }

  const db = openFinalCatalog(path);
  try {
    assert.deepEqual(designations(db), [null, null]);
  } finally {
    db.close();
  }
});

test("a late upgrade failure and a dry run preserve the exact predecessor", (t) => {
  const path = predecessorFile(t);
  const db = new DatabaseSync(path);
  try {
    const rows = db.prepare("SELECT * FROM characters ORDER BY rank").all();
    assert.equal(upgradeMainFranchiseCatalog(db).committed, false);
    assert.equal(isPreMainFranchiseCatalogSchema(db), true);
    const connection = {
      get isTransaction() {
        return db.isTransaction;
      },
      prepare: (sql) => db.prepare(sql),
      exec(sql) {
        db.exec(sql);
        if (sql.includes("CREATE INDEX characters_by_main_franchise"))
          throw new Error("injected after main-franchise DDL");
      },
    };
    assert.throws(
      () => upgradeMainFranchiseCatalog(connection, { dryRun: false }),
      /injected after/,
    );
    assert.equal(db.isTransaction, false);
    assert.equal(isPreMainFranchiseCatalogSchema(db), true);
    assert.deepEqual(
      db.prepare("SELECT * FROM characters ORDER BY rank").all(),
      rows,
    );

    assert.equal(
      upgradeMainFranchiseCatalog(db, { dryRun: false }).committed,
      true,
    );
    db.exec("BEGIN IMMEDIATE");
    assert.deepEqual(designations(db), [null, null]);
    db.exec(dropMainFranchise);
    assert.equal(
      validateFinalCatalogSchema(db, { readOnly: false, mainFranchise: false }),
      true,
    );
    assert.deepEqual(
      db.prepare("SELECT * FROM characters ORDER BY rank").all(),
      rows,
    );
    db.exec("COMMIT");
  } finally {
    db.close();
  }
});

test("concurrent upgrades serialize and only one installs the schema", async (t) => {
  const path = predecessorFile(t);
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
      let committed;
      try {
        if (Atomics.add(gate, 0, 1) === 0) Atomics.wait(gate, 0, 1, 10000);
        else Atomics.notify(gate, 0);
        committed = upgradeMainFranchiseCatalog(db, { dryRun: false }).committed;
      } finally { db.close(); }
      parentPort.postMessage(committed);
    })().catch(error => { throw error; });
  `,
        { eval: true, workerData: { path, gate, module } },
      ),
  );
  try {
    const results = await Promise.all(
      workers.map(async (worker) => (await once(worker, "message"))[0]),
    );
    assert.equal(results.filter(Boolean).length, 1);
    const db = openFinalCatalogReadOnly(path);
    try {
      assert.deepEqual(designations(db), [null, null]);
    } finally {
      db.close();
    }
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
});
