import { getMeta, setMeta, transaction } from './catalogDb.js';

const FRANCHISE_RELATIONS = new Set([
  'PREQUEL', 'SEQUEL', 'PARENT', 'SIDE_STORY', 'SPIN_OFF',
  'ALTERNATIVE', 'SUMMARY', 'COMPILATION',
]);

function label(value, description, maxLength = 120) {
  if (typeof value !== 'string') throw new Error(`Invalid ${description}`);
  const result = value.trim();
  if (result.length < 2 || result.length > maxLength) throw new Error(`Invalid ${description}`);
  return result;
}

function normalized(value) {
  return value.normalize('NFKC').toLocaleLowerCase('en-US').trim().replace(/\s+/g, ' ');
}

export function isFranchiseRelation(type) {
  return FRANCHISE_RELATIONS.has(type);
}

function addAlias(db, franchiseId, alias, source = 'manual') {
  const value = label(alias, 'franchise alias');
  db.prepare(`INSERT INTO franchise_aliases (franchise_id, alias, normalized_alias, source)
    VALUES (?, ?, ?, ?) ON CONFLICT(franchise_id, normalized_alias) DO UPDATE
    SET alias = excluded.alias, source = excluded.source`).run(franchiseId, value, normalized(value), source);
}

export function createFranchise(db, name) {
  const displayName = label(name, 'franchise name');
  return transaction(db, () => {
    const result = db.prepare(`INSERT INTO franchises (display_name, name_source, created_at)
      VALUES (?, 'manual', ?)`).run(displayName, new Date().toISOString());
    const id = Number(result.lastInsertRowid);
    addAlias(db, id, displayName);
    return id;
  });
}

export function renameFranchise(db, franchiseId, name) {
  const displayName = label(name, 'franchise name');
  transaction(db, () => {
    const existing = db.prepare('SELECT display_name FROM franchises WHERE id = ?').get(franchiseId);
    if (!existing) throw new Error('Unknown franchise');
    addAlias(db, franchiseId, existing.display_name);
    db.prepare(`UPDATE franchises SET display_name = ?, name_source = 'manual' WHERE id = ?`).run(displayName, franchiseId);
    addAlias(db, franchiseId, displayName);
  });
}

export function addFranchiseAlias(db, franchiseId, alias) {
  if (!db.prepare('SELECT 1 FROM franchises WHERE id = ?').get(franchiseId)) throw new Error('Unknown franchise');
  addAlias(db, franchiseId, alias);
}

export function removeFranchiseAlias(db, franchiseId, alias) {
  const value = label(alias, 'franchise alias');
  if (!db.prepare('SELECT 1 FROM franchises WHERE id = ?').get(franchiseId)) throw new Error('Unknown franchise');
  db.prepare(`INSERT INTO franchise_aliases (franchise_id, alias, normalized_alias, source)
    VALUES (?, ?, ?, 'excluded') ON CONFLICT(franchise_id, normalized_alias) DO UPDATE
    SET alias = excluded.alias, source = 'excluded'`).run(franchiseId, value, normalized(value));
}

export function moveAnimeToFranchise(db, animeId, franchiseId) {
  if (!Number.isInteger(animeId) || !db.prepare('SELECT 1 FROM anime WHERE id = ?').get(animeId))
    throw new Error('Unknown anime');
  if (!Number.isInteger(franchiseId) || !db.prepare('SELECT 1 FROM franchises WHERE id = ?').get(franchiseId))
    throw new Error('Unknown franchise');
  transaction(db, () => {
    db.prepare(`INSERT INTO franchise_membership_overrides (anime_id, franchise_id, updated_at)
      VALUES (?, ?, ?) ON CONFLICT(anime_id) DO UPDATE SET
      franchise_id = excluded.franchise_id, updated_at = excluded.updated_at`)
      .run(animeId, franchiseId, new Date().toISOString());
    db.prepare('DELETE FROM franchise_anime WHERE anime_id = ?').run(animeId);
    db.prepare(`INSERT INTO franchise_anime (franchise_id, anime_id, source) VALUES (?, ?, 'manual')`)
      .run(franchiseId, animeId);
  });
}

export function removeAnimeFromFranchise(db, animeId) {
  if (!Number.isInteger(animeId) || !db.prepare('SELECT 1 FROM anime WHERE id = ?').get(animeId))
    throw new Error('Unknown anime');
  transaction(db, () => {
    db.prepare(`INSERT INTO franchise_membership_overrides (anime_id, franchise_id, updated_at)
      VALUES (?, NULL, ?) ON CONFLICT(anime_id) DO UPDATE SET
      franchise_id = NULL, updated_at = excluded.updated_at`).run(animeId, new Date().toISOString());
    db.prepare('DELETE FROM franchise_anime WHERE anime_id = ?').run(animeId);
  });
}

export function mergeFranchises(db, sourceId, targetId) {
  if (sourceId === targetId) throw new Error('Choose two different franchises');
  transaction(db, () => {
    if (!db.prepare('SELECT 1 FROM franchises WHERE id = ?').get(sourceId)
      || !db.prepare('SELECT 1 FROM franchises WHERE id = ?').get(targetId)) throw new Error('Unknown franchise');
    const members = db.prepare('SELECT anime_id FROM franchise_anime WHERE franchise_id = ?').all(sourceId);
    const aliases = db.prepare('SELECT alias FROM franchise_aliases WHERE franchise_id = ? AND source != \'excluded\'').all(sourceId);
    const setOverride = db.prepare(`INSERT INTO franchise_membership_overrides (anime_id, franchise_id, updated_at)
      VALUES (?, ?, ?) ON CONFLICT(anime_id) DO UPDATE SET
      franchise_id = excluded.franchise_id, updated_at = excluded.updated_at`);
    for (const { anime_id } of members) setOverride.run(anime_id, targetId, new Date().toISOString());
    db.prepare('UPDATE franchise_membership_overrides SET franchise_id = ?, updated_at = ? WHERE franchise_id = ?')
      .run(targetId, new Date().toISOString(), sourceId);
    const moveAlias = db.prepare(`INSERT OR IGNORE INTO franchise_aliases (franchise_id, alias, normalized_alias, source)
      SELECT ?, alias, normalized_alias, 'manual' FROM franchise_aliases WHERE franchise_id = ? AND source != 'excluded'`);
    moveAlias.run(targetId, sourceId);
    db.prepare('DELETE FROM franchise_anime WHERE franchise_id = ?').run(sourceId);
    db.prepare('DELETE FROM franchise_aliases WHERE franchise_id = ?').run(sourceId);
    db.prepare('DELETE FROM franchises WHERE id = ?').run(sourceId);
    for (const { anime_id } of members) db.prepare(`INSERT OR IGNORE INTO franchise_anime
      (franchise_id, anime_id, source) VALUES (?, ?, 'manual')`).run(targetId, anime_id);
  });
}

/**
 * @param {{id: number}[]} anime
 * @param {{fromAnimeId: number, toAnimeId: number, relationType: string}[]} relations
 * @returns {number[][]}
 */
export function groupAnimeByFranchise(anime, relations) {
  const parent = new Map(anime.map(({ id }) => [id, id]));
  const find = (id) => {
    const current = parent.get(id);
    if (current === undefined) return undefined;
    if (current !== id) parent.set(id, find(current));
    return parent.get(id);
  };
  const join = (left, right) => {
    const a = find(left);
    const b = find(right);
    if (a === undefined || b === undefined || a === b) return;
    parent.set(Math.max(a, b), Math.min(a, b));
  };

  for (const relation of relations) {
    if (isFranchiseRelation(relation.relationType))
      join(relation.fromAnimeId, relation.toAnimeId);
  }

  const groups = new Map();
  for (const id of parent.keys()) {
    const root = find(id);
    const group = groups.get(root) ?? [];
    group.push(id);
    groups.set(root, group);
  }
  return [...groups.values()]
    .map((group) => group.sort((a, b) => a - b))
    .sort((a, b) => a[0] - b[0]);
}

function json(value) {
  return JSON.stringify(Array.isArray(value) ? value : []);
}

function animeValues(media) {
  const date = media.startDate && [media.startDate.year, media.startDate.month, media.startDate.day].some(Number.isInteger)
    ? JSON.stringify(media.startDate) : null;
  return [media.id, media.title?.romaji ?? null, media.title?.english ?? null, media.title?.native ?? null,
    json(media.synonyms), json(media.genres), json(media.tags), date, media.seasonYear ?? null,
    media.format ?? null, media.status ?? null, media.averageScore ?? null, media.popularity ?? null,
    media.isAdult === undefined ? null : Number(Boolean(media.isAdult)),
    media.coverImage?.extraLarge ?? media.coverImage?.large ?? null, media.siteUrl ?? null, new Date().toISOString()];
}

export function stageFranchiseBatch(db, { media, appearances, relations, cursor }) {
  const insertAnime = db.prepare(`INSERT INTO stage_anime (
    id, title_romaji, title_english, title_native, synonyms, genres, tags, start_date,
    season_year, format, status, average_score, popularity, is_adult, cover_image, site_url, fetched_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET title_romaji=excluded.title_romaji, title_english=excluded.title_english,
    title_native=excluded.title_native, synonyms=excluded.synonyms, genres=excluded.genres, tags=excluded.tags,
    start_date=excluded.start_date, season_year=excluded.season_year, format=excluded.format,
    status=excluded.status, average_score=excluded.average_score, popularity=excluded.popularity,
    is_adult=excluded.is_adult, cover_image=excluded.cover_image, site_url=excluded.site_url, fetched_at=excluded.fetched_at`);
  const insertAppearance = db.prepare('INSERT OR IGNORE INTO stage_character_anime (character_id, anime_id) VALUES (?, ?)');
  const insertRelation = db.prepare('INSERT OR IGNORE INTO stage_anime_relations (from_anime_id, to_anime_id, relation_type) VALUES (?, ?, ?)');
  transaction(db, () => {
    for (const item of media) insertAnime.run(...animeValues(item));
    for (const [characterId, animeId] of appearances) insertAppearance.run(characterId, animeId);
    for (const relation of relations) insertRelation.run(...relation);
    setMeta(db, 'franchise_character_cursor', cursor);
  });
}

function displayTitle(row) {
  return row.title_english || row.title_romaji || row.title_native || `Anime #${row.id}`;
}

function initialDisplayName(db, animeIds) {
  const rows = animeIds.map((id) => db.prepare(`SELECT id, title_romaji, title_english, title_native, format, popularity
    FROM stage_anime WHERE id = ?`).get(id)).filter(Boolean);
  rows.sort((a, b) => Number(b.format === 'TV') - Number(a.format === 'TV')
    || (b.popularity ?? 0) - (a.popularity ?? 0) || a.id - b.id);
  return displayTitle(rows[0]);
}

function groupIdFor(db, animeIds, claimed, oldFranchiseByAnime) {
  const counts = new Map();
  for (const animeId of animeIds) {
    const franchiseId = oldFranchiseByAnime.get(animeId);
    if (franchiseId !== undefined && !claimed.has(franchiseId))
      counts.set(franchiseId, (counts.get(franchiseId) ?? 0) + 1);
  }
  const previous = [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0];
  if (previous !== undefined) return previous;
  const result = db.prepare('INSERT INTO franchises (display_name, name_source, created_at) VALUES (?, ?, ?)')
    .run(initialDisplayName(db, animeIds), 'automatic', new Date().toISOString());
  return Number(result.lastInsertRowid);
}

export function publishFranchiseCatalog(db) {
  const sourcePublishedAt = getMeta(db, 'franchise_import_source_published_at');
  if (!sourcePublishedAt || sourcePublishedAt !== getMeta(db, 'published_at'))
    throw new Error('Character catalog changed during franchise import');
  const incomplete = db.prepare(`SELECT ca.character_id, ca.anime_id FROM stage_character_anime AS ca
    LEFT JOIN stage_anime AS a ON a.id = ca.anime_id WHERE a.id IS NULL LIMIT 1`).get();
  if (incomplete) throw new Error(`Missing anime metadata for appearance ${incomplete.character_id}/${incomplete.anime_id}`);

  return transaction(db, () => {
    const animeIds = db.prepare('SELECT id FROM stage_anime ORDER BY id').all().map((row) => row.id);
    const oldFranchiseByAnime = new Map(db.prepare(`SELECT anime_id, franchise_id FROM franchise_anime
      WHERE source = 'automatic'`).all().map((row) => [row.anime_id, row.franchise_id]));
    const relations = db.prepare(`SELECT from_anime_id AS fromAnimeId, to_anime_id AS toAnimeId,
      relation_type AS relationType FROM stage_anime_relations`).all();
    const groups = groupAnimeByFranchise(animeIds.map((id) => ({ id })), relations);
    const manual = new Map(db.prepare('SELECT anime_id, franchise_id FROM franchise_membership_overrides').all()
      .map((row) => [row.anime_id, row.franchise_id]));
    const autoGroups = [];
    for (const group of groups) {
      const movable = group.filter((id) => !manual.has(id));
      if (!movable.length) continue;
      const allowed = new Set(movable);
      const split = groupAnimeByFranchise(movable.map((id) => ({ id })), relations.filter((item) => allowed.has(item.fromAnimeId) && allowed.has(item.toAnimeId)));
      autoGroups.push(...split);
    }

    db.exec(`DELETE FROM anime; DELETE FROM character_anime; DELETE FROM anime_relations;
      DELETE FROM franchise_anime; DELETE FROM franchise_aliases WHERE source = 'automatic';
      INSERT INTO anime SELECT * FROM stage_anime;
      INSERT INTO character_anime SELECT ca.character_id, ca.anime_id FROM stage_character_anime AS ca
        JOIN characters AS c ON c.id = ca.character_id;
      INSERT INTO anime_relations SELECT * FROM stage_anime_relations;`);

    const claimed = new Set();
    for (const group of autoGroups.sort((a, b) => b.length - a.length || a[0] - b[0])) {
      const franchiseId = groupIdFor(db, group, claimed, oldFranchiseByAnime);
      claimed.add(franchiseId);
      const name = initialDisplayName(db, group);
      const existing = db.prepare('SELECT name_source FROM franchises WHERE id = ?').get(franchiseId);
      if (existing?.name_source !== 'manual')
        db.prepare('UPDATE franchises SET display_name = ?, name_source = \'automatic\' WHERE id = ?').run(name, franchiseId);
      const member = db.prepare('INSERT OR IGNORE INTO franchise_anime (franchise_id, anime_id, source) VALUES (?, ?, \'automatic\')');
      for (const animeId of group) member.run(franchiseId, animeId);
      const aliases = new Set([name]);
      for (const animeId of group) {
        const row = db.prepare('SELECT title_romaji, title_english, title_native, synonyms FROM stage_anime WHERE id = ?').get(animeId);
        for (const title of [row.title_romaji, row.title_english, row.title_native]) if (title) aliases.add(title);
        try { for (const synonym of JSON.parse(row.synonyms || '[]')) if (typeof synonym === 'string' && synonym) aliases.add(synonym); }
        catch {}
      }
      const addAlias = db.prepare(`INSERT OR IGNORE INTO franchise_aliases (franchise_id, alias, normalized_alias, source)
        VALUES (?, ?, ?, 'automatic')`);
      for (const alias of aliases) addAlias.run(franchiseId, alias, alias.normalize('NFKC').toLocaleLowerCase('en-US').trim().replace(/\s+/g, ' '));
    }
    for (const [animeId, franchiseId] of manual) {
      if (!animeIds.includes(animeId) || !db.prepare('SELECT 1 FROM franchises WHERE id = ?').get(franchiseId)) continue;
      db.prepare(`INSERT OR IGNORE INTO franchise_anime (franchise_id, anime_id, source) VALUES (?, ?, 'manual')`).run(franchiseId, animeId);
    }
    db.prepare(`DELETE FROM franchises WHERE name_source = 'automatic' AND NOT EXISTS
      (SELECT 1 FROM franchise_anime WHERE franchise_anime.franchise_id = franchises.id)`).run();
    setMeta(db, 'franchise_snapshot_published_at', new Date().toISOString());
    setMeta(db, 'franchise_source_published_at', sourcePublishedAt);
    setMeta(db, 'franchise_import_phase', 'complete');
    db.exec('DELETE FROM stage_anime; DELETE FROM stage_character_anime; DELETE FROM stage_anime_relations;');
    return { anime: animeIds.length, appearances: db.prepare('SELECT COUNT(*) AS n FROM character_anime').get().n,
      franchises: db.prepare('SELECT COUNT(DISTINCT franchise_id) AS n FROM franchise_anime').get().n };
  });
}
