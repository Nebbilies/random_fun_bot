import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openCatalog,
  createFinalCatalog,
  getMeta,
  setMeta,
  publishCatalog,
  transaction,
} from "../lib/catalogDb.js";
import {
  previewSourceMutation,
  confirmSourceMutation,
} from "../lib/catalogSourceMutations.js";

import {
  assertSourceCatalogStagingBinding,
  bindSourceCatalogStaging,
  publishSourceCatalog,
} from "../lib/sourceCatalogPublication.js";
import {
  runImport,
  scanOnePage,
  hydrateOneBatch,
} from "../scripts/importCharacterCatalog.js";

const id = "aaaaaaaa-0000-4000-8000-000000000001";
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "import-source-binding-"));
  const db = createFinalCatalog(join(dir, "synthetic.sqlite"));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  db.prepare(
    "INSERT INTO character_identities(id,name_full) VALUES(?,'Original')",
  ).run(id);
  db.prepare("INSERT INTO character_sources VALUES('anilist','20',?)").run(id);
  db.prepare(
    "INSERT INTO characters(id,rank,tie_order,favourites,name_full) VALUES(?,1,1,100,'Original')",
  ).run(id);
  return db;
}

test("unbound release staging cannot resurrect an unlinked source identity", async (t) => {
  const db = fixture(t);
  db.exec(
    "INSERT INTO stage_characters(id,favourites,name_full) VALUES(20,200,'Obsolete')",
  );
  const auth = { account: "binding-test", role: "moderator" };
  const preview = await previewSourceMutation(db, {
    ...auth,
    operation: "source-unlink",
    input: { characterId: id, source: "anilist" },
    now: 1000,
  });
  confirmSourceMutation(db, {
    ...auth,
    previewId: preview.previewId,
    payloadHash: preview.payloadHash,
    idempotencyKey: "unlink",
    now: 1001,
  });
  assert.throws(() => publishCatalog(db), /restart/i);
  assert.equal(
    db.prepare("SELECT count(*) n FROM character_identities").get().n,
    1,
  );
  assert.equal(
    db.prepare("SELECT count(*) n FROM character_sources").get().n,
    0,
  );
});

function bind(db) {
  transaction(db, () => bindSourceCatalogStaging(db));
}
async function mutate(db, operation) {
  const auth = { account: "binding-test", role: "moderator" };
  const preview = await previewSourceMutation(db, {
    ...auth,
    operation,
    input: {
      characterId: id,
      source: "anilist",
      ...(operation === "source-correct" ? { externalId: "21" } : {}),
    },
    permissionConfirmed: true,
    verifySource: async () => ({
      ok: true,
      text: async () =>
        JSON.stringify({
          data: {
            Character: {
              id: 21,
              favourites: 123,
              name: { full: "Corrected" },
              image: { large: "https://example.test/image" },
              siteUrl: "https://anilist.co/character/21",
            },
          },
        }),
    }),
    now: 1000,
  });
  return confirmSourceMutation(db, {
    ...auth,
    previewId: preview.previewId,
    payloadHash: preview.payloadHash,
    idempotencyKey: operation,
    now: 1001,
  });
}

for (const operation of ["source-unlink", "source-correct"]) {
  test(`bound staging rejects ${operation} through both publication APIs atomically`, async (t) => {
    const db = fixture(t);
    bind(db);
    db.exec(
      "INSERT INTO stage_characters(id,favourites,name_full) VALUES(20,200,'Obsolete')",
    );
    await mutate(db, operation);
    const before = db.prepare("SELECT * FROM catalog_state").get();
    for (const publish of [
      () => publishCatalog(db),
      () => transaction(db, () => publishSourceCatalog(db)),
    ]) {
      assert.throws(publish, /stale.*restart/is);
      assert.deepEqual(db.prepare("SELECT * FROM catalog_state").get(), before);
      assert.equal(
        db.prepare("SELECT count(*) n FROM character_identities").get().n,
        1,
      );
      assert.equal(
        db.prepare("SELECT name_full FROM characters").get().name_full,
        "Original",
      );
    }
    assert.throws(() => bind(db), /restart/i); // No retroactive adoption.
    transaction(db, () => {
      db.exec("DELETE FROM stage_characters");
      bindSourceCatalogStaging(db);
    });
    assert.doesNotThrow(() => assertSourceCatalogStagingBinding(db));
  });
}

test("publication advances its own binding, repeated publication and empty reset are safe", (t) => {
  const db = fixture(t);
  bind(db);
  db.exec(
    "INSERT INTO stage_characters(id,favourites,name_full) VALUES(20,200,'Refreshed')",
  );
  assert.equal(publishCatalog(db), 1);
  assert.equal(publishCatalog(db), 1);
  assert.equal(getMeta(db, "character_import_source_token"), "source:2");
  transaction(db, () => {
    db.exec("DELETE FROM stage_characters");
    bindSourceCatalogStaging(db);
  });
  assert.equal(getMeta(db, "character_import_source_token"), "source:2");
  db.exec(
    "INSERT INTO stage_characters(id,favourites,name_full) VALUES(20,300,'Again')",
  );
  publishCatalog(db);
  assert.equal(db.prepare("SELECT id FROM characters").get().id, id);
  assert.equal(getMeta(db, "character_import_source_token"), "source:3");
  assert.throws(() => publishSourceCatalog(db), /transaction/);
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

for (const sourceEdit of [false, true]) {
  test(`late scan response cannot enter a restarted scan (source edit: ${sourceEdit})`, async (t) => {
    const db = fixture(t);
    const entered = deferred();
    const response = deferred();
    const oldRun = runImport({
      db,
      log() {},
      api: apiFor(db, {
        async animePage() {
          entered.resolve();
          return response.promise;
        },
        async characterDetails() {
          return [
            {
              id: 20,
              name: { full: "Resurrected" },
              media: { pageInfo: { hasNextPage: false }, nodes: [media] },
            },
          ];
        },
      }),
    });
    // Attach immediately so a rejection is never unhandled.
    const rejected = assert.rejects(oldRun, /restart/i);
    await entered.promise;
    if (sourceEdit) await mutate(db, "source-unlink");
    await assert.rejects(
      runImport({
        db,
        restart: true,
        log() {},
        api: apiFor(db, {
          async animePage() {
            throw new Error("B network failure");
          },
        }),
      }),
      /B network failure/,
    );
    const before = db.prepare("SELECT * FROM catalog_meta ORDER BY key").all();
    response.resolve({ pageInfo: { hasNextPage: false }, media: [media] });
    await rejected;
    assert.deepEqual(
      db.prepare("SELECT * FROM catalog_meta ORDER BY key").all(),
      before,
    );
    assert.equal(
      db.prepare("SELECT count(*) n FROM stage_characters").get().n,
      0,
    );
    assert.equal(
      db.prepare("SELECT count(*) n FROM character_identities").get().n,
      1,
    );
    assert.equal(
      db.prepare("SELECT count(*) n FROM character_sources").get().n,
      sourceEdit ? 0 : 1,
    );
    assert.equal(getMeta(db, "import_phase"), "scan");
  });
}

test("resumed hydration retains its captured generation after a same-revision restart", async (t) => {
  const db = fixture(t);
  bind(db);
  const generation = getMeta(db, "character_import_scan_generation");
  setMeta(db, "import_phase", "hydrate");
  setMeta(
    db,
    "scan_scope",
    "format!=MUSIC;status!=NOT_YET_RELEASED;averageScore>=50;popularity>15000",
  );
  setMeta(db, "scan_mode", "growing");
  db.exec("INSERT INTO stage_characters(id,favourites) VALUES(30,200)");
  const entered = deferred();
  const response = deferred();
  const oldRun = runImport({
    db,
    log() {},
    api: {
      async characterDetails() {
        entered.resolve();
        return response.promise;
      },
    },
  });
  const rejected = assert.rejects(oldRun, /restart/i);
  await entered.promise;
  assert.equal(getMeta(db, "character_import_scan_generation"), generation);
  await assert.rejects(
    runImport({
      db,
      restart: true,
      log() {},
      api: apiFor(db, {
        async animePage() {
          throw new Error("B network failure");
        },
      }),
    }),
    /B network failure/,
  );
  assert.notEqual(getMeta(db, "character_import_scan_generation"), generation);
  const before = db.prepare("SELECT * FROM catalog_meta ORDER BY key").all();
  // Reuse the same candidate ID to detect accidental hydration of B's rows.
  db.exec("INSERT INTO stage_characters(id,favourites) VALUES(30,300)");
  response.resolve([
    {
      id: 30,
      name: { full: "Old metadata" },
      media: { pageInfo: { hasNextPage: false }, nodes: [media] },
    },
  ]);
  await rejected;
  assert.deepEqual(
    db.prepare("SELECT * FROM catalog_meta ORDER BY key").all(),
    before,
  );
  assert.equal(
    db.prepare("SELECT name_full FROM stage_characters WHERE id=30").get()
      .name_full,
    null,
  );
  assert.equal(
    db.prepare("SELECT count(*) n FROM character_identities").get().n,
    1,
  );
});

test("explicit publication binding rejects a replaced generation and preserves repeat publication", (t) => {
  const db = fixture(t);
  const original = transaction(db, () => bindSourceCatalogStaging(db));
  const replacement = transaction(db, () => bindSourceCatalogStaging(db));
  assert.equal(original.token, replacement.token);
  assert.notEqual(original.generation, replacement.generation);
  db.exec(
    "INSERT INTO stage_characters(id,favourites,name_full) VALUES(20,200,'Refreshed')",
  );
  assert.throws(
    () => transaction(db, () => publishSourceCatalog(db, original)),
    /restart/i,
  );
  assert.equal(
    transaction(db, () => publishSourceCatalog(db, replacement)),
    1,
  );
  assert.equal(
    getMeta(db, "character_import_scan_generation"),
    replacement.generation,
  );
  // A publication advances the source token, not the generation. Direct callers
  // can explicitly capture the advanced binding for another publication.
  assert.throws(
    () => transaction(db, () => publishSourceCatalog(db, replacement)),
    /restart/i,
  );
  const advanced = assertSourceCatalogStagingBinding(db);
  assert.equal(
    transaction(db, () => publishSourceCatalog(db, advanced)),
    1,
  );
});

test("source revision overflow rolls back publication and completion checkpoints", async (t) => {
  const db = fixture(t);
  db.prepare("UPDATE catalog_state SET source_revision=?").run(
    Number.MAX_SAFE_INTEGER,
  );
  bind(db);
  setMeta(db, "import_phase", "publish");
  setMeta(
    db,
    "scan_scope",
    "format!=MUSIC;status!=NOT_YET_RELEASED;averageScore>=50;popularity>15000",
  );
  setMeta(db, "scan_mode", "growing");
  db.exec(
    "INSERT INTO stage_characters(id,favourites,name_full) VALUES(20,200,'Refreshed')",
  );
  const before = db.prepare("SELECT * FROM catalog_meta ORDER BY key").all();
  await assert.rejects(
    runImport({ db, api: {}, log() {} }),
    /Invalid source revision/,
  );
  assert.deepEqual(
    db.prepare("SELECT * FROM catalog_meta ORDER BY key").all(),
    before,
  );
  assert.equal(
    db.prepare("SELECT name_full FROM characters").get().name_full,
    "Original",
  );
});

const media = {
  id: 1,
  format: "TV",
  status: "FINISHED",
  averageScore: 70,
  popularity: 20000,
  title: { romaji: "Fixture" },
  characters: {
    pageInfo: { hasNextPage: false },
    nodes: [{ id: 20, favourites: 200 }],
  },
};
function apiFor(db, overrides = {}) {
  return {
    async highestAnimeId() {
      assert.equal(db.isTransaction, false);
      return 1;
    },
    async animePage() {
      assert.equal(db.isTransaction, false);
      return { pageInfo: { hasNextPage: false }, media: [media] };
    },
    async characterDetails() {
      throw new Error("Existing source must not need hydration");
    },
    ...overrides,
  };
}

test("import start, completed no-op, refresh and same-scan restart bind correctly", async (t) => {
  const db = fixture(t);
  const api = apiFor(db);
  await runImport({ db, api, log() {} });
  assert.equal(getMeta(db, "import_phase"), "complete");
  assert.equal(getMeta(db, "character_import_source_token"), "source:1");
  await runImport({ db, api: {}, log() {} });
  await runImport({ db, api, refresh: true, log() {} });
  assert.equal(getMeta(db, "character_import_source_token"), "source:2");
  setMeta(db, "import_phase", "scan");
  await runImport({ db, api, restart: true, log() {} });
  assert.equal(getMeta(db, "character_import_source_token"), "source:3");
});

test("source change during discovery setup rolls back reset and never binds a later revision", async (t) => {
  const db = fixture(t);
  bind(db);
  db.exec(
    "INSERT INTO stage_characters(id,favourites,name_full) VALUES(20,200,'Saved')",
  );
  await assert.rejects(
    runImport({
      db,
      api: apiFor(db, {
        async highestAnimeId() {
          assert.equal(db.isTransaction, false);
          await mutate(db, "source-unlink");
          return 1;
        },
      }),
      log() {},
    }),
    /restart/i,
  );
  assert.equal(
    db.prepare("SELECT name_full FROM stage_characters").get().name_full,
    "Saved",
  );
  assert.equal(getMeta(db, "character_import_source_token"), "source:0");
});

for (const phase of ["scan", "hydrate", "publish"]) {
  test(`resume rejects unbound or stale ${phase} before any network`, async (t) => {
    const db = fixture(t);
    setMeta(db, "import_phase", phase);
    await assert.rejects(runImport({ db, api: {}, log() {} }), /restart/i);
    bind(db);
    await mutate(db, "source-unlink");
    await assert.rejects(runImport({ db, api: {}, log() {} }), /restart/i);
  });
}

test("source edit during scan network rejects the page without saving candidates or progress", async (t) => {
  const db = fixture(t);
  bind(db);
  setMeta(db, "scan_range_start", 1);
  setMeta(db, "scan_max_id", 1);
  setMeta(db, "scan_page", 1);
  await assert.rejects(
    scanOnePage(
      db,
      apiFor(db, {
        async animePage() {
          assert.equal(db.isTransaction, false);
          await mutate(db, "source-unlink");
          return { pageInfo: { hasNextPage: false }, media: [media] };
        },
      }),
    ),
    /restart/i,
  );
  assert.equal(
    db.prepare("SELECT count(*) n FROM stage_characters").get().n,
    0,
  );
  assert.equal(getMeta(db, "scan_range_start"), "1");
});

test("source edit during hydration rejects returned metadata outside the network lock", async (t) => {
  const db = fixture(t);
  bind(db);
  db.exec("INSERT INTO stage_characters(id,favourites) VALUES(30,200)");
  await assert.rejects(
    hydrateOneBatch(db, {
      async characterDetails() {
        assert.equal(db.isTransaction, false);
        await mutate(db, "source-unlink");
        return [
          {
            id: 30,
            name: { full: "New" },
            media: { pageInfo: { hasNextPage: false }, nodes: [media] },
          },
        ];
      },
    }),
    /restart/i,
  );
  assert.equal(
    db.prepare("SELECT name_full FROM stage_characters").get().name_full,
    null,
  );
});

test("publication checks the binding inside its transaction and rolls back callback writes", async (t) => {
  const db = fixture(t);
  bind(db);
  db.exec(
    "INSERT INTO stage_characters(id,favourites,name_full) VALUES(20,200,'Obsolete')",
  );
  await mutate(db, "source-unlink");
  assert.throws(
    () =>
      publishCatalog(db, () => {
        assert.equal(db.isTransaction, true);
        setMeta(db, "callback_marker", "must roll back");
      }),
    /restart/i,
  );
  assert.equal(getMeta(db, "callback_marker"), null);
});

test("manual metadata and generated likes survive fresh typed publication", (t) => {
  const db = fixture(t);
  db.prepare(
    "UPDATE character_identities SET creation_method='manual' WHERE id=?",
  ).run(id);
  db.prepare("UPDATE characters SET likes_source='generated' WHERE id=?").run(
    id,
  );
  bind(db);
  db.exec(
    "INSERT INTO stage_characters(id,favourites,name_full) VALUES(20,9999,'Override')",
  );
  publishCatalog(db);
  const row = db.prepare("SELECT * FROM characters").get();
  assert.equal(row.id, id);
  assert.equal(row.name_full, "Original");
  assert.equal(row.favourites, 100);
});

test("untyped legacy importer still works without a revision binding", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "legacy-import-binding-"));
  const db = openCatalog(join(dir, "synthetic.sqlite"));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  db.exec(
    "INSERT INTO characters(id,rank,favourites,name_full) VALUES(20,1,100,'Legacy'); INSERT INTO character_identities SELECT id,name_full,image_url FROM characters",
  );
  await runImport({ db, api: apiFor(db), log() {} });
  assert.equal(
    db.prepare("SELECT favourites FROM characters").get().favourites,
    200,
  );
  assert.equal(getMeta(db, "character_import_source_token"), null);
});
