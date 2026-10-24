import { readFileSync } from 'node:fs';
import { getConfigView, saveConfigSection } from '../lib/gameConfig.js';

const html = readFileSync(new URL('./reviewConfig.html', import.meta.url));
const validGuild = (value) => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value);
function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}
async function bodyJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk);
    if (size > 65536) throw new Error('JSON body exceeds 64 KiB.');
    chunks.push(chunk);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Expected a JSON object.');
  return body;
}

export async function handleConfigRequest({ db, request, response, url, origin }) {
  if (request.method === 'GET' && url.pathname === '/config') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(html);
    return true;
  }
  if (!['/api/config', '/api/config/section', '/api/config/activate-schedule'].includes(url.pathname)) return false;
  if (request.method === 'GET' && url.pathname === '/api/config') {
    const guildId = url.searchParams.get('guildId');
    if (guildId !== null && !validGuild(guildId)) json(response, 400, { error: 'Enter a valid numeric server ID (up to 20 digits).' });
    else json(response, 200, getConfigView(db, guildId));
    return true;
  }
  if (request.method !== 'POST' || url.pathname === '/api/config') {
    json(response, 405, { error: 'Method not allowed.' });
    return true;
  }
  if (request.headers.origin !== origin) { json(response, 403, { error: 'Invalid origin' }); return true; }
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
    json(response, 415, { error: 'JSON required' }); return true;
  }
  let body;
  try { body = await bodyJson(request); }
  catch (error) { json(response, 400, { error: `Invalid JSON body. ${error.message}` }); return true; }
  const allowed = ['guildId', 'section', 'values', 'reset', 'expectedRevision', 'confirmActivation'];
  if (Object.keys(body).some((key) => !allowed.includes(key)) || (body.guildId != null && !validGuild(body.guildId))) {
    json(response, 400, { error: 'Invalid configuration request or server ID.' }); return true;
  }
  const activation = url.pathname === '/api/config/activate-schedule';
  if (activation && (body.section !== 'schedules' || body.confirmActivation !== true)) {
    json(response, 400, { error: 'Explicit schedule activation confirmation is required.' }); return true;
  }
  try {
    json(response, 200, saveConfigSection(db, {
      guildId: body.guildId ?? null, section: body.section, values: body.values ?? {}, reset: body.reset ?? [],
      expectedRevision: body.expectedRevision, activateSchedule: activation,
    }));
  } catch (error) {
    const status = error.code === 'CONFIG_STALE' ? 409 : error.code === 'CONFIG_STORAGE' ? 500 : 400;
    json(response, status, { error: error.message, code: error.code, reload: status === 409 });
  }
  return true;
}
