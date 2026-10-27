import { randomUUID } from 'node:crypto';
import { isCharacterId } from './characterIdentity.js';
import { validateManualCharacter } from './manualCharacterValidation.js';
import { previewRankInsertion, insertAtRank } from './catalogRanking.js';
import { canonicalCatalogValue as canonical, hashCatalogPayload as hash,
  validateCatalogTimestamp as time, catalogMutationTransaction as transaction,
  catalogMutationState as state, publishCatalogMutationRevision, confirmCatalogPreview } from './catalogMutationProtocol.js';

export const CATALOG_PREVIEW_TTL_MS = 10 * 60 * 1000;
const MAX = Number.MAX_SAFE_INTEGER;
const normalize = value => value.normalize('NFKC').toLocaleLowerCase('en-US').trim().replace(/\s+/g, ' ');
function fields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected input object');
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unknown field: ${key}`);
}
function text(value, label, max = 120, optional = false) {
  if (optional && value === null) return null;
  if (typeof value !== 'string') throw new Error(`Invalid ${label}`);
  const result = value.normalize('NFKC').trim();
  if (!result || result.length > max || /[\u0000-\u001f\u007f]/.test(result)) throw new Error(`Invalid ${label}`);
  return result;
}
function url(value, label) {
  if (value === null) return null;
  const result = text(value, label, 2048);
  let parsed;
  try { parsed = new URL(result); } catch { throw new Error(`Invalid ${label}`); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error(`Invalid ${label}: HTTPS without credentials required`);
  return parsed.href;
}
function aliases(values) {
  if (!Array.isArray(values) || values.length > 50) throw new Error('Invalid aliases');
  const result = new Map();
  for (const value of values) { const alias = text(value, 'alias'); result.set(normalize(alias), alias); }
  return [...result.values()];
}
function positive(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${label}`);
  return value;
}
function authorize(account, role) {
  if (!['admin', 'moderator'].includes(role)) throw new Error('Unauthorized catalog role');
  return text(account, 'account');
}
const rows = db => db.prepare('SELECT * FROM characters ORDER BY rank').all();
function character(db, id) {
  if (!isCharacterId(id) || id !== id.toLowerCase()) throw new Error('Invalid character ID');
  const row = db.prepare('SELECT c.*, i.creation_method FROM characters c JOIN character_identities i ON i.id=c.id WHERE c.id=?').get(id);
  if (!row) throw new Error('Unknown character');
  return row;
}
function franchise(db, id) {
  positive(id, 'franchise ID');
  if (!db.prepare('SELECT 1 FROM franchises WHERE id=?').get(id)) throw new Error(`Unknown franchise: ${id}`);
}
function memberships(db, values) {
  if (!Array.isArray(values)) throw new Error('Invalid franchiseIds');
  for (const id of values) franchise(db, id);
  return [...new Set(values)].sort((a, b) => a - b);
}
const direct = (db, id) => db.prepare('SELECT franchise_id FROM character_franchise_memberships WHERE character_id=? ORDER BY franchise_id').all(id).map(row => row.franchise_id);
const effective = db => canonical(db.prepare('SELECT character_id, franchise_id FROM effective_character_franchises ORDER BY character_id, franchise_id').all());
function requireApprovedTag(db, tagName) {
  // The existing bounded exact-tag approval path populates this cache before calling
  // the service. Do not accept syntax alone as evidence of an active character tag,
  // and never fetch remote data while holding the publication lock.
  const params = new URLSearchParams({ 'search[name]': tagName, 'search[category]': '4', limit: '5' });
  const cached = db.prepare('SELECT response FROM tag_search_cache WHERE query=?').get(`/tags.json?${params}`);
  let tags;
  try { tags = JSON.parse(cached?.response ?? 'null'); } catch { /* reject malformed cache */ }
  if (!Array.isArray(tags) || !tags.some(tag => tag && tag.name === tagName && tag.category === 4 && !tag.is_deprecated)) {
    throw new Error('Tag must be verified by the existing exact-tag approval path');
  }
}
function validate(db, operation, input) {
  let out;
  if (operation === 'edit') {
    fields(input, ['characterId', 'name', 'aliases', 'gender', 'franchiseIds', 'portraitUrl', 'referenceUrl', 'description', 'duplicateOverrideReason']);
    const row = character(db, input.characterId);
    out = { ...input };
    const full = ['name', 'gender', 'portraitUrl', 'description'];
    if (row.creation_method !== 'manual' && full.some(key => Object.hasOwn(input, key))) throw new Error('Imported metadata cannot be overridden');
    if (row.creation_method === 'manual') {
      const oldGender = { Female: 'female', Male: 'male', 'Non-binary': 'nonbinary' }[row.gender] ?? 'unknown';
      // Reuse creation validation for metadata limits, including multi-line descriptions.
      const valid = validateManualCharacter({ name: row.name_full, gender: oldGender,
        portraitUrl: row.image_url, description: row.description, franchiseIds: [1],
        ...Object.fromEntries(Object.entries(input).filter(([key]) => full.includes(key))) });
      for (const key of full) if (Object.hasOwn(input, key)) out[key] = valid[key];
    }
    if (Object.hasOwn(input, 'aliases')) out.aliases = aliases(input.aliases);
    if (Object.hasOwn(input, 'franchiseIds')) out.franchiseIds = memberships(db, input.franchiseIds);
    if (row.creation_method === 'manual') {
      const selected = out.franchiseIds ?? direct(db, row.id);
      const derived = db.prepare(`SELECT 1 FROM character_anime ca JOIN franchise_anime fa ON fa.anime_id=ca.anime_id
        JOIN franchises f ON f.id=fa.franchise_id WHERE ca.character_id=? LIMIT 1`).get(row.id);
      if (!selected.length && !derived) throw new Error('Manual characters require at least one franchise');
    }
    if (Object.hasOwn(input, 'referenceUrl')) out.referenceUrl = url(input.referenceUrl, 'reference URL');
    if (Object.hasOwn(input, 'duplicateOverrideReason')) out.duplicateOverrideReason = text(input.duplicateOverrideReason, 'duplicate override reason', 2000, true);
    if (!Object.keys(input).some(key => !['characterId', 'duplicateOverrideReason'].includes(key))) throw new Error('Empty edit');
  } else if (operation === 'reposition') {
    fields(input, ['characterId', 'rank', 'switchToGenerated']);
    const row = character(db, input.characterId);
    if (Object.hasOwn(input, 'switchToGenerated') && typeof input.switchToGenerated !== 'boolean') throw new Error('Invalid switchToGenerated');
    if (row.likes_source === 'anilist' && input.switchToGenerated !== true) throw new Error('Explicit switchToGenerated confirmation required');
    previewRankInsertion(rows(db), input.rank, row.id);
    out = { ...input };
  } else if (operation === 'tag') {
    fields(input, ['characterId', 'status', 'tagName']);
    character(db, input.characterId);
    if (!['approve', 'no_match'].includes(input.status)) throw new Error('Invalid tag decision');
    if (input.status === 'approve' && (typeof input.tagName !== 'string' || !/^[a-z0-9_():.!-]{2,120}$/.test(input.tagName))) throw new Error('Invalid tag');
    if (input.status === 'no_match' && input.tagName != null) throw new Error('no_match cannot include a tag');
    if (input.status === 'approve') requireApprovedTag(db, input.tagName);
    out = { characterId: input.characterId, status: input.status, tagName: input.tagName ?? null };
  } else if (operation === 'franchise_create' || operation === 'franchise_edit') {
    fields(input, operation === 'franchise_create' ? ['displayName', 'aliases', 'coverUrl', 'referenceUrl']
      : ['franchiseId', 'displayName', 'aliases', 'coverUrl', 'referenceUrl']);
    if (operation === 'franchise_edit') franchise(db, input.franchiseId);
    out = { ...input };
    if (operation === 'franchise_create' || Object.hasOwn(input, 'displayName')) {
      out.displayName = text(input.displayName, 'franchise name');
      if (out.displayName.length < 2) throw new Error('Invalid franchise name');
    }
    if (Object.hasOwn(input, 'aliases')) {
      out.aliases = aliases(input.aliases);
      if (out.aliases.some(alias => alias.length < 2)) throw new Error('Invalid franchise alias');
    }
    if (Object.hasOwn(input, 'coverUrl')) out.coverUrl = url(input.coverUrl, 'cover URL');
    if (Object.hasOwn(input, 'referenceUrl')) out.referenceUrl = url(input.referenceUrl, 'reference URL');
    if (operation === 'franchise_edit' && Object.keys(input).length === 1) throw new Error('Empty edit');
  } else throw new Error(`Unsupported catalog operation: ${operation}`);
  return out;
}
function duplicateWarnings(db, operation, input) {
  if (operation !== 'edit' || !('name' in input || 'aliases' in input)) return [];
  const names = new Set([input.name, ...(input.aliases ?? [])].filter(Boolean).map(normalize));
  return rows(db).filter(row => row.id !== input.characterId && [row.name_full, row.name_native,
    ...JSON.parse(row.name_alternatives ?? '[]'), ...db.prepare('SELECT alias FROM character_curated_aliases WHERE character_id=?').all(row.id).map(a => a.alias)]
    .some(name => name && names.has(normalize(name)))).map(row => ({ id: row.id, name: row.name_full, portraitUrl: row.image_url,
    sources: db.prepare('SELECT source, external_id FROM character_sources WHERE character_id=? ORDER BY source').all(row.id),
    franchiseIds: db.prepare('SELECT franchise_id FROM effective_character_franchises WHERE character_id=? ORDER BY franchise_id').all(row.id).map(r => r.franchise_id) }));
}
function snapshot(db, input) {
  if (input.characterId) return {
    character: db.prepare('SELECT * FROM characters WHERE id=?').get(input.characterId),
    identity: db.prepare('SELECT * FROM character_identities WHERE id=?').get(input.characterId),
    aliases: db.prepare('SELECT * FROM character_curated_aliases WHERE character_id=? ORDER BY normalized_alias').all(input.characterId),
    memberships: direct(db, input.characterId),
    curation: db.prepare('SELECT * FROM character_curation WHERE character_id=?').get(input.characterId) ?? null,
    tag: db.prepare('SELECT * FROM tag_decisions WHERE character_id=?').get(input.characterId) ?? null,
  };
  return input.franchiseId ? {
    franchise: db.prepare('SELECT * FROM franchises WHERE id=?').get(input.franchiseId),
    aliases: db.prepare('SELECT * FROM franchise_aliases WHERE franchise_id=? ORDER BY normalized_alias').all(input.franchiseId),
  } : {};
}
function reposition(db, input) {
  const current = rows(db);
  const insertion = previewRankInsertion(current, input.rank, input.characterId);
  const next = insertAtRank(current, { id: input.characterId, rank: input.rank });
  const rankMax = current.reduce((max, row) => Math.max(max, row.rank), 0);
  const tieMax = current.reduce((max, row) => Math.max(max, row.tie_order), 0);
  const rankOffset = Math.max(rankMax, next.length) + 1;
  const tieOffset = Math.max(tieMax, next.length) + 1;
  if (current.some(row => !Number.isSafeInteger(row.rank) || row.rank < 1 || !Number.isSafeInteger(row.tie_order) || row.tie_order < 1)
    || ![rankOffset, tieOffset, rankMax + rankOffset, tieMax + tieOffset].every(Number.isSafeInteger)) throw new Error('Catalog order overflow');
  db.prepare('UPDATE characters SET rank=rank+?, tie_order=tie_order+?').run(rankOffset, tieOffset);
  const assign = db.prepare('UPDATE characters SET rank=?, tie_order=? WHERE id=?');
  for (const row of next) assign.run(row.rank, row.tieOrder, row.id);
  db.prepare("UPDATE characters SET favourites=?, likes_source='generated' WHERE id=?").run(insertion.favourites, input.characterId);
  return { rank: input.rank, favourites: insertion.favourites, likesSource: 'generated' };
}
function apply(db, operation, input, now) {
  if (operation === 'reposition') return reposition(db, input);
  if (operation === 'edit') {
    const columns = { name: 'name_full', portraitUrl: 'image_url', description: 'description', gender: 'gender' };
    for (const [key, column] of Object.entries(columns)) if (Object.hasOwn(input, key)) {
      const value = key === 'gender' ? { female: 'Female', male: 'Male', nonbinary: 'Non-binary', unknown: null }[input[key]] : input[key];
      db.prepare(`UPDATE characters SET ${column}=? WHERE id=?`).run(value, input.characterId);
      if (key === 'name' || key === 'portraitUrl') db.prepare(`UPDATE character_identities SET ${column}=? WHERE id=?`).run(value, input.characterId);
    }
    if ('aliases' in input) {
      db.prepare('DELETE FROM character_curated_aliases WHERE character_id=?').run(input.characterId);
      for (const alias of input.aliases) db.prepare('INSERT INTO character_curated_aliases VALUES (?, ?, ?)').run(input.characterId, alias, normalize(alias));
    }
    if ('franchiseIds' in input) {
      db.prepare('DELETE FROM character_franchise_memberships WHERE character_id=?').run(input.characterId);
      for (const id of input.franchiseIds) db.prepare('INSERT INTO character_franchise_memberships VALUES (?, ?)').run(input.characterId, id);
    }
    if ('referenceUrl' in input) db.prepare(`INSERT INTO character_curation VALUES (?, ?) ON CONFLICT(character_id)
      DO UPDATE SET reference_url=excluded.reference_url`).run(input.characterId, input.referenceUrl);
  } else if (operation === 'tag') {
    db.prepare(`INSERT INTO tag_decisions (character_id,status,tag_name,source,updated_at) VALUES (?, ?, ?, 'manual', ?)
      ON CONFLICT(character_id) DO UPDATE SET status=excluded.status,tag_name=excluded.tag_name,source=excluded.source,updated_at=excluded.updated_at`)
      .run(input.characterId, input.status, input.tagName, new Date(now).toISOString());
  } else {
    if (operation === 'franchise_create') input.franchiseId = Number(db.prepare(`INSERT INTO franchises
      (display_name,name_source,created_at,curated_cover_url,reference_url) VALUES (?, 'manual', ?, ?, ?)`)
      .run(input.displayName, new Date(now).toISOString(), input.coverUrl ?? null, input.referenceUrl ?? null).lastInsertRowid);
    else {
      for (const [key, column] of Object.entries({ displayName: 'display_name', coverUrl: 'curated_cover_url', referenceUrl: 'reference_url' }))
        if (key in input) db.prepare(`UPDATE franchises SET ${column}=? WHERE id=?`).run(input[key], input.franchiseId);
      if ('displayName' in input) db.prepare("UPDATE franchises SET name_source='manual' WHERE id=?").run(input.franchiseId);
    }
    // Replace only curated aliases; source-managed aliases survive portal edits.
    if ('aliases' in input) db.prepare("DELETE FROM franchise_aliases WHERE franchise_id=? AND source='manual'").run(input.franchiseId);
    for (const alias of [...(input.aliases ?? []), ...(input.displayName ? [input.displayName] : [])]) db.prepare(`INSERT INTO franchise_aliases
      (franchise_id,alias,normalized_alias,source) VALUES (?, ?, ?, 'manual') ON CONFLICT(franchise_id,normalized_alias)
      DO UPDATE SET alias=excluded.alias`).run(input.franchiseId, alias, normalize(alias));
    return { franchiseId: input.franchiseId };
  }
  return {};
}

/**
 * Operations/input (patch semantics for edit; arrays replace curated values):
 * edit: {characterId, name?, gender?, portraitUrl?, description?, aliases?, franchiseIds?, referenceUrl?, duplicateOverrideReason?}
 * reposition: {characterId, rank, switchToGenerated?} (required true for AniList-managed likes).
 * tag: {characterId, status: 'approve'|'no_match', tagName?}; approval requires an active category-4
 * exact-tag result in tag_search_cache (populate via the existing DanbooruApi.exactTag path outside this service).
 * franchise_create: {displayName, aliases?, coverUrl?, referenceUrl?}; franchise_edit: {franchiseId, ...patch}.
 * Nullable optional URLs clear values. No source lookups, image fetching, free-form likes or implicit metadata overrides.
 * now is epoch milliseconds; preview writes only a durable, account/role/revision-bound preview.
 */
export function previewCatalogMutation(db, options) {
  fields(options, ['account', 'role', 'operation', 'input', 'now']);
  const { role, operation, input, now = Date.now() } = options;
  const account = authorize(options.account, role);
  time(now);
  if (!Number.isSafeInteger(now + CATALOG_PREVIEW_TTL_MS)) throw new Error('Preview expiry overflow');
  return transaction(db, () => {
    const validated = validate(db, operation, input);
    const revisions = state(db);
    const payload = { operation, input: validated };
    const payloadHash = hash(payload);
    const previewId = randomUUID();
    const expiresAt = now + CATALOG_PREVIEW_TTL_MS;
    db.prepare(`INSERT INTO catalog_previews VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(previewId, account, role, operation, payloadHash, canonical(payload), revisions.revision, revisions.source_revision, revisions.appearance_revision, now, expiresAt);
    const impact = operation === 'reposition' ? previewRankInsertion(rows(db), validated.rank, validated.characterId) : {};
    return { previewId, payloadHash, expiresAt, operation, ...revisions, ...impact,
      duplicateWarnings: duplicateWarnings(db, operation, validated), before: snapshot(db, validated), input: validated };
  });
}

/** Atomic audited commit. Retries bind account + key + preview + role + hash and return the original result even after expiry. */
export function confirmCatalogMutation(db, options) {
  fields(options, ['account', 'role', 'previewId', 'idempotencyKey', 'payloadHash', 'now']);
  const { role, payloadHash, now = Date.now() } = options;
  const account = authorize(options.account, role);
  const previewId = text(options.previewId, 'preview ID', 100);
  const idempotencyKey = text(options.idempotencyKey, 'idempotency key', 200);
  if (typeof payloadHash !== 'string' || !/^[0-9a-f]{64}$/.test(payloadHash)) throw new Error('Invalid payload hash');
  time(now);
  return confirmCatalogPreview(db, { account, role, previewId, idempotencyKey, payloadHash, now },
    ['edit', 'reposition', 'tag', 'franchise_create', 'franchise_edit'], ({ preview: p, payload, revisions }) => {
    fields(payload, ['operation', 'input']);
    const input = validate(db, p.operation, payload.input);
    if (duplicateWarnings(db, p.operation, input).length && !input.duplicateOverrideReason) throw new Error('Duplicate warnings require an explicit override reason');
    const before = snapshot(db, input);
    const membershipBefore = effective(db);
    const impact = apply(db, p.operation, input, now);
    const membershipChanged = membershipBefore !== effective(db);
    if (revisions.revision === MAX || membershipChanged && revisions.appearance_revision === MAX) throw new Error('Catalog revision overflow');
    const next = publishCatalogMutationRevision(db, revisions, { appearanceChanged: membershipChanged }, now);
    return { characterId: input.characterId, before, after: snapshot(db, input), duplicateOverrideReason: input.duplicateOverrideReason,
      result: { operation: p.operation, revision: next.revision, sourceRevision: next.source_revision,
        appearanceRevision: next.appearance_revision, ...(input.characterId ? { characterId: input.characterId } : {}), ...impact } };
  });
}
