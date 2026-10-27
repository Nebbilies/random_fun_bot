import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { openCatalog } from '../lib/catalogDb.js';
import { convertLegacyCatalogToFinal } from '../lib/characterIdentityMigration.js';
import { createFranchiseReviewServer } from '../web/reviewFranchises.js';
import { createReviewServer } from '../web/reviewCharacterTags.js';
import { authConfig, login } from './helpers/portalAuth.js';

async function portal(t, { integrated = false, role = 'admin', legacy = false } = {}) {
  const db = openCatalog(':memory:');
  t.after(() => db.close());
  db.exec(`INSERT INTO characters (id, rank, favourites, name_full) VALUES (1, 1, 100, 'Legacy');
    INSERT INTO character_identities (id, name_full) VALUES (1, 'Legacy');
    INSERT INTO franchises (id, display_name, created_at) VALUES (10, 'Zenless Zone Zero', 'test');`);
  if (!legacy) convertLegacyCatalogToFinal(db, { dryRun: false });
  const server = (integrated ? createReviewServer : createFranchiseReviewServer)({ db, port: 0, authConfig });
  t.after(() => new Promise(resolve => server.close(resolve)));
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const client = await login(origin, role);
  async function api(path, body) {
    const response = await fetch(`${origin}${path}`, { method: body ? 'POST' : 'GET',
      headers: { origin, cookie: client.cookie, 'x-csrf-token': client.csrfToken, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    const value = await response.json();
    assert.equal(response.status, 200, JSON.stringify(value));
    return value;
  }
  const prefix = integrated ? '/franchise' : '';
  return { db, origin, api, prefix };
}

for (const integrated of [false, true]) for (const role of ['admin', 'moderator']) {
  test(`three ZZZ manual preview/confirm characters: ${integrated ? 'integrated' : 'standalone'} ${role}`, async t => {
    const { db, origin, api, prefix } = await portal(t, { integrated, role });
    assert.equal((await fetch(`${origin}${prefix}/api/franchises`)).status, 401);
    const ids = [];
    for (const [index, name] of ['Miyabi', 'Ellen Joe', 'Nicole Demara'].entries()) {
      const p = await api('/api/catalog/create/preview', { rank: index + 1, input: {
        name, gender: 'female', portraitUrl: `https://example.test/zzz/${index}`, franchiseIds: [10],
      } });
      assert.equal((await api(`${prefix}/api/franchise?id=10`)).characterCount, index, 'preview must not publish');
      const result = await api('/api/catalog/create/confirm', {
        previewId: p.previewId, payloadHash: p.payloadHash, idempotencyKey: `zzz-${index}`,
      });
      ids.push(result.characterId);
    }
    const list = await api(`${prefix}/api/franchises?query=Zenless`);
    assert.equal(list[0].characterCount, 3);
    assert.equal(list[0].animeCount, 0);
    assert.equal(list[0].manualMembers, 0);
    const detail = await api(`${prefix}/api/franchise?id=10`);
    assert.equal(detail.characterCount, 3);
    assert.deepEqual(detail.members, [], 'direct characters must not invent anime');
    assert.deepEqual(detail.directCharacters.map(c => [c.id, c.name, c.rank]),
      ids.map((id, i) => [id, ['Miyabi', 'Ellen Joe', 'Nicole Demara'][i], i + 1]));
    assert.equal(detail.automaticMembers, 0);
    assert.equal(detail.manualMembers, 0);

    // A direct character also reachable through two anime counts once. Anime/manual
    // totals must not multiply by either the anime character rows or direct rows.
    db.exec(`INSERT INTO anime (id, title_english, fetched_at) VALUES (100, 'One', 'test'), (101, 'Two', 'test');
      INSERT INTO franchise_anime (franchise_id, anime_id, source) VALUES (10, 100, 'manual'), (10, 101, 'automatic');`);
    const add = db.prepare('INSERT INTO character_anime (character_id, anime_id) VALUES (?, ?)');
    for (const animeId of [100, 101]) for (const id of ids.slice(0, 2)) add.run(id, animeId);
    add.run(db.prepare("SELECT id FROM characters WHERE name_full='Legacy'").get().id, 100);
    const mixed = (await api(`${prefix}/api/franchises`))[0];
    assert.equal(mixed.characterCount, 4);
    assert.equal(mixed.animeCount, 2);
    assert.equal(mixed.manualMembers, 1);
    const mixedDetail = await api(`${prefix}/api/franchise?id=10`);
    assert.equal(mixedDetail.characterCount, 4);
    assert.equal(mixedDetail.directCharacters.length, 3);
    assert.equal(mixedDetail.members.length, 2);
    assert.equal(mixedDetail.manualMembers, 1);
    assert.equal(mixedDetail.automaticMembers, 1);
  });
}

test('legacy anime-only relation stays distinct and has no direct character rows', async t => {
  const { db, api } = await portal(t, { legacy: true });
  db.exec(`INSERT INTO characters (id, rank, favourites, name_full) VALUES (2, 2, 50, 'Second');
    INSERT INTO anime (id, title_english, fetched_at) VALUES (100, 'One', 'test'), (101, 'Two', 'test');
    INSERT INTO franchise_anime (franchise_id, anime_id, source) VALUES (10, 100, 'manual'), (10, 101, 'automatic');
    INSERT INTO character_anime (character_id, anime_id) VALUES (1,100),(1,101),(2,100);`);
  const row = (await api('/api/franchises'))[0];
  assert.equal(row.characterCount, 2);
  assert.equal(row.animeCount, 2);
  assert.equal(row.manualMembers, 1);
  const detail = await api('/api/franchise?id=10');
  assert.equal(detail.characterCount, 2);
  assert.deepEqual(detail.directCharacters, []);
});

// Execute the actual browser module with a minimal DOM, as in catalogBrowserState.
function browser(detail, pathname) {
  class Element {
    constructor() { this.children = []; this.listeners = {}; this.value = ''; this.textContent = ''; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; this.textContent = ''; }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    setAttribute() {}
  }
  const html = readFileSync(new URL('../web/reviewFranchises.html', import.meta.url), 'utf8');
  const elements = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(([, id]) => [id, new Element()]));
  const paths = [];
  const context = vm.createContext({ document: { getElementById: id => elements[id], createElement: () => new Element() },
    location: { pathname }, URLSearchParams, feedback() {},
    createFranchisePicker: () => ({ element: new Element(), reset() {} }),
    fetch: async path => { paths.push(path); return { ok: true, json: async () => path.includes('/api/franchise?') ? detail
      : path.includes('/api/unassigned') ? [] : [{ id: 10, name: detail.name, characterCount: detail.characterCount, animeCount: 0, manualMembers: 0 }] }; },
  });
  const source = readFileSync(new URL('../web/assets/reviewFranchises.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '');
  vm.runInContext(source, context);
  return { elements, paths, load: () => vm.runInContext('loadDetails(10)', context) };
}

test('browser labels direct names/ranks safely and distinguishes no anime from no characters', async () => {
  for (const pathname of ['/', '/franchise']) {
    const data = { id: 10, name: 'Zenless Zone Zero', nameSource: 'manual', characterCount: 3,
      members: [], aliases: [], manual: { decisions: 0 }, automaticMembers: 0, manualMembers: 0,
      directCharacters: [{ id: 'm1', name: '<Miyabi>', rank: 1 }, { id: 'm2', name: 'Ellen Joe', rank: 2 }, { id: 'm3', name: 'Nicole Demara', rank: 3 }] };
    const b = browser(data, pathname);
    await b.load();
    assert.match(b.elements.summary.textContent, /3 current catalog characters · 0 anime/);
    assert.match(b.elements.members.textContent, /No anime members/);
    assert.equal(b.elements.directCharacters.children.length, 3);
    assert.match(b.elements.directCharacters.children[0].textContent, /#1.*<Miyabi>/);
    assert.equal(b.elements.directCharacters.children[0].children.length, 0, 'names are text, not HTML');
    assert.ok(b.paths.includes(`${pathname === '/' ? '' : '/franchise'}/api/franchise?id=10`));
    data.directCharacters = []; data.characterCount = 0;
    await b.load();
    assert.match(b.elements.directCharacters.textContent, /No directly assigned characters/);
    assert.equal(b.elements.directCharacters.children.length, 0);
  }
});
