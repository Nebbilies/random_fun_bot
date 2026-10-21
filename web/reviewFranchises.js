import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  addFranchiseAlias, createFranchise, mergeFranchises, moveAnimeToFranchise,
  removeAnimeFromFranchise, removeFranchiseAlias, renameFranchise,
} from '../lib/franchiseCatalog.js';
import { openCatalog } from '../lib/catalogDb.js';
import { serveAssets } from './serveAssets.js';

const html = readFileSync(new URL('./reviewFranchises.html', import.meta.url));
const FRANCHISE_OPTION_LIMIT = 40;

function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

async function readJsonBody(request) {
  let data = '';
  for await (const chunk of request) {
    data += chunk;
    if (data.length > 8192) throw new Error('Request too large');
  }
  return JSON.parse(data);
}

function listFranchises(db, query = '') {
  const text = query.trim().toLocaleLowerCase('en-US');
  return db.prepare(`SELECT f.id, f.display_name AS name,
      COUNT(DISTINCT fa.anime_id) AS animeCount,
      COUNT(DISTINCT ca.character_id) AS characterCount,
      COALESCE(SUM(CASE WHEN fa.source = 'manual' THEN 1 ELSE 0 END), 0) AS manualMembers
    FROM franchises AS f
    LEFT JOIN franchise_anime AS fa ON fa.franchise_id = f.id
    LEFT JOIN character_anime AS ca ON ca.anime_id = fa.anime_id
    WHERE ? = '' OR LOWER(f.display_name) LIKE '%' || ? || '%'
      OR EXISTS (SELECT 1 FROM franchise_aliases AS x WHERE x.franchise_id = f.id
        AND x.source != 'excluded' AND LOWER(x.alias) LIKE '%' || ? || '%')
      OR EXISTS (SELECT 1 FROM franchise_anime AS m JOIN anime AS a ON a.id = m.anime_id
        WHERE m.franchise_id = f.id AND (LOWER(COALESCE(a.title_romaji, '')) LIKE '%' || ? || '%'
          OR LOWER(COALESCE(a.title_english, '')) LIKE '%' || ? || '%'))
    GROUP BY f.id ORDER BY f.display_name COLLATE NOCASE, f.id`).all(text, text, text, text, text);
}

// The picker needs the whole catalog, not the sidebar search slice, so options come from their own query.
function listFranchiseOptions(db, query = '', excludeId = 0) {
  const text = query.trim().toLocaleLowerCase('en-US');
  const like = `%${text}%`;
  const matched = text
    ? `LOWER(f.display_name) LIKE ? OR EXISTS (SELECT 1 FROM franchise_aliases AS x
        WHERE x.franchise_id = f.id AND x.source != 'excluded' AND LOWER(x.alias) LIKE ?)`
    : '1 = 1';
  const order = text
    ? `CASE WHEN LOWER(f.display_name) = ? THEN 0 WHEN LOWER(f.display_name) LIKE ? THEN 1 ELSE 2 END,
       f.display_name COLLATE NOCASE, f.id`
    : `(SELECT COUNT(*) FROM franchise_anime AS fa WHERE fa.franchise_id = f.id) DESC,
       f.display_name COLLATE NOCASE, f.id`;
  const params = text ? [excludeId, like, like, text, `${text}%`] : [excludeId];
  return db.prepare(`SELECT f.id, f.display_name AS name FROM franchises AS f
    WHERE f.id != ? AND (${matched}) ORDER BY ${order} LIMIT ${FRANCHISE_OPTION_LIMIT}`).all(...params);
}

function franchiseDetails(db, id) {
  const franchise = db.prepare('SELECT id, display_name AS name, name_source AS nameSource FROM franchises WHERE id = ?').get(id);
  if (!franchise) return null;
  const aliases = db.prepare(`SELECT alias, source FROM franchise_aliases
    WHERE franchise_id = ? AND source != 'excluded' ORDER BY alias COLLATE NOCASE`).all(id);
  const members = db.prepare(`SELECT a.id, a.title_romaji AS romaji, a.title_english AS english,
      a.title_native AS native, a.format, a.start_date AS startDate, a.season_year AS seasonYear,
      a.average_score AS score, a.popularity,
      COUNT(DISTINCT ca.character_id) AS characterCount,
      fa.source AS membershipSource
    FROM franchise_anime AS fa JOIN anime AS a ON a.id = fa.anime_id
    LEFT JOIN character_anime AS ca ON ca.anime_id = a.id
    WHERE fa.franchise_id = ? GROUP BY a.id ORDER BY a.popularity DESC, a.id`).all(id);
  const relationRows = db.prepare(`SELECT from_anime_id AS fromId, to_anime_id AS toId, relation_type AS type
    FROM anime_relations WHERE from_anime_id IN (SELECT anime_id FROM franchise_anime WHERE franchise_id = ?)
      AND to_anime_id IN (SELECT anime_id FROM franchise_anime WHERE franchise_id = ?)
    UNION
    SELECT from_anime_id AS fromId, to_anime_id AS toId, relation_type AS type
    FROM anime_relations WHERE to_anime_id IN (SELECT anime_id FROM franchise_anime WHERE franchise_id = ?)
      AND from_anime_id IN (SELECT anime_id FROM franchise_anime WHERE franchise_id = ?)`)
    .all(id, id, id, id);
  const relationTypesByAnime = new Map();
  for (const relation of relationRows) {
    for (const animeId of [relation.fromId, relation.toId]) {
      if (!relationTypesByAnime.has(animeId)) relationTypesByAnime.set(animeId, new Set());
      relationTypesByAnime.get(animeId).add(relation.type);
    }
  }
  for (const member of members) {
    member.title = member.english || member.romaji || member.native || `Anime #${member.id}`;
    member.relations = [...(relationTypesByAnime.get(member.id) ?? [])].sort();
  }
  const manualDecisions = db.prepare(`SELECT
      (SELECT COUNT(*) FROM franchise_aliases WHERE franchise_id = ? AND source = 'manual') +
      (SELECT COUNT(*) FROM franchises WHERE id = ? AND name_source = 'manual') +
      (SELECT COUNT(*) FROM franchise_membership_overrides WHERE franchise_id = ?) AS n`)
    .get(id, id, id).n;
  return { ...franchise, aliases, members, characterCount: db.prepare(`SELECT COUNT(DISTINCT ca.character_id) AS n
    FROM franchise_anime AS fa JOIN character_anime AS ca ON ca.anime_id = fa.anime_id WHERE fa.franchise_id = ?`).get(id).n,
    automaticMembers: members.filter((member) => member.membershipSource === 'automatic').length,
    manualMembers: members.filter((member) => member.membershipSource === 'manual').length,
    manual: { decisions: manualDecisions } };
}

function listUnassigned(db) {
  return db.prepare(`SELECT a.id, COALESCE(a.title_english, a.title_romaji, a.title_native, 'Anime #' || a.id) AS title,
      a.format, a.season_year AS seasonYear, COUNT(DISTINCT ca.character_id) AS characterCount
    FROM franchise_membership_overrides AS o JOIN anime AS a ON a.id = o.anime_id
    LEFT JOIN character_anime AS ca ON ca.anime_id = a.id
    WHERE o.franchise_id IS NULL GROUP BY a.id ORDER BY a.popularity DESC, a.id`).all();
}

function applyCorrection(db, body) {
  switch (body.action) {
    case 'create': return { franchiseId: createFranchise(db, body.name) };
    case 'rename': renameFranchise(db, body.franchiseId, body.name); break;
    case 'add_alias': addFranchiseAlias(db, body.franchiseId, body.alias); break;
    case 'remove_alias': removeFranchiseAlias(db, body.franchiseId, body.alias); break;
    case 'merge': mergeFranchises(db, body.sourceId, body.targetId); break;
    case 'move_anime': moveAnimeToFranchise(db, body.animeId, body.franchiseId); break;
    case 'remove_anime': removeAnimeFromFranchise(db, body.animeId); break;
    default: throw new Error('Unknown correction action');
  }
  return { saved: true };
}

export async function handleFranchiseReviewRequest({ db, request, response, url, origin, mountPath = '/franchise' }) {
  const prefix = mountPath.replace(/\/+$/, '');
  const route = (path) => `${prefix}${path}`;
  try {
    if (request.method === 'GET' && (url.pathname === (prefix || '/') || url.pathname === `${prefix}/`)) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(prefix ? html : html.toString().replace('data-standalone="false"', 'data-standalone="true"'));
    } else if (request.method === 'GET' && url.pathname === route('/api/franchises')) {
      const query = url.searchParams.get('query') || '';
      if (query.length > 80) { json(response, 400, { error: 'Search must be 80 characters or fewer' }); return true; }
      json(response, 200, listFranchises(db, query));
    } else if (request.method === 'GET' && url.pathname === route('/api/franchise-options')) {
      const query = url.searchParams.get('query') || '';
      if (query.length > 80) { json(response, 400, { error: 'Search must be 80 characters or fewer' }); return true; }
      const exclude = Number(url.searchParams.get('exclude') || 0);
      if (!Number.isSafeInteger(exclude) || exclude < 0) { json(response, 400, { error: 'Invalid franchise ID' }); return true; }
      json(response, 200, listFranchiseOptions(db, query, exclude));
    } else if (request.method === 'GET' && url.pathname === route('/api/unassigned')) {
      json(response, 200, listUnassigned(db));
    } else if (request.method === 'GET' && url.pathname === route('/api/franchise')) {
      const id = Number(url.searchParams.get('id'));
      if (!Number.isSafeInteger(id) || id < 1) { json(response, 400, { error: 'Invalid franchise ID' }); return true; }
      const details = franchiseDetails(db, id);
      json(response, details ? 200 : 404, details ?? { error: 'Unknown franchise' });
    } else if (request.method === 'POST' && url.pathname === route('/api/correction')) {
      if (request.headers.origin && request.headers.origin !== origin) {
        json(response, 403, { error: 'Invalid origin' }); return true;
      }
      if (!request.headers['content-type']?.startsWith('application/json')) {
        json(response, 415, { error: 'JSON required' }); return true;
      }
      const body = await readJsonBody(request);
      try { json(response, 200, applyCorrection(db, body)); }
      catch (error) { json(response, 400, { error: error.message }); }
    } else return false;
    return true;
  } catch (error) {
    json(response, 400, { error: error.message });
    return true;
  }
}

export function createFranchiseReviewServer({ db, host = '127.0.0.1', publicHost = host, port = 8788 }) {
  if (!publicHost || publicHost === '0.0.0.0') throw new Error('Set a public host when listening on all interfaces');
  const server = createServer(async (request, response) => {
    try {
      const actualPort = server.address()?.port ?? port;
      let origin;
      try {
        if (!request.headers.host) return json(response, 403, { error: 'Invalid host' });
        const authority = new URL(`http://${request.headers.host}`);
        if (authority.pathname !== '/' || authority.search || authority.hash || authority.username || authority.password
          || Number(authority.port || 80) !== actualPort || authority.hostname !== publicHost)
          return json(response, 403, { error: 'Invalid host' });
        origin = authority.origin;
      } catch { return json(response, 403, { error: 'Invalid host' }); }
      const url = new URL(request.url, origin);
      if (serveAssets(request, response, url)) return;
      if (!await handleFranchiseReviewRequest({ db, request, response, url, origin, mountPath: '' }))
        json(response, 404, { error: 'Not found' });
    } catch (error) { json(response, 400, { error: error.message }); }
  });
  server.listen(port, host);
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let db;
  try {
    const { values } = parseArgs({ options: {
      host: { type: 'string', default: '127.0.0.1' },
      port: { type: 'string', default: '8788' },
      'public-host': { type: 'string' },
    } });
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--port must be between 1 and 65535');
    if (!values.host) throw new Error('--host must not be empty');
    db = openCatalog();
    const publicHost = values['public-host'] ?? values.host;
    const server = createFranchiseReviewServer({ db, host: values.host, publicHost, port });
    server.on('listening', () => console.log(`Review UI: http://${publicHost}:${port} (listening on ${values.host})`));
    server.on('close', () => db.close());
  } catch (error) {
    db?.close();
    console.error(error);
    process.exitCode = 1;
  }
}
