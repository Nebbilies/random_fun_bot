import { handleGenderReviewRequest } from './reviewCharacterGenders.js';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { previewCatalogMutation, confirmCatalogMutation } from '../lib/catalogMutations.js';
import { isValidCharacterId } from '../lib/gameCharacterLookup.js';
import { createPortalAuth, loadPortalEnvironment } from './portalAuth.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DANBOORU_USER_AGENT, DanbooruApi } from '../lib/danbooruApi.js';
import { getMeta, openCatalog, resolveCharacterTagReports, saveDecision, transaction } from '../lib/catalogDb.js';
import { handleFranchiseReviewRequest } from './reviewFranchises.js';
import { addGlobalRolls, resetGlobalClaims } from '../lib/characterRolls.js';
import { getGuildRates, setGuildRates, isValidRate } from '../lib/guildRates.js';
import { serveAssets } from './serveAssets.js';
import { handleConfigRequest } from './reviewConfig.js';
import { handleCatalogRequest } from './reviewCatalog.js';
import { getResolvedItemDefinitions, getResolvedItemDefinition } from '../lib/itemRoster.js';
import { addItemToInventory } from '../lib/itemStorage.js';

const html = readFileSync(new URL('./reviewCharacterTags.html', import.meta.url));
const gameHtml = readFileSync(new URL('./reviewGame.html', import.meta.url));
const previewCache = new Map();

function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

function characterRow(db, row) {
  if (!row) return null;
  return {
    id: row.id, rank: row.rank, favourites: row.favourites,
    name: row.name_full, nativeName: row.name_native,
    alternatives: JSON.parse(row.name_alternatives || '[]'),
    gender: row.gender, imageUrl: row.image_url, siteUrl: row.site_url,
    animeTitles: JSON.parse(row.anime_titles || '[]'),
    adultAnime: Boolean(row.anime_adult),
    decision: db.prepare('SELECT status, tag_name, source FROM tag_decisions WHERE character_id = ?').get(row.id) ?? null,
    candidates: db.prepare('SELECT tag_name AS name, post_count AS postCount, reason FROM tag_candidates WHERE character_id = ? ORDER BY post_count DESC LIMIT 25').all(row.id),
  };
}

function reviewRow(db, rank, direction = 'forward') {
  const reverse = direction !== 'forward';
  const boundary = direction === 'last' ? '' : `c.rank ${reverse ? '<' : '>'} ? AND `;
  const statement = db.prepare(`SELECT c.* FROM characters c
    LEFT JOIN tag_decisions d ON d.character_id = c.id
    WHERE ${boundary}d.character_id IS NULL
    ORDER BY c.rank ${reverse ? 'DESC' : 'ASC'} LIMIT 1`);
  const row = direction === 'last' ? statement.get() : statement.get(rank);
  return characterRow(db, row);
}

function reportedRow(db) {
  const report = db.prepare(`SELECT character_id, COUNT(*) AS report_count, MIN(reported_at) AS first_reported
    FROM character_tag_reports WHERE resolved_at IS NULL GROUP BY character_id
    ORDER BY first_reported, MIN(id) LIMIT 1`).get();
  if (!report) return null;
  const row = db.prepare('SELECT * FROM characters WHERE id = ?').get(report.character_id);
  return { ...characterRow(db, row), reportCount: report.report_count, firstReportedAt: report.first_reported };
}

async function readJsonBody(request) {
  let data = '';
  for await (const chunk of request) {
    data += chunk;
    if (data.length > 8192) throw new Error('Request too large');
  }
  return JSON.parse(data);
}

function safePreviewUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'donmai.us' || url.hostname.endsWith('.donmai.us'))
      ? url.href : null;
  } catch { return null; }
}

export function createReviewServer({ db, api = new DanbooruApi({ db }), fetchImpl = fetch, host = '127.0.0.1', publicHost = host, port = 8787, authConfig, sourcePermissionConfirmed = false, verifySource }) {
  const auth = createPortalAuth(authConfig);
  const isV12 = db.prepare('PRAGMA user_version').get().user_version === 12;
  // Only trusted exact-tag verification supplies evidence to the shared service.
  async function verifiedTag(tag) {
    const canonical = await api.exactTag(tag);
    if (!canonical || canonical.category !== 4 || canonical.is_deprecated
      || typeof canonical.name !== 'string' || !/^(?!.*[*,A-Z])[\x21-\x7E]{2,120}$/.test(canonical.name)) return null;
    const params = new URLSearchParams({ 'search[name]': canonical.name, 'search[category]': '4', limit: '5' });
    db.prepare('INSERT OR REPLACE INTO tag_search_cache (query, response, fetched_at) VALUES (?, ?, ?)')
      .run(`/tags.json?${params}`, JSON.stringify([canonical]), new Date().toISOString());
    return canonical;
  }
  function publishTag(request, characterId, status, tagName, outcome) {
    const account = request.portalAccount;
    if (!account || !['admin', 'moderator'].includes(account.role)) throw new Error('Catalog access required');
    // Savepoints compose the services' transactions with atomic report resolution.
    const nested = new Proxy(db, { get(target, key) {
      if (key === 'exec') return sql => target.exec(sql === 'BEGIN IMMEDIATE' ? 'SAVEPOINT queue_mutation'
        : sql === 'COMMIT' ? 'RELEASE queue_mutation'
          : sql === 'ROLLBACK' ? 'ROLLBACK TO queue_mutation; RELEASE queue_mutation' : sql);
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    return transaction(db, () => {
      if (outcome && !db.prepare('SELECT 1 FROM character_tag_reports WHERE character_id=? AND resolved_at IS NULL').get(characterId))
        throw new Error('No open reports for this character');
      const attribution = { account: account.username, role: account.role };
      const preview = previewCatalogMutation(nested, { ...attribution, operation: 'tag',
        input: { characterId, status, ...(status === 'approve' ? { tagName } : {}) } });
      const result = confirmCatalogMutation(nested, { ...attribution, previewId: preview.previewId,
        payloadHash: preview.payloadHash, idempotencyKey: randomUUID() });
      if (outcome) resolveCharacterTagReports(db, characterId, outcome);
      return result;
    });
  }
  if (db.prepare('PRAGMA user_version').get().user_version !== 12 && getMeta(db, 'import_phase') !== 'complete')
    throw new Error('Publish the catalog before reviewing tags');
  if (!publicHost || publicHost === '0.0.0.0') throw new Error('Set a public host when listening on all interfaces');
  const server = createServer(async (request, response) => {
    try {
      const actualPort = server.address()?.port ?? port;
      let requestOrigin;
      try {
        if (!request.headers.host) return json(response, 403, { error: 'Invalid host' });
        const authority = new URL(`http://${request.headers.host}`);
        if (authority.pathname !== '/' || authority.search || authority.hash || authority.username || authority.password
          || Number(authority.port || 80) !== actualPort || authority.hostname !== publicHost)
          return json(response, 403, { error: 'Invalid host' });
        requestOrigin = authority.origin;
      } catch {
        return json(response, 403, { error: 'Invalid host' });
      }
      requestOrigin = auth.origin(requestOrigin);
      const url = new URL(request.url, requestOrigin);
      if (await auth.handle(request, response, url, requestOrigin)) return;
      if (await handleCatalogRequest({ db, request, response, url, origin: requestOrigin, sourcePermissionConfirmed, verifySource, verifyTag: tag => verifiedTag(tag) })) return;
      if (await handleGenderReviewRequest({ db, request, response, url, origin: requestOrigin })) return;
      if (serveAssets(request, response, url)) return;
      if (await handleConfigRequest({ db, request, response, url, origin: requestOrigin })) return;
      if (await handleFranchiseReviewRequest({ db, request, response, url, origin: requestOrigin })) return;
      if (request.method === 'GET' && url.pathname === '/') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        response.end(html);
      } else if (request.method === 'GET' && url.pathname === '/game') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        response.end(gameHtml);
      } else if (request.method === 'POST' && ['/api/game/add-rolls', '/api/game/reset-claims'].includes(url.pathname)) {
        if (request.headers.origin !== requestOrigin)
          return json(response, 403, { error: 'Invalid origin' });
        if (!request.headers['content-type']?.startsWith('application/json'))
          return json(response, 415, { error: 'JSON required' });
        let body;
        try { body = await readJsonBody(request); }
        catch { return json(response, 400, { error: 'Invalid JSON body' }); }
        if (url.pathname === '/api/game/add-rolls') {
          if (!Number.isSafeInteger(body?.amount) || body.amount < 1)
            return json(response, 400, { error: 'Enter a positive whole number of rolls.' });
          json(response, 200, addGlobalRolls(db, body.amount));
        } else json(response, 200, resetGlobalClaims(db));
      } else if (request.method === 'GET' && url.pathname === '/api/game/items') {
        const guildId = url.searchParams.get('guildId');
        if (guildId !== null && !/^[1-9]\d{0,19}$/.test(guildId))
          return json(response, 400, { error: 'Invalid server ID' });
        json(response, 200, getResolvedItemDefinitions(db, guildId).map(({ id, name, tier, description, maxCharges }) => ({
          id, name, tier, description, charges: maxCharges ?? 1,
        })));
      } else if (request.method === 'POST' && url.pathname === '/api/game/give-item') {
        if (request.headers.origin !== requestOrigin)
          return json(response, 403, { error: 'Invalid origin' });
        if (!request.headers['content-type']?.startsWith('application/json'))
          return json(response, 415, { error: 'JSON required' });
        let body;
        try { body = await readJsonBody(request); }
        catch { return json(response, 400, { error: 'Invalid JSON body' }); }
        const { guildId, userId, itemId } = body || {};
        const validId = (value) => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value);
        if (!validId(guildId) || !validId(userId))
          return json(response, 400, { error: 'Valid numeric server and user IDs are required (up to 20 digits).' });
        const item = typeof itemId === 'string' ? getResolvedItemDefinition(db, guildId, itemId) : null;
        if (!item) return json(response, 400, { error: 'Select a valid item.' });
        const result = transaction(db, () => addItemToInventory(db, guildId, userId, item.id));
        if (result.status === 'full')
          return json(response, 409, { error: `Inventory is full (${result.currentCount}/${result.capacity}). No item was given.` });
        json(response, 200, { ...result, guildId, userId, itemName: item.name });
      } else if (request.method === 'GET' && url.pathname === '/api/game/rates') {
        const guildId = url.searchParams.get('guildId');
        if (guildId) {
          if (!/^\d+$/.test(guildId)) return json(response, 400, { error: 'Invalid guild ID' });
          json(response, 200, { guildId, ...getGuildRates(db, guildId) });
        } else {
          const guilds = new Set(db.prepare('SELECT guild_id FROM guild_game_rates').all().map((row) => row.guild_id));
          if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='game_config_overrides'").get()) {
            for (const row of db.prepare("SELECT DISTINCT scope_id FROM game_config_overrides WHERE scope_id != '' AND key IN ('vault.dropRate', 'rolls.prankRate')").all()) guilds.add(row.scope_id);
          }
          json(response, 200, [...guilds].sort().map((guildId) => ({ guildId, ...getGuildRates(db, guildId) })));
        }
      } else if (request.method === 'POST' && url.pathname === '/api/game/rates') {
        if (request.headers.origin !== requestOrigin)
          return json(response, 403, { error: 'Invalid origin' });
        if (!request.headers['content-type']?.startsWith('application/json'))
          return json(response, 415, { error: 'JSON required' });
        let body;
        try { body = await readJsonBody(request); }
        catch { return json(response, 400, { error: 'Invalid JSON body' }); }
        const { guildId, vaultRate, prankRate } = body || {};
        if (!guildId || typeof guildId !== 'string' || !/^\d+$/.test(guildId)) {
          return json(response, 400, { error: 'A valid numeric Discord Server (Guild) ID is required.' });
        }
        if (vaultRate !== undefined && !isValidRate(vaultRate)) {
          return json(response, 400, { error: 'Vault rate must be a number between 0 and 1 (e.g. 0.01 for 1%).' });
        }
        if (prankRate !== undefined && !isValidRate(prankRate)) {
          return json(response, 400, { error: 'Prank rate must be a number between 0 and 1 (e.g. 0.01 for 1%).' });
        }
        try {
          const updated = setGuildRates(db, guildId, { vaultRate, prankRate });
          json(response, 200, { guildId, ...updated });
        } catch (err) {
          json(response, 400, { error: err.message });
        }
      } else if (request.method === 'GET' && url.pathname === '/api/status') {
        const count = (sql) => db.prepare(sql).get().n;
        json(response, 200, {
          total: count('SELECT COUNT(*) AS n FROM characters'),
          matched: count('SELECT COUNT(*) AS n FROM tag_match_progress'),
          automatic: count("SELECT COUNT(*) AS n FROM tag_decisions WHERE source = 'automatic'"),
          manual: count("SELECT COUNT(*) AS n FROM tag_decisions WHERE source = 'manual'"),
          reports: count(`SELECT COUNT(DISTINCT character_id) AS n FROM character_tag_reports WHERE resolved_at IS NULL`),
          queue: count(`SELECT COUNT(*) AS n FROM characters c LEFT JOIN tag_decisions d ON d.character_id = c.id
            WHERE d.character_id IS NULL`),
        });
      } else if (request.method === 'GET' && url.pathname === '/api/next') {
        const before = url.searchParams.get('before');
        const last = url.searchParams.get('last') === '1';
        if (before !== null && last) return json(response, 400, { error: 'Choose one direction' });
        const rank = Number(before ?? url.searchParams.get('after') ?? 0);
        if (!Number.isInteger(rank) || rank < 0) return json(response, 400, { error: 'Invalid rank' });
        json(response, 200, reviewRow(db, rank, last ? 'last' : before !== null ? 'back' : 'forward'));
      } else if (request.method === 'GET' && url.pathname === '/api/reports/next') {
        json(response, 200, reportedRow(db));
      } else if (request.method === 'GET' && url.pathname === '/api/reports/history') {
        const offset = Number(url.searchParams.get('offset') || 0);
        if (!Number.isInteger(offset) || offset < 0) return json(response, 400, { error: 'Invalid offset' });
        json(response, 200, db.prepare(`SELECT r.character_id AS characterId,
          COALESCE(MAX(c.name_full), 'Character #' || r.character_id) AS name,
          r.resolved_at AS resolvedAt, r.outcome, COUNT(*) AS reportCount
          FROM character_tag_reports r LEFT JOIN characters c ON c.id = r.character_id
          WHERE r.resolved_at IS NOT NULL
          GROUP BY r.character_id, r.resolved_at, r.outcome
          ORDER BY MAX(r.id) DESC LIMIT 50 OFFSET ?`).all(offset));
      } else if (request.method === 'GET' && url.pathname === '/api/search') {
        const query = url.searchParams.get('query') || '';
        if (query.length < 2 || query.length > 80) return json(response, 400, { error: 'Search needs 2-80 characters' });
        json(response, 200, (await api.searchTagsLiteral(query)).slice(0, 25));
      } else if (request.method === 'GET' && url.pathname === '/api/preview') {
        const tag = url.searchParams.get('tag') || '';
        if (!/^(?!.*[*,A-Z])[\x21-\x7E]{2,120}$/.test(tag)) return json(response, 400, { error: 'Invalid tag' });
        const solo = url.searchParams.get('solo') === '1';
        const query = `${tag} order:score`;
        const cacheKey = `${query}${solo ? ' solo' : ''}`;
        if (!previewCache.has(cacheKey)) {
          const previews = [];
          for (let page = 1; page <= (solo ? 3 : 1); page++) {
            const remote = new URL('https://safebooru.donmai.us/posts.json');
            remote.searchParams.set('tags', query);
            remote.searchParams.set('limit', solo ? '200' : '3');
            if (page > 1) remote.searchParams.set('page', String(page));
            const result = await fetchImpl(remote, { headers: { accept: 'application/json', 'user-agent': DANBOORU_USER_AGENT }, signal: AbortSignal.timeout(15_000) });
            if (!result.ok) throw new Error(`Preview HTTP ${result.status}`);
            const posts = await result.json();
            for (const post of posts) {
              if (post.rating !== 'g' || (solo && !(` ${post.tag_string_general || post.tag_string || ''} `).includes(' solo '))) continue;
              const image = safePreviewUrl(post.preview_file_url || post.large_file_url || post.file_url);
              if (image) previews.push(image);
              if (previews.length === 3) break;
            }
            if (previews.length === 3 || posts.length < 200) break;
          }
          previewCache.set(cacheKey, previews);
        }
        json(response, 200, previewCache.get(cacheKey));
      } else if (request.method === 'POST' && url.pathname === '/api/decision') {
        if (request.headers.origin && request.headers.origin !== requestOrigin)
          return json(response, 403, { error: 'Invalid origin' });
        if (!request.headers['content-type']?.startsWith('application/json'))
          return json(response, 415, { error: 'JSON required' });
        const { characterId, status, tag } = await readJsonBody(request);
        // Schema-bound UUID/legacy validation; never resolve a source ID.
        if (!isValidCharacterId(characterId, db) || !db.prepare('SELECT id FROM characters WHERE id = ?').get(characterId))
          return json(response, 400, { error: 'Unknown character' });
        if (!['approve', 'no_match'].includes(status)) return json(response, 400, { error: 'Invalid decision' });
        let canonicalTag = null;
        if (status === 'approve') {
          if (typeof tag !== 'string' || tag.length > 120)
            return json(response, 400, { error: 'Tag must be an active Danbooru character tag' });
          canonicalTag = await (isV12 ? verifiedTag(tag) : api.exactTag(tag));
          if (!canonicalTag)
            return json(response, 400, { error: 'Tag must be an active Danbooru character tag' });
        }
        if (isV12) publishTag(request, characterId, status, canonicalTag?.name ?? null);
        else saveDecision(db, characterId, status, canonicalTag?.name ?? null, 'manual');
        json(response, 200, { saved: true });
      } else if (request.method === 'POST' && url.pathname === '/api/reports/resolve') {
        if (request.headers.origin && request.headers.origin !== requestOrigin)
          return json(response, 403, { error: 'Invalid origin' });
        if (!request.headers['content-type']?.startsWith('application/json'))
          return json(response, 415, { error: 'JSON required' });
        const { characterId, outcome, tag } = await readJsonBody(request);
        if (!isValidCharacterId(characterId, db) || !db.prepare('SELECT id FROM characters WHERE id = ?').get(characterId))
          return json(response, 400, { error: 'Unknown character' });
        if (!['corrected', 'dismissed'].includes(outcome)) return json(response, 400, { error: 'Invalid resolution' });
        if (!db.prepare(`SELECT 1 FROM character_tag_reports WHERE character_id = ? AND resolved_at IS NULL`).get(characterId))
          return json(response, 409, { error: 'No open reports for this character' });
        let canonicalTag = null;
        if (outcome === 'corrected') {
          if (typeof tag !== 'string' || tag.length > 120)
            return json(response, 400, { error: 'Tag must be an active Danbooru character tag' });
          canonicalTag = await (isV12 ? verifiedTag(tag) : api.exactTag(tag));
          if (!canonicalTag)
            return json(response, 400, { error: 'Tag must be an active Danbooru character tag' });
        }
        if (isV12 && outcome === 'corrected') publishTag(request, characterId, 'approve', canonicalTag.name, outcome);
        else transaction(db, () => {
          if (outcome === 'corrected') saveDecision(db, characterId, 'approve', canonicalTag.name, 'manual');
          resolveCharacterTagReports(db, characterId, outcome);
        });
        json(response, 200, { saved: true });
      } else {
        json(response, 404, { error: 'Not found' });
      }
    } catch (error) {
      json(response, 500, { error: error.message });
    }
  });
  server.listen(port, host);
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let db;
  try {
    const { values } = parseArgs({ options: {
      host: { type: 'string', default: '127.0.0.1' },
      port: { type: 'string', default: '8787' },
      'public-host': { type: 'string' },
      'catalog-source-permission': { type: 'boolean', default: false },
    } });
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--port must be between 1 and 65535');
    if (!values.host) throw new Error('--host must not be empty');
    const authConfig = loadPortalEnvironment();
    db = openCatalog();
    const publicHost = values['public-host'] ?? values.host;
    const server = createReviewServer({ db, host: values.host, publicHost, port, authConfig,
      sourcePermissionConfirmed: values['catalog-source-permission'],
      verifySource: values['catalog-source-permission'] ? fetch : undefined });
    server.on('listening', () => console.log(`Review UI: http://${publicHost}:${port} (listening on ${values.host})`));
    server.on('close', () => db.close());
  } catch (error) {
    db?.close();
    console.error(error);
    process.exitCode = 1;
  }
}
