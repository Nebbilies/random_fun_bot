import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AniListCatalogApi } from '../lib/anilistCatalogApi.js';
import { getMeta, openCatalog, setMeta, transaction } from '../lib/catalogDb.js';
import { isFranchiseRelation, publishFranchiseCatalog, stageFranchiseBatch } from '../lib/franchiseCatalog.js';

const PAGE_LIMIT = 200;
const BATCH_SIZE = 25;
function stageAnimeIds(db) {
  return new Set(db.prepare('SELECT id FROM stage_anime').all().map((row) => row.id));
}

async function characterAppearances(api, characterId) {
  const ids = [];
  for (let page = 1; ; page++) {
    if (page > PAGE_LIMIT) throw new Error(`AniList anime depth exceeded for character ${characterId}`);
    const connection = await api.characterAnimePage(characterId, page);
    if (!connection?.pageInfo || !Array.isArray(connection.nodes))
      throw new Error(`Incomplete anime page ${page} for character ${characterId}`);
    for (const item of connection.nodes) {
      if (!Number.isInteger(item.id)) throw new Error(`Invalid anime ID for character ${characterId}`);
      ids.push(item.id);
    }
    if (!connection.pageInfo.hasNextPage) return [...new Set(ids)];
  }
}

async function relatedMedia(api, startIds, knownIds) {
  const queue = [...startIds].filter((id) => !knownIds.has(id));
  const queued = new Set(queue);
  const fetched = [];
  const relations = [];
  while (queue.length) {
    const batch = queue.splice(0, 25);
    const media = await api.animeDetails(batch);
    if (!Array.isArray(media)) throw new Error('AniList returned an invalid anime detail batch');
    const returned = new Set(media.map((item) => item.id));
    const missing = batch.filter((id) => !returned.has(id));
    if (missing.length) throw new Error(`AniList omitted anime IDs: ${missing.join(', ')}`);
    for (const item of media) {
      if (!Number.isInteger(item.id)) throw new Error('AniList returned an invalid anime record');
      fetched.push(item);
      for (const edge of item.relations?.edges ?? []) {
        if (edge.node?.type !== 'ANIME' || !Number.isInteger(edge.node.id)) continue;
        const relationType = edge.typeV3 ?? edge.typeV2 ?? edge.relationType;
        if (!relationType) continue;
        relations.push([item.id, edge.node.id, relationType]);
        if (isFranchiseRelation(relationType) && !knownIds.has(edge.node.id) && !queued.has(edge.node.id)) {
          queued.add(edge.node.id);
          queue.push(edge.node.id);
        }
      }
      knownIds.add(item.id);
    }
  }
  return { media: fetched, relations };
}

export async function runFranchiseImport({ db, api, refresh = false, batchSize = BATCH_SIZE, log = console.log }) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) throw new Error('Invalid franchise batch size');
  if (getMeta(db, 'import_phase') !== 'complete') throw new Error('Publish the character catalog before importing anime franchises');
  const publishedAt = getMeta(db, 'published_at');
  const phase = getMeta(db, 'franchise_import_phase');
  if (phase === 'complete' && getMeta(db, 'franchise_source_published_at') === publishedAt && !refresh) {
    log('Franchise catalog already complete. Use --refresh after a character catalog refresh.');
    return;
  }
  if (phase === 'running' && getMeta(db, 'franchise_import_source_published_at') !== publishedAt)
    throw new Error('Character catalog changed during franchise import; restart with --refresh');
  if (phase !== 'running' || refresh) {
    transaction(db, () => {
      db.exec('DELETE FROM stage_anime; DELETE FROM stage_character_anime; DELETE FROM stage_anime_relations;');
      setMeta(db, 'franchise_character_cursor', 0);
      setMeta(db, 'franchise_import_source_published_at', publishedAt);
      setMeta(db, 'franchise_import_phase', 'running');
    });
  }

  const knownIds = stageAnimeIds(db);
  let cursor = Number(getMeta(db, 'franchise_character_cursor') ?? 0);
  for (;;) {
    const characters = db.prepare('SELECT id FROM characters WHERE id > ? ORDER BY id LIMIT ?').all(cursor, batchSize);
    if (!characters.length) break;
    const appearances = [];
    const appearanceIds = new Set();
    for (const { id } of characters) {
      for (const animeId of await characterAppearances(api, id)) {
        appearances.push([id, animeId]);
        appearanceIds.add(animeId);
      }
    }
    const { media, relations } = await relatedMedia(api, appearanceIds, knownIds);
    cursor = characters.at(-1).id;
    stageFranchiseBatch(db, { media, appearances, relations, cursor });
    log(`Saved anime metadata for ${media.length} new entries and ${appearances.length} appearances through character ${cursor}.`);
  }

  const result = publishFranchiseCatalog(db);
  log(JSON.stringify({ ...result, sourcePublishedAt: publishedAt }, null, 2));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv.includes('--permission-confirmed')) {
    console.error('Bulk AniList franchise import requires a written permission grant. After receiving it, rerun with --permission-confirmed.');
    process.exitCode = 1;
  } else {
    const db = openCatalog();
    try {
      const api = new AniListCatalogApi();
      await runFranchiseImport({ db, api, refresh: process.argv.includes('--refresh') });
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    } finally {
      db.close();
    }
  }
}
