import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installEmptyFinalCatalog } from "../lib/catalogFinalSchema.js";
import {
  previewRankingMaintenance,
  confirmRankingMaintenance,
} from "../lib/catalogRankingMaintenance.js";
import { DanbooruApi } from "../lib/danbooruApi.js";
import { main as runMaintenance } from "../scripts/recalculateCharacterRanking.js";
import {
  createFinalCatalog,
  openFinalCatalogReadOnly,
} from "../lib/catalogDb.js";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
test("stored-input maintenance publishes a bound audited preview without network and retries exactly", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  installEmptyFinalCatalog(db);
  try {
    const auth = { account: "operator", role: "admin" };
    const p = await previewRankingMaintenance(db, {
      ...auth,
      api: {
        verifyRankingTag() {
          throw new Error("must not fetch");
        },
      },
      now: 1000,
    });
    const request = {
      ...auth,
      previewId: p.previewId,
      payloadHash: p.payloadHash,
      idempotencyKey: "one",
      now: 1001,
    };
    const result = confirmRankingMaintenance(db, request);
    assert.equal(result.revision, 1);
    assert.deepEqual(
      confirmRankingMaintenance(db, { ...request, now: 9999999 }),
      result,
    );
  } finally {
    db.close();
  }
});

test("refresh preview lifetime starts after slow evidence collection completes", async (t) => {
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  installEmptyFinalCatalog(db);
  try {
    const id = "00000000-0000-4000-8000-000000000001";
    db.prepare(
      "INSERT INTO character_identities(id,creation_method) VALUES(?,'manual')",
    ).run(id);
    db.prepare(
      "INSERT INTO characters(id,rank,tie_order,favourites,likes_source,danbooru_post_count) VALUES(?,1,1,0,'generated',0)",
    ).run(id);
    db.prepare(
      "INSERT INTO tag_decisions VALUES(?,'approve','slow_tag','manual','test')",
    ).run(id);
    const api = new DanbooruApi({
      gapMs: 0,
      fetchImpl: async () => {
        now += 700000;
        return new Response(
          JSON.stringify([
            {
              name: "slow_tag",
              category: 4,
              post_count: 0,
              is_deprecated: false,
            },
          ]),
        );
      },
    });
    const auth = { account: "operator", role: "admin" };
    const p = await previewRankingMaintenance(db, {
      ...auth,
      refresh: true,
      api,
    });
    assert.equal(p.expiresAt, 1301000);
    const result = confirmRankingMaintenance(db, {
      ...auth,
      previewId: p.previewId,
      payloadHash: p.payloadHash,
      idempotencyKey: "slow-refresh",
    });
    assert.equal(result.refreshed, 1);
  } finally {
    db.close();
  }
});

test("maintenance CLI projects read-only, refuses sidecar reports and confirms only a stored attributed preview", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ranking-maintenance-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  t.mock.method(console, "log", () => {});
  const path = join(dir, "catalog.sqlite");
  createFinalCatalog(path).close();
  const run = (name, args = []) =>
    runMaintenance([
      "--db",
      path,
      "--report",
      join(dir, `${name}.jsonl`),
      ...args,
    ]);
  assert.equal((await run("inventory")).operation, "ranking-maintenance");
  await assert.rejects(
    runMaintenance(["--db", path, "--report", `${path}-wal`]),
    /sidecars/,
  );
  assert.equal(existsSync(`${path}-wal`), false);
  await assert.rejects(
    run("forged", ["--commit", "--actor", "operator"]),
    /bound preview/,
  );
  const p = await run("preview", [
    "--save-preview",
    "--actor",
    "operator",
    "--expected-revision",
    "0",
  ]);
  const args = [
    "--commit",
    "--actor",
    "operator",
    "--preview-id",
    p.previewId,
    "--payload-hash",
    p.payloadHash,
    "--idempotency-key",
    "request",
  ];
  const result = await run("confirm", args);
  assert.equal(result.revision, 1);
  assert.deepEqual(await run("retry", args), result);
  const db = openFinalCatalogReadOnly(path);
  try {
    assert.equal(
      db.prepare("SELECT count(*) n FROM catalog_mutations").get().n,
      1,
    );
  } finally {
    db.close();
  }
});

test("external refresh publishes the complete scope or leaves stored inputs and previews unchanged", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  installEmptyFinalCatalog(db);
  try {
    const ids = [1, 2].map(
      (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    );
    for (const [i, id] of ids.entries()) {
      db.prepare(
        "INSERT INTO character_identities(id,creation_method) VALUES(?,'manual')",
      ).run(id);
      db.prepare(
        "INSERT INTO characters(id,rank,tie_order,favourites,likes_source,danbooru_post_count) VALUES(?,?,?,0,'generated',0)",
      ).run(id, i + 1, i + 1);
      db.prepare(
        "INSERT INTO tag_decisions VALUES(?,'approve',?,'manual','test')",
      ).run(id, `tag_${i}`);
    }
    const before = db.prepare("SELECT * FROM characters ORDER BY rank").all();
    const auth = { account: "operator", role: "admin" };
    const api = (fail) =>
      new DanbooruApi({
        gapMs: 0,
        fetchImpl: async (url) => {
          const name = url.searchParams.get("search[name]");
          if (name === "tag_1" && fail)
            return new Response("", {
              status: 503,
              headers: { "retry-after": "0.001" },
            });
          return new Response(
            JSON.stringify([
              {
                name,
                category: 4,
                post_count: name === "tag_0" ? 0 : 149200,
                is_deprecated: false,
              },
            ]),
          );
        },
      });
    await assert.rejects(
      previewRankingMaintenance(db, {
        ...auth,
        refresh: true,
        api: api(true),
        now: 1000,
      }),
      /503/,
    );
    assert.deepEqual(
      db.prepare("SELECT * FROM characters ORDER BY rank").all(),
      before,
    );
    assert.equal(
      db.prepare("SELECT count(*) n FROM catalog_previews").get().n,
      0,
    );
    const p = await previewRankingMaintenance(db, {
      ...auth,
      refresh: true,
      api: api(false),
      now: 1000,
    });
    assert.deepEqual(
      db.prepare("SELECT * FROM characters ORDER BY rank").all(),
      before,
    );
    confirmRankingMaintenance(db, {
      ...auth,
      previewId: p.previewId,
      payloadHash: p.payloadHash,
      idempotencyKey: "refresh",
      now: 1001,
    });
    assert.deepEqual(
      db
        .prepare("SELECT id,efficiency FROM characters ORDER BY rank")
        .all()
        .map((row) => ({ ...row })),
      [
        { id: ids[1], efficiency: 0.5 },
        { id: ids[0], efficiency: 0 },
      ],
    );
  } finally {
    db.close();
  }
});
