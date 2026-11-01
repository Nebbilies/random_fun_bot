import { readFileSync } from 'node:fs';

// Keep the public asset list explicit: server modules and local data are never served.
const assets = new Map([
  ['portal.css', 'text/css'],
  ['portal.js', 'text/javascript'],
  ['login.js', 'text/javascript'],
  ['franchisePicker.js', 'text/javascript'],
  ['reviewCharacterTags.js', 'text/javascript'],
  ['reviewCharacterGenders.js', 'text/javascript'],
  ['reviewFranchises.js', 'text/javascript'],
  ['reviewGame.js', 'text/javascript'],
  ['reviewConfig.js', 'text/javascript'],
  ['config.css', 'text/css'],
].map(([name, type]) => [`/assets/${name}`, {
  type: `${type}; charset=utf-8`,
  body: readFileSync(new URL(`./assets/${name}`, import.meta.url)),
}]));

export function serveAssets(request, response, url) {
  if (request.method !== 'GET') return false;
  const asset = assets.get(url.pathname);
  if (!asset) return false;
  response.writeHead(200, {
    'content-type': asset.type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(asset.body);
  return true;
}
