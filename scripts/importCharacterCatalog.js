import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AniListCatalogApi } from '../lib/anilistCatalogApi.js';
import { getMeta, keepCandidate, openCatalog, publishCatalog, setMeta, transaction } from '../lib/catalogDb.js';
import { assertSourceCatalogStagingBinding, bindSourceCatalogStaging, sourceCatalogRevisionToken } from '../lib/sourceCatalogPublication.js';

const RANGE_SIZE = 500;
const TARGET_COUNT = 15_000;
const MIXED_SCAN_LIMIT = 30_000;
const FILTER_SCOPE = 'format!=MUSIC;status!=NOT_YET_RELEASED;averageScore>=50;popularity>15000';
const MIXED_SCOPE = `mixed-before-${FILTER_SCOPE}`;

function qualifiesAnime(media) {
  return media && media.format !== 'MUSIC' && media.status !== 'NOT_YET_RELEASED'
    && Number.isInteger(media.averageScore) && media.averageScore >= 50
    && Number.isInteger(media.popularity) && media.popularity > 15_000;
}

function characterSummary(nodes) {
  const names = nodes.slice(0, 4).map((character) => character.name?.full || `#${character.id}`);
  return `${nodes.length} characters${names.length ? `: ${names.join(', ')}${nodes.length > names.length ? ', ...' : ''}` : ''}`;
}

export async function scanOnePage(db, api, log = () => {}, binding = assertSourceCatalogStagingBinding(db)) {
  assertSourceCatalogStagingBinding(db, binding);
  const start = Number(getMeta(db, 'scan_range_start'));
  const maxId = Number(getMeta(db, 'scan_max_id'));
  if (start > maxId) {
    transaction(db, () => {
      assertSourceCatalogStagingBinding(db, binding);
      setMeta(db, 'import_phase', 'hydrate');
    });
    return false;
  }
  const page = Number(getMeta(db, 'scan_page'));
  const ids = Array.from({ length: Math.min(RANGE_SIZE, maxId - start + 1) }, (_, i) => start + i);
  log(`==== Scanning anime IDs ${start}-${ids.at(-1)} (page ${page}) ====`);
  const unfiltered = Number(getMeta(db, 'legacy_unfiltered_range_start')) === start;
  const result = await api.animePage(ids, page, { unfiltered });
  if (!result?.pageInfo || !Array.isArray(result.media)) throw new Error('Invalid AniList anime page');
  const eligibleMedia = unfiltered ? result.media.filter(qualifiesAnime) : result.media;
  if (unfiltered && eligibleMedia.length !== result.media.length)
    log(`  Skipped ${result.media.length - eligibleMedia.length} anime below the new eligibility rules in this saved range.`);
  const characters = [];
  for (const media of eligibleMedia) {
    const title = media.title?.english || media.title?.romaji || media.title?.native || `Anime #${media.id}`;
    log(`Anime #${media.id}: ${title}`);
    if (!media.characters?.pageInfo || !Array.isArray(media.characters.nodes))
      throw new Error(`Incomplete character connection for anime ${media.id}`);
    characters.push(...media.characters.nodes);
    log(`  Characters page 1 — ${characterSummary(media.characters.nodes)}`);
    let connection = media.characters;
    let characterPage = 1;
    while (connection.pageInfo.hasNextPage) {
      characterPage++;
      if (characterPage > 200) throw new Error(`AniList character depth exceeded for anime ${media.id}`);
      connection = await api.extraCharacters(media.id, characterPage);
      if (!connection?.pageInfo || !Array.isArray(connection.nodes))
        throw new Error(`Incomplete character page ${characterPage} for anime ${media.id}`);
      characters.push(...connection.nodes);
      log(`  Characters page ${characterPage} — ${characterSummary(connection.nodes)}`);
    }
  }
  transaction(db, () => {
    assertSourceCatalogStagingBinding(db, binding);
    const growing = getMeta(db, 'scan_mode') === 'growing';
    const stageLimit = growing ? null : Number(getMeta(db, 'stage_limit') ?? TARGET_COUNT);
    for (const character of characters) keepCandidate(db, character, stageLimit);
    setMeta(db, 'scan_range_start', result.pageInfo.hasNextPage ? start : start + RANGE_SIZE);
    setMeta(db, 'scan_page', result.pageInfo.hasNextPage ? page + 1 : 1);
    if (unfiltered && !result.pageInfo.hasNextPage) setMeta(db, 'legacy_unfiltered_range_start', 0);
    setMeta(db, 'scanned_media', Number(getMeta(db, 'scanned_media') ?? 0) + eligibleMedia.length);
    setMeta(db, 'scanned_pages', Number(getMeta(db, 'scanned_pages') ?? 0) + 1);
  });
  log(`Saved page: ${eligibleMedia.length} eligible anime, ${characters.length} character links; ${getMeta(db, 'scanned_media')} anime scanned total, ${db.prepare('SELECT COUNT(*) AS n FROM stage_characters').get().n} candidates kept.`);
  return true;
}

function updateDetails(db, character, media) {
  const titles = [...new Set(media.map((item) => item.title?.english || item.title?.romaji || item.title?.native).filter(Boolean))];
  const birthday = character.dateOfBirth;
  const dateOfBirth = birthday && [birthday.year, birthday.month, birthday.day].some(Boolean)
    ? JSON.stringify(birthday) : null;
  db.prepare(`UPDATE stage_characters SET name_full = ?, name_native = ?,
    name_alternatives = ?, gender = ?, age = ?, date_of_birth = ?, description = ?,
    image_url = ?, site_url = ?, anime_titles = ?, anime_ids = ?, anime_adult = ? WHERE id = ?`)
    .run(character.name?.full || character.name?.native || `Character ${character.id}`,
      character.name?.native ?? null, JSON.stringify(character.name?.alternative ?? []),
      character.gender ?? null, character.age ?? null, dateOfBirth,
      character.description ?? null, character.image?.large ?? null, character.siteUrl ?? null,
      JSON.stringify(titles), JSON.stringify(media.map((item) => item.id)),
      media.some((item) => item.isAdult) ? 1 : 0, character.id);
}

async function qualifyingMedia(api, character) {
  let connection = character.media;
  let page = 1;
  while (true) {
    if (!connection?.pageInfo || !Array.isArray(connection.nodes))
      throw new Error(`Incomplete anime list for character ${character.id}`);
    const eligible = connection.nodes.filter(qualifiesAnime);
    if (eligible.length || !connection.pageInfo.hasNextPage) return eligible;
    page++;
    if (page > 200) throw new Error(`AniList anime depth exceeded for character ${character.id}`);
    connection = await api.extraCharacterMedia(character.id, page);
  }
}

export async function hydrateOneBatch(db, api, log = () => {}, binding = assertSourceCatalogStagingBinding(db)) {
  assertSourceCatalogStagingBinding(db, binding);
  const sourceAware = Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='character_sources'").get());
  const existing = sourceAware
    ? `SELECT 1 FROM character_sources AS source JOIN characters AS c ON c.id=source.character_id
       WHERE source.source='anilist' AND source.external_id=CAST(stage.id AS TEXT)`
    : 'SELECT 1 FROM characters WHERE characters.id = stage.id';
  const ids = db.prepare(`SELECT stage.id FROM stage_characters AS stage
    WHERE stage.name_full IS NULL AND NOT EXISTS (${existing})
    ORDER BY stage.id LIMIT 25`).all().map((row) => row.id);
  if (!ids.length) return false;
  log(`==== Fetching character metadata for ${ids.length} finalists (IDs ${ids[0]}-${ids.at(-1)}) ====`);
  const details = await api.characterDetails(ids);
  const returnedIds = new Set(details.map((item) => item.id));
  const missingIds = ids.filter((id) => !returnedIds.has(id));
  const prepared = [];
  for (const character of details) prepared.push({ character, media: await qualifyingMedia(api, character) });
  transaction(db, () => {
    assertSourceCatalogStagingBinding(db, binding);
    const remove = db.prepare('DELETE FROM stage_characters WHERE id = ?');
    for (const id of missingIds) remove.run(id);
    for (const { character, media } of prepared) {
      if (media.length) updateDetails(db, character, media);
      else remove.run(character.id);
    }
  });
  if (missingIds.length) log(`Removed missing AniList character IDs: ${missingIds.join(', ')}.`);
  const kept = prepared.filter((item) => item.media.length).map((item) => item.character);
  log(`Saved character metadata: ${characterSummary(kept)}; excluded ${prepared.length - kept.length} without a qualifying anime.`);
  return true;
}

export async function runImport({ db, api, refresh = false, restart = false, log = console.log }) {
  let phase = getMeta(db, 'import_phase');
  let binding;
  if (refresh && !restart && phase && phase !== 'complete')
    throw new Error('Cannot refresh while an import is in progress; resume it without --refresh');
  if (phase === 'complete' && !refresh && !restart) {
    log('Catalog already complete. Use --refresh to build a new snapshot.');
    return;
  }
  if (!phase || refresh || restart) {
    // Capture before any network request; reject a source edit during discovery
    // setup rather than silently rebinding the new scan to a later revision.
    const token = sourceCatalogRevisionToken(db);
    const priorGeneration = getMeta(db, 'character_import_scan_generation');
    const maxId = await api.highestAnimeId();
    transaction(db, () => {
      if (getMeta(db, 'character_import_scan_generation') !== priorGeneration)
        throw new Error('Character import scan was replaced; restart discovery with --restart');
      db.exec('DELETE FROM stage_characters');
      binding = bindSourceCatalogStaging(db, token);
      setMeta(db, 'scan_started_at', new Date().toISOString());
      setMeta(db, 'scan_max_id', maxId);
      setMeta(db, 'scan_range_start', 1);
      setMeta(db, 'scan_page', 1);
      setMeta(db, 'scanned_media', 0);
      setMeta(db, 'scanned_pages', 0);
      setMeta(db, 'scan_scope', FILTER_SCOPE);
      setMeta(db, 'scan_mode', 'growing');
      setMeta(db, 'legacy_unfiltered_range_start', 0);
      setMeta(db, 'import_phase', 'scan');
    });
    phase = 'scan';
    log(`Scanning anime media IDs 1-${maxId}. This may take many hours.`);
  }
  // Saved typed staging without a binding predates this safety contract and
  // cannot be adopted retroactively, even when its current source IDs are free.
  if (binding === undefined) binding = assertSourceCatalogStagingBinding(db);
  assertSourceCatalogStagingBinding(db, binding);
  if (!getMeta(db, 'scan_scope')) {
    if (phase !== 'scan') throw new Error('This older scan is past discovery and cannot adopt the new filters without rebuilding');
    transaction(db, () => {
      assertSourceCatalogStagingBinding(db, binding);
      setMeta(db, 'scan_scope', MIXED_SCOPE);
      setMeta(db, 'stage_limit', MIXED_SCAN_LIMIT);
      setMeta(db, 'legacy_unfiltered_range_start', Number(getMeta(db, 'scan_page')) > 1
        ? getMeta(db, 'scan_range_start') : 0);
    });
    log(`==== Continuing the saved scan without restarting. Earlier anime used old rules; keeping up to ${MIXED_SCAN_LIMIT} candidates and validating finalists. Ranking will be approximate. ====`);
  }
  if (![FILTER_SCOPE, MIXED_SCOPE].includes(getMeta(db, 'scan_scope')))
    throw new Error(`Unknown scan filter scope: ${getMeta(db, 'scan_scope')}`);
  if (phase === 'scan') {
    if (getMeta(db, 'scanned_pages') !== '0') log(`==== Resuming anime scan at ID ${getMeta(db, 'scan_range_start')}, page ${getMeta(db, 'scan_page')} ====`);
    let pages = 0;
    while (await scanOnePage(db, api, log, binding)) {
      pages++;
      if (pages % 25 === 0) log(`Scanned through media ID ${getMeta(db, 'scan_range_start')}, page ${getMeta(db, 'scan_page')}; ${getMeta(db, 'scanned_media')} anime found.`);
    }
    log(`==== Anime scan complete: ${getMeta(db, 'scanned_media')} anime, ${db.prepare('SELECT COUNT(*) AS n FROM stage_characters').get().n} candidates ====`);
    phase = 'hydrate';
  }
  if (phase === 'hydrate') {
    log('==== Fetching finalist character metadata ====');
    let batches = 0;
    while (await hydrateOneBatch(db, api, log, binding)) {
      batches++;
      if (batches % 20 === 0) log(`Hydrated ${db.prepare('SELECT COUNT(*) AS n FROM stage_characters WHERE name_full IS NOT NULL').get().n} characters.`);
    }
    transaction(db, () => {
      assertSourceCatalogStagingBinding(db, binding);
      setMeta(db, 'import_phase', 'publish');
    });
    phase = 'publish';
  }
  if (phase === 'publish') {
    log('==== Publishing completed character catalog ====');
    const count = db.prepare('SELECT COUNT(*) AS n FROM stage_characters').get().n;
    const growing = getMeta(db, 'scan_mode') === 'growing';
    if (growing && count === 0) throw new Error('No eligible characters found; catalog not published');
    if (!growing && count < TARGET_COUNT)
      throw new Error(`Expected at least ${TARGET_COUNT} eligible characters, found ${count}; catalog not published`);
    const published = publishCatalog(db, () => {
      // catalogDb owns the publication transaction. Keep the expected binding,
      // trimming and completion checkpoint in that same rollback boundary.
      assertSourceCatalogStagingBinding(db, binding);
      if (!growing) db.prepare(`DELETE FROM stage_characters WHERE id NOT IN
        (SELECT id FROM stage_characters ORDER BY favourites DESC, id ASC LIMIT ?)`).run(TARGET_COUNT);
      setMeta(db, 'scan_finished_at', new Date().toISOString());
      setMeta(db, 'import_phase', 'complete');
    });
    log(JSON.stringify({ published, filter: FILTER_SCOPE, approximate: getMeta(db, 'scan_scope') === MIXED_SCOPE,
      startedAt: getMeta(db, 'scan_started_at'),
      finishedAt: getMeta(db, 'scan_finished_at'), maxAnimeId: Number(getMeta(db, 'scan_max_id')),
      scannedAnime: Number(getMeta(db, 'scanned_media')), scannedPages: Number(getMeta(db, 'scanned_pages')) }, null, 2));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv.includes('--permission-confirmed')) {
    console.error('Bulk AniList import requires a written permission grant. After receiving it, rerun with --permission-confirmed.');
    process.exitCode = 1;
  } else {
    const db = openCatalog();
    try {
      console.log(`Database: ${db.prepare('PRAGMA database_list').get().file}`);
      await runImport({ db, api: new AniListCatalogApi(), refresh: process.argv.includes('--refresh'), restart: process.argv.includes('--restart') });
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    } finally {
      db.close();
    }
  }
}
