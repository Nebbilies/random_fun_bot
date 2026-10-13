import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { request } from 'node:http';
import { openCatalog, setMeta } from '../lib/catalogDb.js';
import { createFranchise } from '../lib/franchiseCatalog.js';
import { createFranchiseReviewServer } from '../scripts/reviewFranchises.js';
import { createReviewServer } from '../scripts/reviewCharacterTags.js';

async function post(origin, path, body) {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test('local franchise review API shows source and counts, then applies validated corrections', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'franchise-review-'));
  const db = openCatalog(join(directory, 'catalog.sqlite'));
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  db.prepare(`INSERT INTO characters (id, rank, favourites, name_full) VALUES (1, 1, 900, 'Kirito')`).run();
  db.prepare(`INSERT INTO anime (id, title_english, fetched_at) VALUES
    (100, 'Sword Art Online', 'now'), (101, 'Sword Art Online II', 'now')`).run();
  db.prepare(`INSERT INTO franchises (id, display_name, created_at) VALUES (10, 'Sword Art Online', 'now')`).run();
  db.prepare(`INSERT INTO franchise_anime (franchise_id, anime_id, source) VALUES (10, 100, 'automatic'), (10, 101, 'automatic')`).run();
  db.prepare(`INSERT INTO anime_relations (from_anime_id, to_anime_id, relation_type) VALUES (100, 101, 'SEQUEL')`).run();
  db.prepare(`INSERT INTO character_anime (character_id, anime_id) VALUES (1, 100)`).run();
  const server = createFranchiseReviewServer({ db, port: 0 });
  t.after(() => server.close());
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;

  const initial = await fetch(`${origin}/api/franchise?id=10`).then((response) => response.json());
  assert.equal(initial.characterCount, 1);
  assert.equal(initial.members.length, 2);
  assert.deepEqual(initial.members[0].relations, ['SEQUEL']);

  assert.equal((await post(origin, '/api/correction', { action: 'rename', franchiseId: 10, name: 'SAO' })).status, 200);
  assert.equal((await post(origin, '/api/correction', { action: 'add_alias', franchiseId: 10, alias: 'Sword Art' })).status, 200);
  assert.equal((await post(origin, '/api/correction', { action: 'remove_anime', animeId: 100 })).status, 200);
  const excluded = await fetch(`${origin}/api/unassigned`).then((response) => response.json());
  assert.deepEqual(excluded.map((row) => row.id), [100]);
  assert.equal((await post(origin, '/api/correction', { action: 'move_anime', animeId: 100, franchiseId: 10 })).status, 200);
  const updated = await fetch(`${origin}/api/franchise?id=10`).then((response) => response.json());
  assert.equal(updated.name, 'SAO');
  assert.equal(updated.members.some((member) => member.id === 100), true);
  assert.ok(updated.manual.decisions >= 2);
  assert.equal((await post(origin, '/api/correction', { action: 'rename', franchiseId: 10, name: 'x' })).status, 400);
});

test('local franchise review rejects a foreign Host header', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'franchise-review-host-'));
  const db = openCatalog(join(directory, 'catalog.sqlite'));
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  const server = createFranchiseReviewServer({ db, port: 0 });
  t.after(() => server.close());
  await once(server, 'listening');
  const response = await new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: server.address().port, path: '/', headers: { host: 'evil.example' } }, (res) => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(response, 403);
});

test('catalog review server mounts franchise review and API under one port', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'combined-review-'));
  const db = openCatalog(join(directory, 'catalog.sqlite'));
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  setMeta(db, 'import_phase', 'complete');
  const id = createFranchise(db, 'Sword Art Online');
  const server = createReviewServer({ db, port: 0 });
  t.after(() => server.close());
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;

  const catalogPage = await fetch(`${origin}/`).then((response) => response.text());
  assert.match(catalogPage, /href="\/franchise"/);
  const page = await fetch(`${origin}/franchise`).then((response) => response.text());
  assert.match(page, /href="\/"/);
  const rows = await fetch(`${origin}/franchise/api/franchises`).then((response) => response.json());
  assert.deepEqual(rows.map((row) => row.name), ['Sword Art Online']);
  const response = await post(origin, '/franchise/api/correction', { action: 'rename', franchiseId: id, name: 'SAO' });
  assert.equal(response.status, 200);
  assert.equal(db.prepare('SELECT display_name FROM franchises WHERE id = ?').get(id).display_name, 'SAO');
});
