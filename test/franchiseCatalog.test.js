import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCatalog } from '../lib/catalogDb.js';
import { addFranchiseAlias, createFranchise, groupAnimeByFranchise, mergeFranchises, moveAnimeToFranchise, removeFranchiseAlias, renameFranchise } from '../lib/franchiseCatalog.js';
import { AniListCatalogApi } from '../lib/anilistCatalogApi.js';
import { findFranchises, isFranchiseCatalogCurrent, loadFranchiseCharacters, loadFranchiseIndex } from '../lib/franchiseLookup.js';
import { runFranchiseImport } from '../scripts/importFranchiseCatalog.js';
import { getMeta, setMeta } from '../lib/catalogDb.js';

test('catalog migration adds franchise storage and preserves the published character catalog', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'franchise-schema-'));
  const path = join(directory, 'catalog.sqlite');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE catalog_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE characters (id INTEGER PRIMARY KEY, name_full TEXT);
    INSERT INTO characters (id, name_full) VALUES (11757, 'Kirito');
    PRAGMA user_version = 3;`);
  old.close();

  let db;
  t.after(() => { db?.close(); rmSync(directory, { recursive: true, force: true }); });
  db = openCatalog(path);

  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 6);
  assert.equal(db.prepare('SELECT name_full FROM characters WHERE id = 11757').get().name_full, 'Kirito');
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
  for (const name of ['anime', 'character_anime', 'anime_relations', 'franchises', 'franchise_anime', 'franchise_aliases']) {
    assert.ok(tables.has(name), `missing ${name}`);
  }
});

test('franchise grouping follows story and spin-off relations but ignores loose shared-universe links', () => {
  const groups = groupAnimeByFranchise(
    [{ id: 11757 }, { id: 20594 }, { id: 21403 }, { id: 100182 }, { id: 20021 }, { id: 90001 }, { id: 90002 }],
    [
      { fromAnimeId: 11757, toAnimeId: 20594, relationType: 'SEQUEL' },
      { fromAnimeId: 20594, toAnimeId: 21403, relationType: 'SEQUEL' },
      { fromAnimeId: 21403, toAnimeId: 100182, relationType: 'SEQUEL' },
      { fromAnimeId: 20594, toAnimeId: 20021, relationType: 'SPIN_OFF' },
      { fromAnimeId: 11757, toAnimeId: 90001, relationType: 'ALTERNATIVE' },
      { fromAnimeId: 100182, toAnimeId: 90002, relationType: 'SAME_UNIVERSE' },
    ],
  );

  assert.deepEqual(groups, [[11757, 20021, 20594, 21403, 90001, 100182], [90002]]);
});

test('AniList client retrieves paged anime appearances and batched anime metadata', async () => {
  const requests = [];
  const api = new AniListCatalogApi({
    gapMs: 0,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      const data = body.query.includes('Character(id: $id)')
        ? { Character: { media: { pageInfo: { hasNextPage: true }, nodes: [{ id: 42 }] } } }
        : { Page: { media: [{ id: 42, genres: ['Action'], relations: { edges: [] } }] } };
      return { ok: true, status: 200, json: async () => ({ data }) };
    },
  });

  const page = await api.characterAnimePage(7, 2);
  const media = await api.animeDetails([42, 43]);

  assert.deepEqual(page.nodes, [{ id: 42 }]);
  assert.deepEqual(requests[0].variables, { id: 7, page: 2 });
  assert.deepEqual(media, [{ id: 42, genres: ['Action'], relations: { edges: [] } }]);
  assert.deepEqual(requests[1].variables, { ids: [42, 43] });
});

test('franchise search resolves aliases and returns each catalog character once by rank', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'franchise-lookup-'));
  const db = openCatalog(join(directory, 'catalog.sqlite'));
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  db.prepare(`INSERT INTO characters (id, rank, favourites, name_full) VALUES
    (1, 1, 900, 'Kirito'), (2, 2, 800, 'Asuna'), (3, 3, 700, 'LLENN')`).run();
  db.prepare(`INSERT INTO franchises (id, display_name, created_at) VALUES
    (10, 'Sword Art Online', 'now'), (20, 'Sword Art Online Alternative', 'now')`).run();
  db.prepare(`INSERT INTO franchise_aliases (franchise_id, alias, normalized_alias, source) VALUES
    (10, 'SAO', 'sao', 'manual'), (20, 'SAO', 'sao', 'manual')`).run();
  db.prepare(`INSERT INTO anime (id, title_english, fetched_at) VALUES
    (100, 'Sword Art Online', 'now'), (101, 'Sword Art Online II', 'now'),
    (200, 'Sword Art Online Alternative: Gun Gale Online', 'now')`).run();
  db.prepare(`INSERT INTO franchise_anime (franchise_id, anime_id) VALUES
    (10, 100), (10, 101), (20, 200)`).run();
  db.prepare(`INSERT INTO character_anime (character_id, anime_id) VALUES
    (1, 100), (1, 101), (2, 100), (3, 200)`).run();

  const matches = findFranchises(loadFranchiseIndex(db), 'sao');
  assert.deepEqual(matches.map((row) => row.id), [10, 20]);
  assert.deepEqual(loadFranchiseCharacters(db, 10).map((row) => [row.id, row.rank]), [[1, 1], [2, 2]]);
});

test('franchise lookup is current only when it matches the published character catalog', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'franchise-freshness-'));
  const db = openCatalog(join(directory, 'catalog.sqlite'));
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  setMeta(db, 'published_at', 'one');
  assert.equal(isFranchiseCatalogCurrent(db), false);
  setMeta(db, 'franchise_source_published_at', 'one');
  assert.equal(isFranchiseCatalogCurrent(db), true);
  setMeta(db, 'published_at', 'two');
  assert.equal(isFranchiseCatalogCurrent(db), false);
});

test('manual franchise names, aliases, moves, and merges are stored as durable decisions', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'franchise-corrections-'));
  const db = openCatalog(join(directory, 'catalog.sqlite'));
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  db.prepare(`INSERT INTO anime (id, title_english, fetched_at) VALUES
    (100, 'Sword Art Online', 'now'), (200, 'Gun Gale Online', 'now')`).run();
  const main = createFranchise(db, 'Sword Art Online');
  const spinOff = createFranchise(db, 'Gun Gale Online');
  renameFranchise(db, main, 'Sword Art Online Franchise');
  addFranchiseAlias(db, main, 'SAO');
  moveAnimeToFranchise(db, 100, main);
  moveAnimeToFranchise(db, 200, spinOff);
  mergeFranchises(db, spinOff, main);

  assert.equal(db.prepare('SELECT display_name FROM franchises WHERE id = ?').get(main).display_name, 'Sword Art Online Franchise');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM franchise_anime WHERE franchise_id = ?').get(main).n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM franchise_anime WHERE franchise_id = ?').get(spinOff).n, 0);
  assert.equal(db.prepare('SELECT franchise_id FROM franchise_membership_overrides WHERE anime_id = 200').get().franchise_id, main);
  assert.ok(db.prepare("SELECT 1 FROM franchise_aliases WHERE franchise_id = ? AND normalized_alias = 'sao'").get(main));
  removeFranchiseAlias(db, main, 'SAO');
  assert.equal(findFranchises(loadFranchiseIndex(db), 'SAO').length, 0);
});

test('enrichment imports every character anime page and follows related anime into one searchable franchise', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'franchise-import-'));
  const db = openCatalog(join(directory, 'catalog.sqlite'));
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  db.prepare(`INSERT INTO characters (id, rank, favourites, name_full) VALUES (1, 1, 900, 'Kirito')`).run();
  setMeta(db, 'import_phase', 'complete');
  setMeta(db, 'published_at', 'catalog-snapshot-1');
  const pages = [];
  const details = new Map([
    [11757, { id: 11757, title: { english: 'Sword Art Online' }, format: 'TV', popularity: 700000,
      relations: { edges: [{ typeV3: 'SEQUEL', typeV2: 'SEQUEL', node: { id: 20594, type: 'ANIME' } }] } }],
    [20594, { id: 20594, title: { english: 'Sword Art Online II' }, format: 'TV', popularity: 450000,
      relations: { edges: [{ typeV3: null, typeV2: 'COMPILATION', node: { id: 20021, type: 'ANIME' } }] } }],
    [20021, { id: 20021, title: { english: 'Sword Art Online Alternative: Gun Gale Online' }, format: 'TV', popularity: 40000,
      relations: { edges: [] } }],
  ]);
  const api = {
    characterAnimePage: async (id, page) => {
      pages.push([id, page]);
      return page === 1
        ? { pageInfo: { hasNextPage: true }, nodes: [{ id: 11757 }] }
        : { pageInfo: { hasNextPage: false }, nodes: [{ id: 20594 }] };
    },
    animeDetails: async (ids) => ids.map((id) => details.get(id)).filter(Boolean),
  };
  const logs = [];

  await runFranchiseImport({ db, api, log: (message) => logs.push(message) });

  assert.deepEqual(pages, [[1, 1], [1, 2]]);
  assert.ok(logs.some((message) => message.includes('Character #1: Kirito')));
  assert.ok(logs.some((message) => message.includes('Anime page 2') && message.includes('20594')));
  assert.ok(logs.some((message) => message.includes('Anime #11757: Sword Art Online')));
  assert.ok(logs.some((message) => message.includes('Relation SEQUEL: #11757 → #20594')));
  assert.equal(getMeta(db, 'franchise_source_published_at'), 'catalog-snapshot-1');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM anime').get().n, 3);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM character_anime').get().n, 2);
  const franchise = findFranchises(loadFranchiseIndex(db), 'Gun Gale Online')[0];
  assert.ok(franchise);
  assert.deepEqual(loadFranchiseCharacters(db, franchise.id).map((row) => row.name_full), ['Kirito']);

  renameFranchise(db, franchise.id, 'Sword Art Online Franchise');
  addFranchiseAlias(db, franchise.id, 'SAO');
  const split = createFranchise(db, 'Manual side story group');
  moveAnimeToFranchise(db, 20021, split);
  await runFranchiseImport({ db, api, refresh: true, log: () => {} });
  assert.equal(db.prepare('SELECT display_name FROM franchises WHERE id = ?').get(franchise.id).display_name, 'Sword Art Online Franchise');
  assert.equal(db.prepare('SELECT franchise_id FROM franchise_anime WHERE anime_id = 20021').get().franchise_id, split);
  assert.equal(findFranchises(loadFranchiseIndex(db), 'SAO')[0].id, franchise.id);
});

test('an interrupted refresh does not mark the older published franchise snapshot current', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'franchise-stale-refresh-'));
  const db = openCatalog(join(directory, 'catalog.sqlite'));
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  db.prepare(`INSERT INTO characters (id, rank, favourites, name_full) VALUES (1, 1, 900, 'Kirito')`).run();
  setMeta(db, 'import_phase', 'complete');
  setMeta(db, 'published_at', 'catalog-snapshot-2');
  setMeta(db, 'franchise_source_published_at', 'catalog-snapshot-1');
  setMeta(db, 'franchise_import_phase', 'complete');
  assert.equal(isFranchiseCatalogCurrent(db), false);
  await assert.rejects(runFranchiseImport({ db, api: {
    characterAnimePage: async () => { throw new Error('temporary request failure'); },
    animeDetails: async () => [],
  }, log: () => {} }), /temporary request failure/);
  assert.equal(isFranchiseCatalogCurrent(db), false);
  assert.equal(getMeta(db, 'franchise_source_published_at'), 'catalog-snapshot-1');
});
