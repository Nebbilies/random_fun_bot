import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  openCatalog,
  openCatalogReadOnly,
  createFinalCatalog,
  openFinalCatalog,
  openFinalCatalogReadOnly,
} from "../lib/catalogDb.js";
import { convertLegacyCatalogToFinal } from "../lib/characterIdentityMigration.js";
import { validateFinalCatalogSchema } from "../lib/catalogFinalSchema.js";
import { validateFinalCatalogSchema as validatePreRankingCatalogSchema } from "../lib/catalogPreRankingSchema.js";

const uuid = "12345678-1234-4123-8123-123456789abc";
function file(t) {
  const dir = mkdtempSync(join(tmpdir(), "final-catalog-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "synthetic.sqlite");
}
function snapshot(db) {
  const schema = db.prepare("SELECT * FROM sqlite_schema ORDER BY name").all();
  return {
    schema,
    version: db.prepare("PRAGMA user_version").get(),
    rows: schema
      .filter((r) => r.type === "table")
      .map((r) => [r.name, db.prepare(`SELECT * FROM "${r.name}"`).all()]),
    fk: db.prepare("PRAGMA foreign_keys").get(),
  };
}
function manual(db) {
  db.prepare(
    "INSERT INTO character_identities(id,creation_method) VALUES (?,'manual')",
  ).run(uuid);
  db.prepare(
    `INSERT INTO characters(id,rank,favourites,tie_order,likes_source,name_full)
    VALUES (?,1,0,1,'generated','Manual')`,
  ).run(uuid);
  db.exec(
    "INSERT INTO franchises(display_name,created_at) VALUES ('Manual franchise','synthetic')",
  );
  db.prepare("INSERT INTO character_franchise_memberships VALUES (?,1)").run(
    uuid,
  );
}

test("empty final file create, manual-only, normal/strict writable and readonly restart", (t) => {
  const path = file(t);
  let db = createFinalCatalog(path);
  assert.equal(db.prepare("SELECT count(*) n FROM characters").get().n, 0);
  manual(db);
  db.close();
  for (const open of [
    openFinalCatalog,
    openCatalog,
    openFinalCatalogReadOnly,
    openCatalogReadOnly,
  ]) {
    const before = readFileSync(path);
    db = open(path);
    assert.equal(
      db.prepare("SELECT count(*) n FROM effective_character_franchises").get()
        .n,
      1,
    );
    assert.equal(db.prepare("SELECT id FROM characters").get().id, uuid);
    if (open === openFinalCatalogReadOnly || open === openCatalogReadOnly) {
      assert.throws(() => db.exec("DELETE FROM catalog_state"), /readonly/);
    }
    db.close();
    assert.deepEqual(readFileSync(path), before);
  }
  assert.throws(() => createFinalCatalog(path), /empty file/);
});

test("creation accepts zero bytes only, and strict startup never creates or upgrades legacy", (t) => {
  const path = file(t);
  assert.throws(() => openFinalCatalog(path), /existing/);
  writeFileSync(path, "");
  createFinalCatalog(path).close();
  assert.throws(() => createFinalCatalog(path), /empty/);
  rmSync(path);
  openCatalog(path).close();
  const before = readFileSync(path);
  assert.throws(() => openFinalCatalog(path), /ranking migration required/i);
  assert.throws(
    () => openFinalCatalogReadOnly(path),
    /ranking migration required/i,
  );
  assert.deepEqual(readFileSync(path), before);
  const legacy = openCatalog(path);
  assert.equal(legacy.prepare("PRAGMA user_version").get().user_version, 10);
  legacy.close();
});

test("authoritative inherited UUID/source/count/rank constraints apply to future writes", (t) => {
  const db = createFinalCatalog(file(t));
  try {
    manual(db);
    for (const sql of [
      "UPDATE character_identities SET creation_method='other'",
      "UPDATE character_identities SET id=upper(id)",
      "UPDATE characters SET rank=0",
      "UPDATE characters SET rank=1.5",
      "UPDATE characters SET favourites=-1",
      "UPDATE characters SET favourites=9007199254740992",
      "UPDATE characters SET tie_order=NULL",
      "UPDATE characters SET tie_order=1.5",
      "UPDATE characters SET likes_source='other'",
      "UPDATE characters SET likes_source='anilist'",
      "INSERT INTO marriages(guild_id,character_id,owner_id,married_at) VALUES ('g','bad','u','now')",
    ])
      assert.throws(() => db.exec(sql), undefined, sql);
    const source = db.prepare(
      "INSERT INTO character_sources VALUES ('anilist',?,?)",
    );
    for (const external of ["0", "01", "-1", "1.5", "9007199254740992", " 1"]) {
      assert.throws(() => source.run(external, uuid));
    }
    source.run("1", uuid);
    db.exec("UPDATE characters SET likes_source='anilist'");
    assert.throws(() => db.exec("DELETE FROM character_sources"), /Freeze/);
    assert.throws(
      () => db.exec("UPDATE character_sources SET external_id='2'"),
      /Freeze/,
    );
    db.exec(
      "UPDATE characters SET likes_source='generated'; DELETE FROM character_sources",
    );
  } finally {
    db.close();
  }
});

test("numeric conversion rehearses atomically and produces pre-ranking data requiring explicit cutover", (t) => {
  const path = file(t);
  let db = openCatalog(path);
  db.exec(`INSERT INTO characters(id,rank,favourites,name_full) VALUES(3,1,50,'First'),(1,2,50,'Second');
    INSERT INTO character_identities VALUES(3,'First',NULL),(1,'Second',NULL),(99,'Retained',NULL);
    INSERT INTO marriages(id,guild_id,character_id,owner_id,married_at) VALUES(900,'g',99,'u','date');
    DELETE FROM marriages;
    INSERT INTO character_wishes VALUES('g','u',99,1);
    INSERT INTO character_rolls(id,guild_id,channel_id,command_message_id,character_id,character_name,state)
      VALUES(800,'g','c','cmd',0,'Prank','prank'); DELETE FROM character_rolls;
    INSERT INTO mystery_sessions(id,guild_id,origin_roll_id,event_id,character_id,rank_snapshot,roller_id,
      event_channel_id,state,started_at,deadline_at) VALUES(700,'g',800,'e',3,1,'u','c','completed',1,2);
    DELETE FROM mystery_sessions;
    INSERT INTO stage_characters(id,favourites) VALUES(42,5);
    INSERT INTO catalog_meta VALUES('scan_page','7'),('keep_this','retained');`);
  const before = snapshot(db);
  assert.equal(convertLegacyCatalogToFinal(db).committed, false);
  assert.deepEqual(snapshot(db), before);
  assert.equal(
    convertLegacyCatalogToFinal(db, { dryRun: false }).committed,
    true,
  );
  assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  assert.equal(
    db.prepare("SELECT count(*) n FROM stage_characters").get().n,
    0,
  );
  assert.equal(
    db.prepare("SELECT value FROM catalog_meta WHERE key='scan_page'").get(),
    undefined,
  );
  assert.equal(
    db.prepare("SELECT value FROM catalog_meta WHERE key='keep_this'").get()
      .value,
    "retained",
  );
  const ids = db.prepare("SELECT id FROM characters ORDER BY rank").all();
  assert.equal(validatePreRankingCatalogSchema(db, { readOnly: false }), true);
  assert.equal(
    db
      .prepare(
        "SELECT 1 FROM sqlite_schema WHERE name='character_ranking_policy'",
      )
      .get(),
    undefined,
  );
  assert.throws(
    () => validateFinalCatalogSchema(db),
    /ranking migration required/i,
  );
  const converted = snapshot(db);
  db.close();
  const bytes = readFileSync(path);
  for (const readOnly of [false, true]) {
    db = new DatabaseSync(path, { readOnly });
    try {
      assert.equal(validatePreRankingCatalogSchema(db, { readOnly }), true);
      assert.deepEqual(
        db.prepare("SELECT id FROM characters ORDER BY rank").all(),
        ids,
      );
      assert.equal(
        db.prepare("SELECT count(*) n FROM character_wishes").get().n,
        1,
      );
      assert.deepEqual(
        db
          .prepare("SELECT name,seq FROM sqlite_sequence ORDER BY name")
          .all()
          .map((r) => [r.name, r.seq]),
        [
          ["character_rolls", 800],
          ["marriages", 900],
          ["mystery_sessions", 700],
        ],
      );
    } finally {
      db.close();
    }
    assert.deepEqual(readFileSync(path), bytes);
  }
  for (const open of [
    openFinalCatalog,
    openFinalCatalogReadOnly,
    openCatalog,
    openCatalogReadOnly,
  ]) {
    assert.throws(
      () => open(path),
      /ranking migration required.*explicit offline ranking cutover/i,
    );
    assert.deepEqual(readFileSync(path), bytes);
  }
  db = new DatabaseSync(path);
  try {
    assert.deepEqual(snapshot(db), converted);
  } finally {
    db.close();
  }
});

test("unsupported, spoofed partial v12, corrupt final fail before persistent mutation", (t) => {
  const path = file(t);
  for (const version of [11, 13, 2147483647, -1]) {
    let db = new DatabaseSync(path);
    db.exec(`PRAGMA user_version=${version}`);
    db.close();
    const before = readFileSync(path);
    for (const open of [
      openCatalog,
      openCatalogReadOnly,
      openFinalCatalog,
      openFinalCatalogReadOnly,
    ]) {
      assert.throws(() => open(path));
      assert.deepEqual(readFileSync(path), before);
    }
  }
  rmSync(path);
  let db = createFinalCatalog(path);
  db.exec("DROP TRIGGER characters_require_source_insert");
  db.close();
  const before = readFileSync(path);
  for (const open of [
    openCatalog,
    openCatalogReadOnly,
    openFinalCatalog,
    openFinalCatalogReadOnly,
  ]) {
    assert.throws(() => open(path), /authoritative/);
    assert.deepEqual(readFileSync(path), before);
  }
  rmSync(path);
  db = createFinalCatalog(path);
  manual(db);
  db.exec(
    "PRAGMA ignore_check_constraints=ON; UPDATE characters SET favourites=-1",
  );
  db.close();
  assert.throws(() => openFinalCatalog(path), /integrity/);
  assert.throws(() => openFinalCatalogReadOnly(path), /integrity/);
});

test("integrity verification refuses a connection with CHECK enforcement disabled", (t) => {
  const db = createFinalCatalog(file(t));
  try {
    db.exec("PRAGMA ignore_check_constraints=ON");
    assert.throws(() => validateFinalCatalogSchema(db), /CHECK enforcement/);
    assert.equal(
      db.prepare("PRAGMA ignore_check_constraints").get()
        .ignore_check_constraints,
      1,
    );
    db.exec("PRAGMA ignore_check_constraints=OFF");
    assert.equal(validateFinalCatalogSchema(db), true);
  } finally {
    db.close();
  }
});

for (const sql of [
  "UPDATE franchises SET curated_cover_url='http://example.test/cover'",
  "UPDATE catalog_state SET source_revision=-1",
]) {
  test(`normal open detects stored CHECK violations outside character ranks: ${sql}`, (t) => {
    const path = file(t);
    const db = createFinalCatalog(path);
    manual(db);
    db.exec(`PRAGMA ignore_check_constraints=ON; ${sql}`);
    db.close();
    const before = readFileSync(path);
    for (const open of [
      openCatalog,
      openCatalogReadOnly,
      openFinalCatalog,
      openFinalCatalogReadOnly,
    ]) {
      assert.throws(() => open(path), /integrity/, open.name);
      assert.deepEqual(readFileSync(path), before);
    }
  });
}

test("offline final conversion refuses v1-v9 and unknown inputs without mutation", (t) => {
  const db = openCatalog(file(t));
  try {
    for (const version of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13]) {
      db.exec(`PRAGMA user_version=${version}`);
      const before = snapshot(db);
      assert.throws(
        () => convertLegacyCatalogToFinal(db, { dryRun: false }),
        /fully upgraded legacy v10/,
      );
      assert.deepEqual(snapshot(db), before);
    }
  } finally {
    db.close();
  }
});

for (const [kind, sql] of Object.entries({
  trigger:
    "CREATE TRIGGER sqliteXevil AFTER INSERT ON guild_prefixes BEGIN SELECT 1; END",
  index: "CREATE INDEX sqliteXevil ON guild_prefixes(prefix)",
  view: "CREATE VIEW sqliteXevil AS SELECT * FROM guild_prefixes",
})) {
  test(`final startup and offline conversion reject near-reserved unexpected ${kind}`, (t) => {
    for (const final of [false, true]) {
      const path = file(t);
      const db = final ? createFinalCatalog(path) : openCatalog(path);
      db.exec(sql);
      const before = snapshot(db);
      if (!final) {
        assert.throws(
          () => convertLegacyCatalogToFinal(db, { dryRun: false }),
          /schema/,
        );
        assert.deepEqual(snapshot(db), before);
      }
      db.close();
      const bytes = readFileSync(path);
      if (final)
        for (const open of [
          openCatalog,
          openCatalogReadOnly,
          openFinalCatalog,
          openFinalCatalogReadOnly,
        ]) {
          assert.throws(() => open(path), /authoritative/);
          assert.deepEqual(readFileSync(path), bytes);
        }
    }
  });
}

for (const [kind, sql] of Object.entries({
  check: `ALTER TABLE guild_prefixes RENAME TO old_prefixes;
    CREATE TABLE guild_prefixes (guild_id TEXT PRIMARY KEY, prefix TEXT NOT NULL CHECK(length(prefix)>0));
    INSERT INTO guild_prefixes SELECT * FROM old_prefixes; DROP TABLE old_prefixes;`,
  index:
    "DROP INDEX stage_character_rank; CREATE INDEX stage_character_rank ON stage_characters(id)",
  trigger: `DROP TRIGGER user_inventory_discover_item;
    CREATE TRIGGER user_inventory_discover_item AFTER INSERT ON user_inventory BEGIN SELECT 1; END`,
  missingIndex: "DROP INDEX stage_character_rank",
  missingTrigger: "DROP TRIGGER user_inventory_discover_item",
  missingTable: "DROP TABLE stage_anime_relations",
})) {
  test(`offline final conversion prevalidates legacy definitions: ${kind}`, (t) => {
    const path = file(t);
    const db = openCatalog(path);
    try {
      db.exec(`INSERT INTO guild_prefixes VALUES ('g','!');
        INSERT INTO characters(id,rank,favourites) VALUES (1,1,5);
        INSERT INTO character_identities(id) VALUES (1);
        INSERT INTO stage_characters(id,favourites) VALUES (42,5);
        INSERT INTO catalog_meta VALUES ('scan_page','7');`);
      db.exec(sql);
      for (const fk of [0, 1])
        for (const dryRun of [true, false]) {
          db.exec(`PRAGMA foreign_keys=${fk}`);
          const before = snapshot(db);
          let allocated = false;
          assert.throws(
            () =>
              convertLegacyCatalogToFinal(db, {
                dryRun,
                uuid: () => {
                  allocated = true;
                  return uuid;
                },
              }),
            /legacy.*schema/i,
          );
          assert.equal(allocated, false);
          assert.deepEqual(snapshot(db), before);
        }
    } finally {
      db.close();
    }
    const before = readFileSync(path);
    const reopened = new DatabaseSync(path);
    try {
      assert.throws(
        () => convertLegacyCatalogToFinal(reopened, { dryRun: false }),
        /legacy.*schema/i,
      );
    } finally {
      reopened.close();
    }
    assert.deepEqual(readFileSync(path), before);
  });
}

test("late final conversion failure restores exact schema, rows, sequences and FK connection mode", (t) => {
  const db = openCatalog(file(t));
  try {
    db.exec(`INSERT INTO characters(id,rank,favourites) VALUES(1,2,3);
      INSERT INTO character_identities(id) VALUES(1);
      INSERT INTO marriages(id,guild_id,character_id,owner_id,married_at) VALUES(900,'g',1,'u','d');
      DELETE FROM marriages;`); // Valid v10 SQL, invalid final contiguous rank: failure after all DDL/copy.
    for (const fk of [0, 1]) {
      db.exec(`PRAGMA foreign_keys=${fk}`);
      const before = snapshot(db);
      assert.throws(
        () => convertLegacyCatalogToFinal(db, { dryRun: false }),
        /rank\/tie/,
      );
      assert.deepEqual(snapshot(db), before);
    }
    db.exec("BEGIN");
    assert.throws(() => convertLegacyCatalogToFinal(db), /transaction/);
    db.exec("ROLLBACK");
  } finally {
    db.close();
  }
});
