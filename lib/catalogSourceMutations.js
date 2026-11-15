import { randomUUID } from 'node:crypto';
import { requireCharacterId, normalizeAniListCharacterId } from './characterIdentity.js';
import { hasCharacterRanking } from './catalogFinalSchema.js';
import { canonicalCatalogValue as canonical, hashCatalogPayload as hash,
  validateCatalogTimestamp as timestamp, catalogMutationTransaction as transaction,
  catalogMutationState as state, publishCatalogMutationRevision, confirmCatalogPreview } from './catalogMutationProtocol.js';

export const SOURCE_MUTATION_PREVIEW_TTL_MS = 10 * 60 * 1000;
const MAX = Number.MAX_SAFE_INTEGER;
const ENDPOINT = 'https://graphql.anilist.co';
const QUERY = 'query ($id: Int!) { Character(id: $id) { id favourites name { full } image { large } siteUrl } }';
const OPERATIONS = new Set(['source-link', 'source-correct', 'source-unlink', 'imported-likes-adopt']);
function optionsFields(options, allowed) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Invalid options');
  for (const key of Object.keys(options)) if (!allowed.includes(key)) throw new Error(`Unknown option: ${key}`);
}
function bounded(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > max
    || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}
function authorize(account, role) {
  if (!['admin', 'moderator'].includes(role)) throw new Error('Unauthorized catalog role');
  return bounded(account, 'account', 120);
}
function ready(db) {
  if (db.isTransaction) throw new Error('Caller transaction is not supported');
  if (db.prepare('PRAGMA user_version').get().user_version !== 12) throw new Error('Source mutations require catalog version 12');
  if (db.prepare('PRAGMA foreign_keys').get().foreign_keys !== 1) throw new Error('Source mutations require foreign_keys ON');
}
function validate(operation, input) {
  if (!OPERATIONS.has(operation)) throw new Error('Unsupported source operation');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid input');
  const fields = ['characterId', 'source', ...(['source-link', 'source-correct'].includes(operation) ? ['externalId'] : [])];
  if (Object.keys(input).some(key => !fields.includes(key))) throw new Error('Unsupported input field');
  const characterId = requireCharacterId(input.characterId);
  if (characterId !== input.characterId) throw new Error('Character UUID must be canonical');
  if (input.source !== 'anilist') throw new Error('Unsupported source');
  const result = { characterId, source: 'anilist' };
  if (fields.includes('externalId')) {
    result.externalId = normalizeAniListCharacterId(input.externalId);
    if (Number(result.externalId) > 2147483647) throw new Error('AniList ID exceeds GraphQL Int');
  }
  return result;
}
function snapshot(db, id) {
  const character = db.prepare('SELECT * FROM characters WHERE id=?').get(id);
  const identity = db.prepare('SELECT * FROM character_identities WHERE id=?').get(id);
  if (!character || !identity) throw new Error('Unknown published character');
  return { character, identity,
    sources: db.prepare('SELECT source, external_id FROM character_sources WHERE character_id=? ORDER BY source').all(id),
    appearances: db.prepare('SELECT * FROM character_anime WHERE character_id=? ORDER BY anime_id').all(id) };
}
function checkTarget(db, operation, input) {
  if (operation === 'imported-likes-adopt' && hasCharacterRanking(db)) throw new Error('Rank is derived; imported-likes-adopt is no longer supported');
  const before = snapshot(db, input.characterId);
  const current = before.sources.find(row => row.source === 'anilist')?.external_id;
  if (operation === 'source-link' && current) throw new Error('Character already has an AniList reference; use correction');
  if (operation !== 'source-link' && !current) throw new Error('Character has no AniList reference');
  if (operation === 'source-correct' && current === input.externalId) throw new Error('Correction must change the reference');
  if (operation === 'imported-likes-adopt' && before.character.likes_source !== 'generated') throw new Error('Likes are already imported');
  if (input.externalId) {
    const owner = db.prepare("SELECT character_id FROM character_sources WHERE source='anilist' AND external_id=?").get(input.externalId);
    if (owner && owner.character_id !== input.characterId) throw new Error('Source reference already belongs to another identity');
  }
  if (['source-correct', 'source-unlink'].includes(operation) && before.identity.creation_method === 'manual'
    && !db.prepare('SELECT 1 FROM character_franchise_memberships WHERE character_id=? LIMIT 1').get(input.characterId)) {
    // All appearances are discarded: derived franchises cannot satisfy this invariant.
    throw new Error('Manual characters require at least one direct franchise before removing appearances');
  }
  return before;
}
function safeCount(n) {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid verified likes');
  return n;
}
function https(value, label) {
  bounded(value, label, 2048);
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error(`Invalid ${label}`);
  return value;
}

// fetch-compatible injectable transport, always called with this fixed endpoint/query.
// One request, no retries, 10-second total deadline, 64 KiB response limit; never fetch portraits.
async function verify(externalId, transport) {
  const controller = new AbortController();
  let timer;
  const request = async () => {
    const response = await transport(ENDPOINT, { method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ query: QUERY, variables: { id: Number(externalId) } }), signal: controller.signal });
    if (!response.ok) throw new Error('AniList verification HTTP failure');
    let text = '';
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 65536) throw new Error('AniList verification response too large');
          text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
      } finally { await reader.cancel(); }
    } else {
      text = await response.text();
      if (Buffer.byteLength(text) > 65536) throw new Error('AniList verification response too large');
    }
    const payload = JSON.parse(text);
    const row = payload.data?.Character;
    if (payload.errors?.length || !row || normalizeAniListCharacterId(row.id) !== externalId) throw new Error('AniList identity verification failed');
    return { externalId, name: bounded(row.name?.full, 'verified name', 500),
      portraitUrl: https(row.image?.large, 'verified portrait'), referenceUrl: https(row.siteUrl, 'verified reference'),
      favourites: safeCount(row.favourites) };
  };
  try {
    return await Promise.race([request(), new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('AniList verification timeout')); }, 10000);
    })]);
  } finally { clearTimeout(timer); controller.abort(); }
}
function projectedRank(db, id, favourites) {
  const rows = db.prepare('SELECT id, favourites, tie_order FROM characters').all();
  for (const row of rows) {
    safeCount(row.favourites);
    if (!Number.isSafeInteger(row.tie_order) || row.tie_order < 1) throw new Error('Invalid tie order');
    if (row.id === id) row.favourites = favourites;
  }
  rows.sort((a, b) => b.favourites - a.favourites || a.tie_order - b.tie_order);
  return { rows, rank: rows.findIndex(row => row.id === id) + 1 };
}

/** input: {characterId: canonical UUID, source:'anilist', externalId?: positive ID}.
 * externalId is required only for link/correct. No client metadata or counts accepted.
 * permissionConfirmed === true is required for every API lookup, including adoption.
 * now is epoch milliseconds. The caller supplies authenticated account/role, never form values.
 */
export async function previewSourceMutation(db, options) {
  optionsFields(options, ['account', 'role', 'operation', 'input', 'permissionConfirmed', 'verifySource', 'now']);
  let { account, role, operation, input, permissionConfirmed, verifySource = globalThis.fetch, now = Date.now() } = options;
  account = authorize(account, role);
  timestamp(now);
  if (!Number.isSafeInteger(now + SOURCE_MUTATION_PREVIEW_TTL_MS)) throw new Error('Preview expiry overflow');
  input = validate(operation, input);
  ready(db);
  if (operation !== 'source-unlink' && permissionConfirmed !== true) throw new Error('AniList API permission must be confirmed');
  if (operation !== 'source-unlink' && typeof verifySource !== 'function') throw new Error('Invalid verification transport');
  const revisions = state(db);
  const before = checkTarget(db, operation, input);
  const externalId = input.externalId ?? before.sources.find(row => row.source === 'anilist')?.external_id;
  const verified = operation === 'source-unlink' ? null : await verify(externalId, verifySource);
  return transaction(db, () => {
    if (canonical(state(db)) !== canonical(revisions)
      || canonical(checkTarget(db, operation, input)) !== canonical(before)) throw new Error('Stale catalog during verification');
    const rank = operation === 'imported-likes-adopt'
      ? projectedRank(db, input.characterId, verified.favourites).rank : before.character.rank;
    const payload = { operation, input, before, verified, permissionConfirmed: operation !== 'source-unlink',
      rank, favourites: operation === 'imported-likes-adopt' ? verified.favourites : before.character.favourites };
    const previewId = randomUUID();
    const payloadHash = hash(payload);
    const expiresAt = now + SOURCE_MUTATION_PREVIEW_TTL_MS;
    db.prepare(`INSERT INTO catalog_previews
      (id,account,role,operation,payload_hash,payload_json,revision,source_revision,appearance_revision,created_at,expires_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(previewId, account, role, operation, payloadHash, canonical(payload),
      revisions.revision, revisions.source_revision, revisions.appearance_revision, now, expiresAt);
    return { previewId, payloadHash, expiresAt, ...revisions, operation, characterId: input.characterId,
      local: before.character, verified, rankBefore: before.character.rank, rankAfter: rank,
      favourites: payload.favourites, likesSource: operation === 'imported-likes-adopt' ? 'anilist'
        : operation === 'source-link' ? before.character.likes_source : 'generated' };
  });
}

/** No verification/network at confirmation. Exact preview/role/account/hash/key retries only. */
export function confirmSourceMutation(db, options) {
  optionsFields(options, ['account', 'role', 'previewId', 'idempotencyKey', 'payloadHash', 'now']);
  let { account, role, previewId, idempotencyKey, payloadHash, now = Date.now() } = options;
  account = authorize(account, role);
  bounded(previewId, 'preview ID', 100);
  bounded(idempotencyKey, 'idempotency key', 200);
  if (typeof payloadHash !== 'string' || !/^[0-9a-f]{64}$/.test(payloadHash)) throw new Error('Invalid payload hash');
  timestamp(now);
  return confirmCatalogPreview(db, { account, role, previewId, idempotencyKey, payloadHash, now }, [...OPERATIONS], ({ payload, revisions }) => {
    const { operation } = payload;
    const input = validate(operation, payload.input);
    const before = checkTarget(db, operation, input);
    if (canonical(before) !== canonical(payload.before)) throw new Error('Stale character preview');
    const mappingChanged = operation !== 'imported-likes-adopt';
    const removed = operation === 'source-correct' || operation === 'source-unlink';
    const increments = { revision: 1, source_revision: Number(mappingChanged), appearance_revision: Number(removed) };
    for (const key of Object.keys(increments)) if (!Number.isSafeInteger(revisions[key] + increments[key])) throw new Error('Catalog revision overflow');
    const id = input.characterId;
    if (operation !== 'source-unlink' && (!payload.permissionConfirmed || !payload.verified
      || payload.verified.externalId !== (input.externalId ?? before.sources.find(row => row.source === 'anilist').external_id))) throw new Error('Missing verified terms');
    if (removed) {
      // Freeze first: authoritative v12 guards reject deleting a managed-likes source.
      db.prepare("UPDATE characters SET likes_source='generated', anime_ids='[]', anime_titles='[]', anime_adult=0 WHERE id=?").run(id);
      db.prepare("DELETE FROM character_sources WHERE character_id=? AND source='anilist'").run(id);
      db.prepare('DELETE FROM character_anime WHERE character_id=?').run(id);
    }
    if (operation === 'source-link' || operation === 'source-correct') {
      db.prepare("INSERT INTO character_sources (character_id,source,external_id) VALUES (?,'anilist',?)").run(id, input.externalId);
    }
    if (operation === 'imported-likes-adopt') {
      const likes = safeCount(payload.verified.favourites);
      const projected = projectedRank(db, id, likes);
      if (projected.rank !== payload.rank || likes !== payload.favourites) throw new Error('Stored rank terms mismatch');
      const maxRank = db.prepare('SELECT max(rank) AS n FROM characters').get().n;
      const offset = maxRank + projected.rows.length + 1;
      if (!Number.isSafeInteger(maxRank + offset)) throw new Error('Catalog rank overflow');
      db.prepare('UPDATE characters SET rank=rank+?').run(offset);
      projected.rows.forEach((row, index) => db.prepare('UPDATE characters SET rank=? WHERE id=?').run(index + 1, row.id));
      db.prepare("UPDATE characters SET favourites=?, likes_source='anilist' WHERE id=?").run(likes, id);
    }
    if (mappingChanged) db.prepare("DELETE FROM catalog_meta WHERE key IN ('franchise_source_published_at','franchise_source_token')").run();
    const next = publishCatalogMutationRevision(db, revisions, { sourceChanged: mappingChanged, appearanceChanged: removed }, now);
    const after = snapshot(db, id);
    return { characterId: id, before, after, result: { characterId: id, operation, ...next,
      rank: after.character.rank, favourites: after.character.favourites, likesSource: after.character.likes_source } };
  });
}
