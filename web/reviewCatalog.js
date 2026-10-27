import { readFileSync } from 'node:fs';
import { DanbooruApi } from '../lib/danbooruApi.js';
import { normalizeOptionalCatalogTagName } from '../lib/catalogMutations.js';
import { previewManualCharacterCreation, confirmManualCharacterCreation } from '../lib/manualCharacterMutations.js';

const html = readFileSync(new URL('./reviewCatalog.html', import.meta.url));
const script = readFileSync(new URL('./assets/catalog.js', import.meta.url));
const operations = new Set(['create', 'edit', 'reposition', 'source', 'tag', 'franchise']);
function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}
function fields(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key)))
    throw new Error('Unknown fields or invalid request object');
}
async function bodyJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk);
    if (size > 65536) throw new Error('JSON body exceeds 64 KiB');
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function integer(value, fallback, max) {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) throw new Error('Invalid pagination');
  return Number(value);
}
function character(db, row) {
  if (!row) return null;
  return { ...row,
    creationMethod: db.prepare('SELECT creation_method FROM character_identities WHERE id=?').get(row.id)?.creation_method,
    aliases: db.prepare('SELECT alias FROM character_curated_aliases WHERE character_id=? ORDER BY normalized_alias').all(row.id).map(item => item.alias),
    franchiseIds: db.prepare('SELECT franchise_id FROM character_franchise_memberships WHERE character_id=? ORDER BY franchise_id').all(row.id).map(item => item.franchise_id),
    effectiveFranchiseIds: db.prepare('SELECT franchise_id FROM effective_character_franchises WHERE character_id=? ORDER BY franchise_id').all(row.id).map(item => item.franchise_id),
    referenceUrl: db.prepare('SELECT reference_url FROM character_curation WHERE character_id=?').get(row.id)?.reference_url ?? null,
    sources: db.prepare('SELECT source, external_id FROM character_sources WHERE character_id=?').all(row.id),
    tag: db.prepare('SELECT status, tag_name, source FROM tag_decisions WHERE character_id=?').get(row.id) ?? null,
  };
}

// Only server configuration may authorize a fixed source verifier. No client URL,
// callback, permission flag, or generic fetch is accepted in an HTTP payload.
export async function handleCatalogRequest({ db, request, response, url, origin,
  sourcePermissionConfirmed = false, verifySource, verifyTag = tag => new DanbooruApi({ db }).exactTag(tag) }) {
  if (url.pathname !== '/catalog' && url.pathname !== '/assets/catalog.js'
    && url.pathname !== '/api/catalog' && !url.pathname.startsWith('/api/catalog/')) return false;
  const account = request.portalAccount;
  if (!account) { json(response, 401, { error: 'Authentication required' }); return true; }
  if (!['admin', 'moderator'].includes(account.role)) { json(response, 403, { error: 'Catalog access required' }); return true; }
  try {
    if (request.method === 'GET' && ['/catalog', '/assets/catalog.js'].includes(url.pathname)) {
      response.writeHead(200, { 'content-type': url.pathname === '/catalog' ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      response.end(url.pathname === '/catalog' ? html : script); return true;
    }
    if (db.prepare('PRAGMA user_version').get().user_version !== 12) {
      json(response, 409, { error: 'Catalog management requires an explicitly migrated version 12 catalog. No migration was performed.' }); return true;
    }
    if (request.method === 'GET') {
      const path = url.pathname;
      if (path === '/api/catalog' || path === '/api/catalog/search') {
        const query = (url.searchParams.get('query') || '').trim();
        if (query.length > 120) throw new Error('Search is limited to 120 characters');
        const limit = integer(url.searchParams.get('limit'), 50, 100);
        const offset = integer(url.searchParams.get('offset'), 0, Number.MAX_SAFE_INTEGER);
        const like = `%${query.replace(/[\\%_]/g, value => `\\${value}`)}%`;
        const rows = db.prepare(`SELECT c.* FROM characters c WHERE c.id=? OR c.name_full LIKE ? ESCAPE '\\'
          OR c.name_native LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM json_each(c.name_alternatives) WHERE value LIKE ? ESCAPE '\\')
          OR EXISTS (SELECT 1 FROM character_curated_aliases a WHERE a.character_id=c.id AND a.alias LIKE ? ESCAPE '\\')
          ORDER BY c.rank LIMIT ? OFFSET ?`).all(query, like, like, like, like, limit, offset);
        json(response, 200, { characters: rows.map(row => character(db, row)), offset, limit,
          count: db.prepare('SELECT count(*) AS n FROM characters').get().n,
          sourceVerificationEnabled: sourcePermissionConfirmed === true && typeof verifySource === 'function' });
      } else if (path === '/api/catalog/detail') {
        const value = character(db, db.prepare('SELECT * FROM characters WHERE id=?').get(url.searchParams.get('id') || ''));
        json(response, value ? 200 : 404, value ?? { error: 'Unknown character' });
      } else if (path === '/api/catalog/franchises') {
        json(response, 200, db.prepare('SELECT * FROM franchises ORDER BY display_name, id').all().map(row => ({ ...row,
          aliases: db.prepare('SELECT alias FROM franchise_aliases WHERE franchise_id=? ORDER BY alias').all(row.id).map(item => item.alias),
        })));
      } else if (path === '/api/catalog/audit') {
        const limit = integer(url.searchParams.get('limit'), 50, 100);
        const offset = integer(url.searchParams.get('offset'), 0, Number.MAX_SAFE_INTEGER);
        const id = url.searchParams.get('characterId');
        json(response, 200, db.prepare(`SELECT * FROM catalog_mutations ${id ? 'WHERE character_id=?' : ''} ORDER BY id DESC LIMIT ? OFFSET ?`)
          .all(...(id ? [id, limit, offset] : [limit, offset])).map(row => ({ ...row,
            before: JSON.parse(row.before_json), after: JSON.parse(row.after_json), before_json: undefined, after_json: undefined,
          })));
      } else json(response, 404, { error: 'Unknown catalog route' });
      return true;
    }
    const match = /^\/api\/catalog\/(create|edit|reposition|source|tag|franchise)\/(preview|confirm)$/.exec(url.pathname);
    if (!match) { json(response, 404, { error: 'Unknown catalog route' }); return true; }
    if (request.method !== 'POST') { json(response, 405, { error: 'Method not allowed' }); return true; }
    if (request.headers.origin !== origin) { json(response, 403, { error: 'Invalid origin' }); return true; }
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
      json(response, 415, { error: 'JSON required' }); return true;
    }
    const body = await bodyJson(request);
    const [, operation, action] = match;
    if (!operations.has(operation)) throw new Error('Unknown operation');
    fields(body, action === 'confirm' ? ['previewId', 'payloadHash', 'idempotencyKey']
      : operation === 'create' ? ['input', 'rank', 'duplicateOverrideReason'] : ['operation', 'input']);
    const attribution = { account: account.username, role: account.role };
    let value;
    async function verifiedTagName(tagName) {
      const canonical = await verifyTag(tagName);
      if (!canonical || canonical.category !== 4 || canonical.is_deprecated
        || typeof canonical.name !== 'string' || !/^[a-z0-9_():.!-]{2,120}$/.test(canonical.name)) {
        throw new Error('Tag must be an active Danbooru character tag');
      }
      return canonical.name;
    }
    if (operation === 'create') {
      if (action === 'preview' && body.input && typeof body.input === 'object') {
        const tagName = normalizeOptionalCatalogTagName(body.input.tagName);
        body.input.tagName = tagName === null ? null : await verifiedTagName(tagName);
      }
      value = action === 'preview' ? previewManualCharacterCreation(db, { ...body, ...attribution })
        : confirmManualCharacterCreation(db, { ...body, ...attribution });
    } else {
      // Resolve the shared services on demand: missing parallel work fails closed,
      // and no independent SQL writes or ranking logic live in this route layer.
      const service = await import(operation === 'source' ? '../lib/catalogSourceMutations.js' : '../lib/catalogMutations.js');
      if (action === 'confirm') {
        // Keep endpoint and persisted operation bound even though the shared confirm
        // contract deliberately accepts only the preview identity and hash.
        const preview = db.prepare('SELECT operation FROM catalog_previews WHERE id=?').get(body.previewId);
        const permitted = operation === 'source' ? ['source-link', 'source-correct', 'source-unlink', 'imported-likes-adopt']
          : operation === 'franchise' ? ['franchise_create', 'franchise_edit'] : [operation];
        if (!preview || !permitted.includes(preview.operation)) throw new Error('Preview operation mismatch or missing preview');
        value = operation === 'source' ? await service.confirmSourceMutation(db, { ...body, ...attribution })
          : await service.confirmCatalogMutation(db, { ...body, ...attribution });
      } else {
        if (operation === 'franchise' && !['franchise_create', 'franchise_edit'].includes(body.operation)) throw new Error('Invalid franchise operation');
        if (operation === 'source' && !['source-link', 'source-correct', 'source-unlink', 'imported-likes-adopt'].includes(body.operation)) throw new Error('Invalid source operation');
        if (!['franchise', 'source'].includes(operation) && body.operation !== undefined && body.operation !== operation) throw new Error('Operation mismatch');
        if (operation === 'tag' && body.input?.status === 'approve') {
          fields(body.input, ['characterId', 'status', 'tagName']);
          if (typeof body.input.tagName !== 'string' || !/^[a-z0-9_():.!-]{2,120}$/.test(body.input.tagName)) throw new Error('Invalid character tag');
          body.input.tagName = await verifiedTagName(body.input.tagName);
        }
        value = operation === 'source' ? await service.previewSourceMutation(db, { ...body, ...attribution,
          permissionConfirmed: sourcePermissionConfirmed === true, verifySource })
          : await service.previewCatalogMutation(db, { input: body.input, operation: operation === 'franchise' ? body.operation : operation,
            ...attribution });
      }
    }
    json(response, 200, value);
  } catch (error) {
    const unavailable = error.code === 'ERR_MODULE_NOT_FOUND';
    const stale = /stale|expired|already confirmed/i.test(error.message);
    json(response, unavailable ? 503 : stale ? 409 : 400, { error: unavailable ? 'Shared catalog mutation service is not available yet' : error.message,
      code: error.code, refreshPreview: stale });
  }
  return true;
}
