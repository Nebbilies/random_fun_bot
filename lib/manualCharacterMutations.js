import { randomUUID } from 'node:crypto';
import { validateManualCharacter } from './manualCharacterValidation.js';
import { previewRankInsertion, insertAtRank } from './catalogRanking.js';
import { canonicalCatalogValue as canonical, hashCatalogPayload as hash,
  validateCatalogTimestamp as time, catalogMutationTransaction as transaction,
  catalogMutationState as state, publishCatalogMutationRevision, confirmCatalogPreview } from './catalogMutationProtocol.js';

// Partial release service: explicit v12 connections only, not a startup migration or portal API.
export const MANUAL_CHARACTER_PREVIEW_TTL_MS = 10 * 60 * 1000;
const MAX = Number.MAX_SAFE_INTEGER;
const OPERATION = 'create';
const INPUT_FIELDS = new Set(['name', 'aliases', 'gender', 'franchiseIds', 'portraitUrl', 'referenceUrl', 'description']);
const normalize = value => String(value ?? '').normalize('NFKC').toLocaleLowerCase('en-US').trim().replace(/\s+/g, ' ');

function bounded(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value.trim();
}
function authorize(account, role) {
  if (!['admin', 'moderator'].includes(role)) throw new Error('Unauthorized catalog role');
  return bounded(account, 'account', 120);
}
function validateInput(input) {
  if (input && typeof input === 'object') {
    for (const key of Object.keys(input)) {
      if (!INPUT_FIELDS.has(key)) throw new Error(`Unsupported character field: ${key} (tags are not supported)`);
    }
  }
  return validateManualCharacter(input);
}
function requireFranchises(db, input) {
  const exists = db.prepare('SELECT 1 FROM franchises WHERE id=?');
  for (const id of input.franchiseIds) if (!exists.get(id)) throw new Error(`Unknown franchise: ${id}`);
}
const characters = db => db.prepare('SELECT * FROM characters ORDER BY rank').all();
function duplicates(db, input, rows) {
  const names = new Set([input.name, ...input.aliases].map(normalize));
  const curated = new Map();
  for (const row of db.prepare('SELECT character_id, alias FROM character_curated_aliases').all()) {
    if (!curated.has(row.character_id)) curated.set(row.character_id, []);
    curated.get(row.character_id).push(row.alias);
  }
  return rows.filter(row => [row.name_full, row.name_native, ...JSON.parse(row.name_alternatives ?? '[]'),
    ...(curated.get(row.id) ?? [])].some(name => name && names.has(normalize(name)))).map(row => ({
    id: row.id, name: row.name_full, portraitUrl: row.image_url,
    sources: db.prepare('SELECT source, external_id FROM character_sources WHERE character_id=? ORDER BY source, external_id').all(row.id),
    franchiseIds: db.prepare('SELECT franchise_id FROM effective_character_franchises WHERE character_id=? ORDER BY franchise_id').all(row.id).map(item => item.franchise_id),
  }));
}

/**
 * Validate metadata, calculate rank/likes and persist a revision-bound preview.
 * now is epoch milliseconds. Duplicate warnings are returned even without a reason;
 * confirmation requires a nonempty reason in the preview payload if warnings exist.
 */
export function previewManualCharacterCreation(db, { account, role, input, rank, duplicateOverrideReason, now = Date.now() }) {
  account = authorize(account, role);
  time(now);
  if (!Number.isSafeInteger(now + MANUAL_CHARACTER_PREVIEW_TTL_MS)) throw new Error('Preview expiry overflow');
  const validated = validateInput(input);
  const reason = duplicateOverrideReason == null ? null : bounded(duplicateOverrideReason, 'duplicate override reason', 2000);
  const payload = { operation: OPERATION, input: validated, rank, duplicateOverrideReason: reason };
  return transaction(db, () => {
    requireFranchises(db, validated);
    const rows = characters(db);
    const insertion = previewRankInsertion(rows, rank);
    const revisions = state(db);
    const warnings = duplicates(db, validated, rows);
    const previewId = randomUUID();
    const payloadHash = hash(payload);
    const expiresAt = now + MANUAL_CHARACTER_PREVIEW_TTL_MS;
    db.prepare(`INSERT INTO catalog_previews
      (id, account, role, operation, payload_hash, payload_json, revision, source_revision, appearance_revision, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(previewId, account, role, OPERATION, payloadHash, canonical(payload),
      revisions.revision, revisions.source_revision, revisions.appearance_revision, now, expiresAt);
    return { previewId, payloadHash, expiresAt, ...revisions, ...insertion, count: rows.length,
      neighbors: { upper: rows[rank - 2] ?? null, lower: rows[rank - 1] ?? null }, duplicateWarnings: warnings };
  });
}

function offsetOrders(db, rows, finalCount) {
  const maxRank = rows.reduce((max, row) => Math.max(max, row.rank), 0);
  const maxTie = rows.reduce((max, row) => Math.max(max, row.tie_order), 0);
  if (rows.some(row => !Number.isSafeInteger(row.rank) || row.rank < 1
    || !Number.isSafeInteger(row.tie_order) || row.tie_order < 1)) throw new Error('Invalid catalog order');
  // All temporary values exceed both old and final ranges. Separate offsets for
  // both UNIQUE columns avoid row-by-row uniqueness collisions in either phase.
  const rankOffset = Math.max(maxRank, finalCount) + 1;
  const tieOffset = Math.max(maxTie, finalCount) + 1;
  if (![rankOffset, tieOffset, maxRank + rankOffset, maxTie + tieOffset].every(Number.isSafeInteger)) {
    throw new Error('Catalog order overflow');
  }
  db.prepare('UPDATE characters SET rank=rank+?, tie_order=tie_order+?').run(rankOffset, tieOffset);
}
function snapshot(db, id, reason) {
  return {
    character: db.prepare('SELECT * FROM characters WHERE id=?').get(id),
    identity: db.prepare('SELECT * FROM character_identities WHERE id=?').get(id),
    aliases: db.prepare('SELECT alias, normalized_alias FROM character_curated_aliases WHERE character_id=? ORDER BY normalized_alias').all(id),
    memberships: db.prepare('SELECT franchise_id FROM character_franchise_memberships WHERE character_id=? ORDER BY franchise_id').all(id),
    curation: db.prepare('SELECT reference_url FROM character_curation WHERE character_id=?').get(id),
    sources: db.prepare('SELECT source, external_id FROM character_sources WHERE character_id=? ORDER BY source').all(id),
    duplicateOverrideReason: reason,
  };
}

/** Serialized atomic publication. A committed retry is resolved before preview expiry/revision checks. */
export function confirmManualCharacterCreation(db, { account, role, previewId, idempotencyKey, payloadHash, now = Date.now() }) {
  account = authorize(account, role);
  bounded(previewId, 'preview ID', 100);
  idempotencyKey = bounded(idempotencyKey, 'idempotency key', 200);
  if (typeof payloadHash !== 'string' || !/^[0-9a-f]{64}$/.test(payloadHash)) throw new Error('Invalid payload hash');
  time(now);
  return confirmCatalogPreview(db, { account, role, previewId, idempotencyKey, payloadHash, now }, [OPERATION], ({ payload, revisions }) => {
    if (revisions.revision === MAX || revisions.appearance_revision === MAX) throw new Error('Catalog revision overflow');
    const input = validateInput(payload.input);
    const reason = payload.duplicateOverrideReason === null ? null : bounded(payload.duplicateOverrideReason, 'duplicate override reason', 2000);
    requireFranchises(db, input);
    const rows = characters(db);
    const insertion = previewRankInsertion(rows, payload.rank);
    if (duplicates(db, input, rows).length && reason === null) throw new Error('Duplicate warnings require an explicit override reason');
    const id = randomUUID();
    const next = insertAtRank(rows, { id, rank: insertion.rank });
    offsetOrders(db, rows, next.length);
    db.prepare("INSERT INTO character_identities (id, name_full, image_url, creation_method) VALUES (?, ?, ?, 'manual')").run(id, input.name, input.portraitUrl);
    const gender = { female: 'Female', male: 'Male', nonbinary: 'Non-binary', unknown: null }[input.gender];
    db.prepare(`INSERT INTO characters (id, rank, favourites, name_full, name_native, name_alternatives, gender,
      age, date_of_birth, description, image_url, site_url, anime_titles, anime_ids, anime_adult, likes_source, tie_order)
      VALUES (?, ?, ?, ?, NULL, '[]', ?, NULL, NULL, ?, ?, NULL, '[]', '[]', 0, 'generated', ?)`)
      .run(id, insertion.rank, insertion.favourites, input.name, gender, input.description, input.portraitUrl, insertion.rank);
    const assign = db.prepare('UPDATE characters SET rank=?, tie_order=? WHERE id=?');
    for (const row of next) if (row.id !== id) assign.run(row.rank, row.tieOrder, row.id);
    const alias = db.prepare('INSERT INTO character_curated_aliases (character_id, alias, normalized_alias) VALUES (?, ?, ?)');
    const seen = new Set();
    for (const value of input.aliases) {
      const normalized = normalize(value);
      if (!seen.has(normalized)) alias.run(id, value, normalized);
      seen.add(normalized);
    }
    for (const franchiseId of input.franchiseIds) db.prepare('INSERT INTO character_franchise_memberships VALUES (?, ?)').run(id, franchiseId);
    db.prepare('INSERT INTO character_curation (character_id, reference_url) VALUES (?, ?)').run(id, input.referenceUrl);
    const { revision } = publishCatalogMutationRevision(db, revisions, { appearanceChanged: true }, now);
    const after = snapshot(db, id, reason);
    return { characterId: id, before: {}, after, duplicateOverrideReason: reason,
      result: { characterId: id, revision, rank: insertion.rank, favourites: insertion.favourites, likesSource: 'generated' } };
  });
}
