import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { openCatalog } from '../lib/catalogDb.js';
import { convertLegacyCatalogToFinal } from '../lib/characterIdentityMigration.js';
import { migrateCharacterRanking } from '../lib/catalogRankingMigration.js';
import { loadCharacterIndex, findCharacters } from '../lib/gameCharacterLookup.js';
import { loadFranchiseIndex, findFranchises, loadFranchiseCharacters } from '../lib/franchiseLookup.js';
import { createCatalogCache } from '../lib/catalogCache.js';

// Deliberately no path argument, default database, API client, or network transport.
// Reproduce: node scripts/benchmarkCatalogRelease.js --synthetic --sizes=1000,10000 --iterations=20
function argumentsFor(argv) {
  if (!argv.includes('--synthetic')) throw new Error('Explicit --synthetic required; only disposable temporary databases are supported.');
  const options = { sizes: [1000, 10000], iterations: 20 };
  const seen = new Set();
  for (const arg of argv) {
    const key = arg.split('=')[0];
    if (seen.has(key)) throw new Error(`Duplicate option: ${key}`);
    seen.add(key);
    if (arg === '--synthetic') continue;
    if (arg.startsWith('--sizes=')) options.sizes = arg.slice(8).split(',').map(Number);
    else if (arg.startsWith('--iterations=')) options.iterations = Number(arg.slice(13));
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!options.sizes.length || options.sizes.length > 10 || options.sizes.some(n => !Number.isInteger(n) || n < 1000 || n > 10000)) {
    throw new Error('--sizes must contain 1–10 character counts between 1000 and 10000.');
  }
  if (!Number.isInteger(options.iterations) || options.iterations < 1 || options.iterations > 100) {
    throw new Error('--iterations must be between 1 and 100.');
  }
  return options;
}
const timed = fn => {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
};
const rounded = n => Number(n.toFixed(3));

function seed(db, count) {
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 10);
  db.exec('BEGIN IMMEDIATE');
  try {
    const character = db.prepare(`INSERT INTO characters(id,rank,favourites,name_full,name_alternatives,anime_titles,anime_ids)
      VALUES(?,?,?,?,?,?,?)`);
    const identity = db.prepare('INSERT INTO character_identities(id,name_full) VALUES(?,?)');
    const membership = db.prepare('INSERT INTO character_anime VALUES(?,?)');
    const marriage = db.prepare("INSERT INTO marriages(guild_id,character_id,owner_id,married_at) VALUES('synthetic',?,'owner','synthetic')");
    for (let id = 1; id <= count; id++) {
      const series = 1 + (id - 1) % 20;
      const name = `Synthetic Character ${String(id).padStart(5, '0')}`;
      character.run(id, id, count - id, name, JSON.stringify([`Synthetic Alias ${id}`]), JSON.stringify([`Synthetic Series ${series}`]), JSON.stringify([series]));
      identity.run(id, name);
      membership.run(id, series);
      if (id % 10 === 0) marriage.run(id);
    }
    const franchise = db.prepare("INSERT INTO franchises(id,display_name,created_at) VALUES(?,?,'synthetic')");
    const anime = db.prepare("INSERT INTO anime(id,title_romaji,fetched_at) VALUES(?,?,'synthetic')");
    const link = db.prepare('INSERT INTO franchise_anime(franchise_id,anime_id) VALUES(?,?)');
    const alias = db.prepare("INSERT INTO franchise_aliases VALUES(?,?,?,'automatic')");
    for (let id = 1; id <= 20; id++) {
      franchise.run(id, `Synthetic Series ${id}`);
      anime.run(id, `Synthetic Series ${id}`);
      link.run(id, id);
      alias.run(id, `Series Alias ${id}`, `series alias ${id}`);
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

function measure(db, iterations) {
  const characterLoad = timed(() => loadCharacterIndex(db));
  const franchiseLoad = timed(() => loadFranchiseIndex(db));
  const characters = characterLoad.value;
  const franchises = franchiseLoad.value;
  const queries = ['#1', `#${characters.length}`, 'Synthetic Character 00042', 'Synthetic Alias 42', 'Synthetic Character', 'Not Present'];
  const franchiseQueries = ['Synthetic Series 1', 'Series Alias 2', 'Synthetic Series', 'Not Present'];
  // Compare semantic content/rank instead of IDs: migration deliberately assigns UUIDs.
  const searchResults = queries.map(query => findCharacters(characters, query).map(row => [row.rank, row.name_full]));
  const franchiseResults = franchiseQueries.map(query => findFranchises(franchises, query).map(row => row.id));
  const membershipResults = Array.from({ length: 20 }, (_, i) => loadFranchiseCharacters(db, i + 1, 'synthetic')
    .map(row => [row.rank, row.name_full, row.married]));
  const query = db.prepare('SELECT rank,name_full,favourites FROM characters WHERE rank BETWEEN ? AND ? ORDER BY rank');
  const sqlResults = query.all(10, 30).map(row => ({ ...row }));
  // Warm each measured operation before the batch; report totals, not noisy single-call claims.
  const search = () => queries.reduce((n, q) => n + findCharacters(characters, q).length, 0);
  const franchiseSearch = () => franchiseQueries.reduce((n, q) => n + findFranchises(franchises, q).length, 0);
  const memberships = () => Array.from({ length: 20 }, (_, i) => loadFranchiseCharacters(db, i + 1, 'synthetic').length).reduce((a, b) => a + b, 0);
  const range = () => query.all(10, 30).length;
  function batch(fn) {
    fn();
    return timed(() => { let rows = 0; for (let i = 0; i < iterations; i++) rows += fn(); return rows; });
  }
  const searches = batch(search);
  const franchiseSearches = batch(franchiseSearch);
  const memberQueries = batch(memberships);
  const rangeQueries = batch(range);
  const cache = createCatalogCache(db);
  const cacheCold = timed(() => cache.get());
  const cacheWarm = batch(() => cache.get().characterIndex.length);
  return {
    semantic: { searchResults, franchiseResults, membershipResults, sqlResults },
    counts: { characters: characters.length, franchises: franchises.length,
      memberships: membershipResults.reduce((n, rows) => n + rows.length, 0),
      married: membershipResults.flat().filter(row => row[2] === 1).length,
      characterSearchRows: searches.value, franchiseSearchRows: franchiseSearches.value,
      membershipQueryRows: memberQueries.value, rangeQueryRows: rangeQueries.value,
      warmCacheCharacters: cacheWarm.value },
    ms: Object.fromEntries(Object.entries({ characterIndexLoad: characterLoad.ms, franchiseIndexLoad: franchiseLoad.ms,
      characterSearchBatch: searches.ms, franchiseSearchBatch: franchiseSearches.ms,
      membershipQueryBatch: memberQueries.ms, rankRangeQueryBatch: rangeQueries.ms,
      cacheCold: cacheCold.ms, cacheWarmBatch: cacheWarm.ms }).map(([key, value]) => [key, rounded(value)])),
  };
}

function run(size, iterations) {
  const directory = mkdtempSync(join(tmpdir(), 'catalog-release-benchmark-synthetic-'));
  const path = join(directory, 'synthetic.sqlite');
  let db;
  try {
    db = openCatalog(path);
    const seeded = timed(() => seed(db, size));
    db.close(); db = undefined;
    const legacyOpen = timed(() => openCatalog(path));
    db = legacyOpen.value;
    const old = measure(db, iterations);
    const migration = timed(() => convertLegacyCatalogToFinal(db, { dryRun: false }));
    assert.equal(migration.value.committed, true);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 12);
    const ranking = timed(() => migrateCharacterRanking(db, { actor: 'synthetic-benchmark', dryRun: false,
      inputs: { hashes: { danbooru: 'a'.repeat(64), mudae: 'b'.repeat(64) },
        records: db.prepare('SELECT id,rank FROM characters ORDER BY rank').all().map(row => ({ id: row.id,
          tag: null, danbooru_post_count: null, mudae_claim_rank: row.rank, mudae_character_url: null })) } }));
    assert.equal(ranking.value.committed, true);
    db.close(); db = undefined;
    const finalOpen = timed(() => openCatalog(path)); // Normal startup, not raw SQLite or bridge schema.
    db = finalOpen.value;
    const current = measure(db, iterations);
    assert.deepEqual(current.semantic, old.semantic);
    assert.deepEqual(current.counts, old.counts);
    assert.equal(current.counts.characters, size);
    assert.equal(current.counts.memberships, size);
    assert.equal(current.counts.married, Math.floor(size / 10));
    assert.equal(db.prepare('SELECT count(*) n FROM character_sources').get().n, size);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    return { characters: size, iterations, semanticComparison: 'equal (ranks/names/memberships/ownership; IDs intentionally change)',
      counts: { old: old.counts, final: current.counts },
      ms: { seed: rounded(seeded.ms), migrationV10ToPreRankingV12: rounded(migration.ms), rankingCutover: rounded(ranking.ms),
        old: { normalReopen: rounded(legacyOpen.ms), ...old.ms },
        final: { normalReopen: rounded(finalOpen.ms), ...current.ms } } };
  } finally {
    db?.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

try {
  const options = argumentsFor(process.argv.slice(2));
  console.log(JSON.stringify({ benchmark: 'synthetic catalog release only', node: process.version,
    platform: process.platform, arch: process.arch, timing: 'performance.now milliseconds; batches include iterations; one local sample, no production guarantee',
    options, workload: '6 character searches, 4 franchise searches, 20 membership queries, 1 rank range per iteration; index loads/cache cold once',
    network: 'none', storage: 'fresh disposable OS temp directories; removed after each size' }));
  for (const size of options.sizes) console.log(JSON.stringify(run(size, options.iterations)));
  console.log(JSON.stringify({ status: 'ok', cleanup: 'all synthetic temporary directories removed' }));
} catch (error) {
  console.error(error.stack);
  process.exitCode = 1;
}
