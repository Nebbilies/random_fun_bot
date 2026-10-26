import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AniListCatalogApi } from '../lib/anilistCatalogApi.js';
import { getMeta, openCatalog, setMeta, transaction } from '../lib/catalogDb.js';
import { isFranchiseRelation, publishFranchiseCatalog, stageFranchiseBatch } from '../lib/franchiseCatalog.js';

import { characterAppearanceSourceToken } from '../lib/catalogFreshness.js';

const PAGE_LIMIT = 200;
const BATCH_SIZE = 25;
function stageAnimeIds(db) {
  return new Set(db.prepare('SELECT id FROM stage_anime').all().map((row) => row.id));
}

async function characterAppearances(api, characterId, characterName, log) {
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
    log(`  Anime page ${page} — ${characterName} (#${characterId}): ${connection.nodes.length} anime${connection.nodes.length ? ` (IDs ${connection.nodes.map((item) => item.id).join(', ')})` : ''}${connection.pageInfo.hasNextPage ? ', more pages' : ', last page'}.`);
    if (!connection.pageInfo.hasNextPage) return [...new Set(ids)];
  }
}

function animeTitle(item) {
  return item.title?.english || item.title?.romaji || item.title?.native || `Anime #${item.id}`;
}

async function relatedMedia(api, startIds, knownIds, log) {
  const queue = [...startIds].filter((id) => !knownIds.has(id));
  const queued = new Set(queue);
  const fetched = [];
  const relations = [];
  while (queue.length) {
    const batch = queue.splice(0, 25);
    log(`  Fetching anime metadata batch (${batch.length} IDs): ${batch.join(', ')}.`);
    const media = await api.animeDetails(batch);
    if (!Array.isArray(media)) throw new Error('AniList returned an invalid anime detail batch');
    const returned = new Set(media.map((item) => item.id));
    const missing = batch.filter((id) => !returned.has(id));
    if (missing.length) throw new Error(`AniList omitted anime IDs: ${missing.join(', ')}`);
    for (const item of media) {
      if (!Number.isInteger(item.id)) throw new Error('AniList returned an invalid anime record');
      fetched.push(item);
      log(`    Anime #${item.id}: ${animeTitle(item)}.`);
      for (const edge of item.relations?.edges ?? []) {
        if (edge.node?.type !== 'ANIME' || !Number.isInteger(edge.node.id)) continue;
        const relationType = edge.typeV3 ?? edge.typeV2 ?? edge.relationType;
        if (!relationType) continue;
        relations.push([item.id, edge.node.id, relationType]);
        log(`      Relation ${relationType}: #${item.id} → #${edge.node.id}${isFranchiseRelation(relationType) ? ' (queued for franchise metadata)' : ''}.`);
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
  const sourceToken = characterAppearanceSourceToken(db);
  const phase = getMeta(db, 'franchise_import_phase');
  if (phase === 'complete' && (getMeta(db, 'franchise_source_token') ?? getMeta(db, 'franchise_source_published_at')) === sourceToken && !refresh) {
    log('Franchise catalog already complete. Use --refresh after a character catalog refresh.');
    return;
  }
  if (phase === 'running' && (getMeta(db, 'franchise_import_source_token') ?? getMeta(db, 'franchise_import_source_published_at')) !== sourceToken)
    throw new Error('Character catalog changed during franchise import; restart with --refresh');
  if (phase !== 'running' || refresh) {
    transaction(db, () => {
      db.exec('DELETE FROM stage_anime; DELETE FROM stage_character_anime; DELETE FROM stage_anime_relations;');
      setMeta(db, 'franchise_character_cursor', 0);
      setMeta(db, 'franchise_import_source_published_at', publishedAt);
      setMeta(db, 'franchise_import_source_token', sourceToken);
      setMeta(db, 'franchise_import_phase', 'running');
    });
  }

  const knownIds = stageAnimeIds(db);
  let cursor = Number(getMeta(db, 'franchise_character_cursor') ?? 0);
  const sourceAware = Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='character_sources'").get());
  // Cursor is an external source ID, never an internal character UUID or rank.
  const sourceRows = sourceAware
    ? `SELECT c.id,c.name_full,CAST(s.external_id AS INTEGER) AS external_id FROM characters c
       JOIN character_sources s ON s.character_id=c.id WHERE s.source='anilist'`
    : 'SELECT id,name_full,id AS external_id FROM characters';
  const totalCharacters = db.prepare(`SELECT COUNT(*) AS n FROM (${sourceRows})`).get().n;
  const alreadyProcessed = db.prepare(`SELECT COUNT(*) AS n FROM (${sourceRows}) WHERE external_id <= ?`).get(cursor).n;
  log(`==== ${phase === 'running' && !refresh ? 'Resuming' : 'Starting'} franchise import: ${totalCharacters} catalog characters; ${alreadyProcessed} already processed; cursor ${cursor}. ====`);
  for (;;) {
    const characters = db.prepare(`SELECT * FROM (${sourceRows}) WHERE external_id > ? ORDER BY external_id LIMIT ?`).all(cursor, batchSize);
    if (!characters.length) break;
    log(`==== Processing ${characters.length} characters (${characters[0].id}-${characters.at(-1).id}) ====`);
    const appearances = [];
    const appearanceIds = new Set();
    for (const { id, external_id: externalId, name_full: name } of characters) {
      log(`Character #${id}: ${name || `Character ${id}`}`);
      const characterAnimeIds = await characterAppearances(api, externalId, name || `Character ${id}`, log);
      log(`  Found ${characterAnimeIds.length} unique anime appearances.`);
      for (const animeId of characterAnimeIds) {
        appearances.push([id, animeId]);
        appearanceIds.add(animeId);
      }
    }
    log(`Fetching metadata for ${appearanceIds.size} distinct anime across this character batch.`);
    const { media, relations } = await relatedMedia(api, appearanceIds, knownIds, log);
    cursor = characters.at(-1).external_id;
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
