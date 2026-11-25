import { randomUUID } from "node:crypto";
import {
  createCharacterId,
  normalizeAniListCharacterId,
} from "./characterIdentity.js";
import { hasCharacterRanking } from "./catalogFinalSchema.js";
import { projectCharacterRanking } from "./catalogRanking.js";

const BINDING_KEY = "character_import_source_token";
const GENERATION_KEY = "character_import_scan_generation";
const RESTART =
  "Character import source binding is missing or stale. Discard staging and restart discovery with --restart (and --permission-confirmed); do not resume this scan.";

/** Untyped legacy schemas have no mutable source-revision contract. */
export function sourceCatalogRevisionToken(db) {
  if (
    !db
      .prepare(
        "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='catalog_state'",
      )
      .get()
  )
    return null;
  const state = db
    .prepare("SELECT source_revision FROM catalog_state WHERE singleton=1")
    .get();
  if (
    !state ||
    !Number.isSafeInteger(state.source_revision) ||
    state.source_revision < 0
  )
    throw new Error("Invalid source revision");
  return `source:${state.source_revision}`;
}

/** Bind only empty staging, inside the same write transaction as its reset.
 * Never adopt already collected rows into a newer revision. */
export function bindSourceCatalogStaging(
  db,
  expectedToken = sourceCatalogRevisionToken(db),
) {
  if (!db.isTransaction)
    throw new Error("Source staging binding requires a write transaction");
  if (db.prepare("SELECT 1 FROM stage_characters LIMIT 1").get())
    throw new Error(RESTART);
  const token = sourceCatalogRevisionToken(db);
  if (token !== expectedToken) throw new Error(RESTART);
  db.prepare("DELETE FROM catalog_meta WHERE key=?").run(BINDING_KEY);
  if (token !== null)
    db.prepare("INSERT INTO catalog_meta(key,value) VALUES(?,?)").run(
      BINDING_KEY,
      token,
    );
  db.prepare(
    "INSERT INTO catalog_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(GENERATION_KEY, randomUUID());
  return assertSourceCatalogStagingBinding(db);
}

/** Capture once per invocation/request; pass that exact binding at write boundaries.
 * Only untyped legacy fixtures may operate without a saved binding. Never create
 * a generation implicitly when resuming or validating existing staging. */
export function assertSourceCatalogStagingBinding(db, expected) {
  const token = sourceCatalogRevisionToken(db);
  const savedToken =
    db.prepare("SELECT value FROM catalog_meta WHERE key=?").get(BINDING_KEY)
      ?.value ?? null;
  const generation =
    db.prepare("SELECT value FROM catalog_meta WHERE key=?").get(GENERATION_KEY)
      ?.value ?? null;
  if (
    (token !== null && (savedToken !== token || !generation)) ||
    (expected !== undefined &&
      (expected.token !== token || expected.generation !== generation))
  ) {
    throw new Error(RESTART);
  }
  return { token, generation };
}

const FIELDS = [
  "name_full",
  "name_native",
  "name_alternatives",
  "gender",
  "age",
  "date_of_birth",
  "description",
  "image_url",
  "site_url",
  "anime_titles",
  "anime_ids",
  "anime_adult",
];

/** UUID-schema publisher. Network hydration must finish before entering this transaction.
 * Existing ranks/tie_order, never UUID lexical order, define the prior tie order.
 * Caller must supply BEGIN IMMEDIATE/rollback/commit; catalogDb owns that boundary.
 */
export function publishSourceCatalog(db, expectedBinding) {
  if (!db.isTransaction)
    throw new Error("Source publication requires a write transaction");
  assertSourceCatalogStagingBinding(db, expectedBinding);
  const ranked = hasCharacterRanking(db);
  const scanMode = db
    .prepare("SELECT value FROM catalog_meta WHERE key='scan_mode'")
    .get()?.value;
  if (ranked && scanMode && scanMode !== "growing")
    throw new Error(
      "Legacy favourites-limited scan requires explicit --restart in growing mode",
    );
  const current = db
    .prepare(
      "SELECT c.*, i.creation_method FROM characters c JOIN character_identities i ON i.id=c.id ORDER BY c.rank",
    )
    .all();
  if (
    current.length !==
    Number(db.prepare("SELECT count(*) AS n FROM characters").get().n)
  )
    throw new Error("Missing character identity");
  const byId = new Map(current.map((row) => [row.id, row]));
  const bySource = new Map(
    db
      .prepare(
        "SELECT character_id,external_id FROM character_sources WHERE source='anilist'",
      )
      .all()
      .map((row) => [row.external_id, row.character_id]),
  );
  const identity = db.prepare(
    "SELECT creation_method FROM character_identities WHERE id=?",
  );
  const link = db.prepare(
    "INSERT INTO character_sources (character_id,source,external_id) VALUES (?,'anilist',?)",
  );
  const addIdentity = db.prepare(
    "INSERT INTO character_identities (id,name_full,image_url,creation_method) VALUES (?,?,?,'imported')",
  );
  const updateIdentity = db.prepare(
    "UPDATE character_identities SET name_full=?,image_url=? WHERE id=?",
  );
  const incoming = db
    .prepare("SELECT * FROM stage_characters ORDER BY id")
    .all();
  let next = [...current];
  let nextOrder = current.reduce(
    (max, row) => Math.max(max, row.tie_order ?? row.rank),
    0,
  );
  if (!Number.isSafeInteger(nextOrder + incoming.length + 1))
    throw new Error("Catalog tie order overflow");
  for (const sourceRow of incoming) {
    const externalId = normalizeAniListCharacterId(sourceRow.id);
    if (!Number.isSafeInteger(sourceRow.favourites) || sourceRow.favourites < 0)
      throw new Error("Invalid source likes");
    let id = bySource.get(externalId);
    let record = id ? identity.get(id) : null;
    if (id && !record)
      throw new Error("Source mapping points to missing identity");
    let row = id ? byId.get(id) : null;
    if (!row && sourceRow.name_full == null)
      throw new Error("Cannot publish incomplete catalog metadata");
    if (!id) {
      id = createCharacterId();
      addIdentity.run(id, sourceRow.name_full, sourceRow.image_url);
      link.run(id, externalId);
      record = { creation_method: "imported" };
    }
    if (!row) {
      row = {
        id,
        rank: 0,
        favourites: sourceRow.favourites,
        likes_source: "anilist",
        tie_order: ++nextOrder,
        creation_method: record.creation_method,
      };
      if (ranked)
        Object.assign(row, {
          legacy_rank: null,
          danbooru_post_count: null,
          mudae_claim_rank: null,
          efficiency: 0,
          mudae_character_url: null,
        });
      for (const field of FIELDS) row[field] = sourceRow[field];
      next.push(row);
      byId.set(id, row);
    } else {
      // Linked manually created metadata remains curated independently of likes.
      if (record.creation_method !== "manual" && sourceRow.name_full != null) {
        for (const field of FIELDS) row[field] = sourceRow[field];
      }
      if (row.likes_source === "anilist") row.favourites = sourceRow.favourites;
    }
    if (
      record.creation_method !== "manual" &&
      sourceRow.name_full != null &&
      db
        .prepare(
          "SELECT 1 FROM sqlite_schema WHERE name='character_gender_overrides'",
        )
        .get()
    ) {
      const override = db
        .prepare(
          "SELECT gender FROM character_gender_overrides WHERE character_id=?",
        )
        .get(id);
      if (override) {
        db.prepare(
          "UPDATE character_gender_overrides SET source_gender=? WHERE character_id=?",
        ).run(sourceRow.gender, id);
        row.gender = override.gender;
      }
    }
    if (record.creation_method !== "manual")
      updateIdentity.run(row.name_full, row.image_url, id);
  }
  if (ranked) next = projectCharacterRanking(next);
  else
    next.sort(
      (a, b) =>
        b.favourites - a.favourites ||
        (a.tie_order ?? a.rank) - (b.tie_order ?? b.rank),
    );
  const maxRank = current.reduce((max, row) => Math.max(max, row.rank), 0);
  const offset = maxRank + next.length + 1;
  if (!Number.isSafeInteger(maxRank + offset))
    throw new Error("Catalog rank overflow");
  db.prepare("UPDATE characters SET rank=rank+?").run(offset);
  // Existing tie_order is not rewritten: it is a durable secondary ordering key.
  const columns = [
    "id",
    "rank",
    "favourites",
    ...FIELDS,
    "likes_source",
    "tie_order",
    ...(ranked
      ? [
          "legacy_rank",
          "danbooru_post_count",
          "mudae_claim_rank",
          "efficiency",
          "mudae_character_url",
        ]
      : []),
  ];
  const statement =
    db.prepare(`INSERT INTO characters (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})
    ON CONFLICT(id) DO UPDATE SET ${columns
      .filter((key) => key !== "id")
      .map((key) => `${key}=excluded.${key}`)
      .join(",")}`);
  next.forEach((row, index) => {
    row.rank = index + 1;
    row.tie_order ??= row.rank;
    statement.run(...columns.map((field) => row[field] ?? null));
  });
  db.exec("DELETE FROM tag_candidates; DELETE FROM tag_match_progress");
  const hasState = Boolean(
    db
      .prepare(
        "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='catalog_state'",
      )
      .get(),
  );
  // Release-schema previews bind the typed revision, not just legacy metadata.
  // Advance it in the same transaction as publication so an import invalidates
  // previews created in another process.
  const state = hasState
    ? db
        .prepare(
          "SELECT revision, source_revision FROM catalog_state WHERE singleton=1",
        )
        .get()
    : null;
  if (hasState && !state) throw new Error("Missing catalog state");
  const revisionValue =
    state?.revision ??
    db
      .prepare("SELECT value FROM catalog_meta WHERE key='catalog_revision'")
      .get()?.value ??
    "0";
  const revision = Number(revisionValue);
  if (
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    revision === Number.MAX_SAFE_INTEGER
  )
    throw new Error("Invalid catalog revision");
  const meta = db.prepare(
    "INSERT INTO catalog_meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  );
  if (hasState) {
    if (
      !Number.isSafeInteger(state.source_revision) ||
      state.source_revision < 0 ||
      state.source_revision === Number.MAX_SAFE_INTEGER
    )
      throw new Error("Invalid source revision");
    db.prepare(
      "UPDATE catalog_state SET revision=?, source_revision=? WHERE singleton=1",
    ).run(revision + 1, state.source_revision + 1);
    // Publication itself advances the source revision. Keep this same staging
    // reusable, without accepting any intervening source correction/unlink.
    meta.run(BINDING_KEY, `source:${state.source_revision + 1}`);
  }
  meta.run("catalog_revision", String(revision + 1));
  meta.run("published_at", new Date().toISOString());
  return next.length;
}
