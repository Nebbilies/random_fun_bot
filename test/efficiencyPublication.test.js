import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  installEmptyFinalCatalog,
  validateFinalCatalogSchema,
} from "../lib/catalogFinalSchema.js";
import {
  previewManualCharacterCreation,
  confirmManualCharacterCreation,
} from "../lib/manualCharacterMutations.js";
import {
  previewCatalogMutation,
  confirmCatalogMutation,
} from "../lib/catalogMutations.js";
import { DanbooruApi } from "../lib/danbooruApi.js";
import { publishCatalog } from "../lib/catalogDb.js";
import { bindSourceCatalogStaging } from "../lib/sourceCatalogPublication.js";
const auth = { account: "operator", role: "admin" };
function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  installEmptyFinalCatalog(db);
  db.exec(
    "INSERT INTO franchises(id,display_name,created_at) VALUES(1,'Series','test')",
  );
  return db;
}
const input = {
  name: "Example",
  gender: "female",
  portraitUrl: "https://example.test/image",
  franchiseIds: [1],
  mainFranchiseIds: [1],
  tagName: null,
};
test("creation previews mint the final UUID and publish derived ranks without manual rank input", () => {
  const db = fixture();
  try {
    assert.throws(
      () => previewManualCharacterCreation(db, { ...auth, input, rank: 1 }),
      /derived/,
    );
    const p = previewManualCharacterCreation(db, { ...auth, input, now: 1000 });
    const result = confirmManualCharacterCreation(db, {
      ...auth,
      previewId: p.previewId,
      payloadHash: p.payloadHash,
      idempotencyKey: "one",
      now: 1001,
    });
    assert.equal(result.characterId, p.characterId);
    assert.equal(result.rank, 1);
    assert.equal(
      db.prepare("SELECT legacy_rank FROM characters").get().legacy_rank,
      null,
    );
    assert.deepEqual(
      db
        .prepare(
          "SELECT franchise_id FROM character_main_franchises WHERE character_id=?",
        )
        .all(result.characterId)
        .map((row) => row.franchise_id),
      [1],
    );
    assert.equal(validateFinalCatalogSchema(db, { readOnly: false }), true);
    assert.throws(
      () =>
        previewCatalogMutation(db, {
          ...auth,
          operation: "reposition",
          input: { characterId: result.characterId, rank: 2 },
        }),
      /derived/,
    );
  } finally {
    db.close();
  }
});

test("AniList publication preserves existing ranking inputs and publishes discoveries with zero and no archive", () => {
  const db = fixture();
  const id = "00000000-0000-4000-8000-000000000001";
  try {
    db.prepare(
      "INSERT INTO character_identities(id,creation_method) VALUES(?,'imported')",
    ).run(id);
    db.prepare("INSERT INTO character_sources VALUES('anilist','1',?)").run(id);
    db.prepare(
      "INSERT INTO characters(id,rank,tie_order,favourites,legacy_rank,danbooru_post_count,efficiency,name_full) VALUES(?,1,1,99,8,149200,0.5,?)",
    ).run(id, "Original");
    db.prepare("INSERT INTO character_main_franchises VALUES (?,1)").run(id);
    db.prepare(
      "INSERT INTO tag_decisions VALUES(?,'approve','series','manual','test')",
    ).run(id);
    db.exec("BEGIN IMMEDIATE");
    bindSourceCatalogStaging(db);
    db.exec(
      "INSERT INTO stage_characters(id,favourites,name_full) VALUES(1,0,'Refreshed'),(2,99999,'Discovery'); COMMIT",
    );
    assert.equal(publishCatalog(db), 2);
    const rows = db
      .prepare(
        "SELECT id,rank,legacy_rank,danbooru_post_count,mudae_claim_rank,efficiency FROM characters ORDER BY rank",
      )
      .all();
    assert.deepEqual(
      { ...rows[0] },
      {
        id,
        rank: 1,
        legacy_rank: 8,
        danbooru_post_count: 149200,
        mudae_claim_rank: null,
        efficiency: 0.5,
      },
    );
    assert.deepEqual(
      { ...rows[1], id: null },
      {
        id: null,
        rank: 2,
        legacy_rank: null,
        danbooru_post_count: null,
        mudae_claim_rank: null,
        efficiency: 0,
      },
    );
    assert.deepEqual(
      db
        .prepare(
          "SELECT character_id, franchise_id FROM character_main_franchises",
        )
        .all()
        .map((row) => [row.character_id, row.franchise_id]),
      [[id, 1]],
    );
    assert.equal(validateFinalCatalogSchema(db), true);
  } finally {
    db.close();
  }
});

test("URL-only edits retain inputs, scores, positions and source revisions", () => {
  const db = fixture();
  try {
    const p = previewManualCharacterCreation(db, { ...auth, input, now: 1000 });
    const created = confirmManualCharacterCreation(db, {
      ...auth,
      previewId: p.previewId,
      payloadHash: p.payloadHash,
      idempotencyKey: "create",
      now: 1001,
    });
    const before = db.prepare("SELECT * FROM catalog_state").get();
    const edit = previewCatalogMutation(db, {
      ...auth,
      operation: "edit",
      input: {
        characterId: created.characterId,
        mudaeCharacterUrl: "https://mudae.net/character/1/reference",
      },
      now: 1002,
    });
    confirmCatalogMutation(db, {
      ...auth,
      previewId: edit.previewId,
      payloadHash: edit.payloadHash,
      idempotencyKey: "url",
      now: 1003,
    });
    const after = db.prepare("SELECT * FROM catalog_state").get();
    assert.equal(after.revision, before.revision + 1);
    assert.equal(after.source_revision, before.source_revision);
    assert.equal(after.appearance_revision, before.appearance_revision);
    assert.deepEqual(
      {
        ...db
          .prepare(
            "SELECT rank,legacy_rank,efficiency,danbooru_post_count,mudae_claim_rank FROM characters",
          )
          .get(),
      },
      {
        rank: 1,
        legacy_rank: null,
        efficiency: 0,
        danbooru_post_count: null,
        mudae_claim_rank: null,
      },
    );
    assert.equal(
      db.prepare("SELECT mudae_character_url FROM characters").get()
        .mudae_character_url,
      "https://mudae.net/character/1/reference",
    );
  } finally {
    db.close();
  }
});
test("copyright evidence is captured in preview and confirmation atomically publishes count and rank", async () => {
  const db = fixture();
  try {
    const api = new DanbooruApi({
      gapMs: 0,
      fetchImpl: async () =>
        new Response(
          JSON.stringify([
            {
              name: "series",
              category: 3,
              post_count: 149200,
              is_deprecated: false,
            },
          ]),
        ),
    });
    const evidence = await api.verifyRankingTag("series");
    const p = previewManualCharacterCreation(db, {
      ...auth,
      input: { ...input, tagName: "series", mudaeClaimRank: 1 },
      tagEvidence: evidence,
      now: 1000,
    });
    assert.match(p.warning, /franchise-wide/);
    assert.equal(p.efficiency, 2);
    const result = confirmManualCharacterCreation(db, {
      ...auth,
      previewId: p.previewId,
      payloadHash: p.payloadHash,
      idempotencyKey: "one",
      now: 1001,
    });
    const edit = previewCatalogMutation(db, {
      ...auth,
      operation: "ranking",
      input: {
        characterId: result.characterId,
        tagName: null,
        mudaeClaimRank: null,
      },
      now: 1002,
    });
    confirmCatalogMutation(db, {
      ...auth,
      previewId: edit.previewId,
      payloadHash: edit.payloadHash,
      idempotencyKey: "two",
      now: 1003,
    });
    assert.equal(
      db.prepare("SELECT efficiency FROM characters").get().efficiency,
      0,
    );
    assert.equal(validateFinalCatalogSchema(db, { readOnly: false }), true);
  } finally {
    db.close();
  }
});
