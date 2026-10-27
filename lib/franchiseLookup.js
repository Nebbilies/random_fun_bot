import { getMeta } from './catalogDb.js';
import { characterFranchiseRelation } from './characterFranchises.js';
import { characterAppearanceSourceToken, hasImportedCharacterSources } from './catalogFreshness.js';

const normalize = (value) => String(value ?? '').normalize('NFKC')
  .toLocaleLowerCase('en-US').trim().replace(/\s+/g, ' ');

export function isFranchiseCatalogCurrent(db) {
  if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='catalog_state'").get()) {
    if (!hasImportedCharacterSources(db)) return true;
    const token = getMeta(db, 'franchise_source_token');
    const currentToken = characterAppearanceSourceToken(db);
    if (token) return token === currentToken;
    // Identity migration preserves appearances but introduces source revision 0.
    // Already-migrated catalogs may still carry only the legacy freshness marker.
    // Never reuse it after a source change or override an explicit stale token.
    return currentToken === 'source:0' && isLegacyFranchiseCatalogCurrent(db);
  }
  return isLegacyFranchiseCatalogCurrent(db);
}

function isLegacyFranchiseCatalogCurrent(db) {
  const source = getMeta(db, 'franchise_source_published_at');
  return Boolean(source && source === getMeta(db, 'published_at'));
}

/** @param {import('node:sqlite').DatabaseSync} db */
export function loadFranchiseIndex(db, { directOnly = false } = {}) {
  if (directOnly) {
    const hasDirectMemberships = db.prepare(`SELECT 1 FROM sqlite_schema
      WHERE type = 'table' AND name = 'character_franchise_memberships'`).get();
    if (!hasDirectMemberships) return [];
    // Only curated labels are safe while anime enrichment is stale. An automatic
    // display name may survive on a directly curated group; use a manual alias instead.
    const rows = db.prepare(`SELECT f.id, f.display_name, f.name_source, a.alias
      FROM franchises AS f LEFT JOIN franchise_aliases AS a
        ON a.franchise_id = f.id AND a.source = 'manual'
      WHERE EXISTS (SELECT 1 FROM character_franchise_memberships AS m
        JOIN characters AS c ON c.id = m.character_id WHERE m.franchise_id = f.id)
      ORDER BY f.id, a.alias`).all();
    const direct = new Map();
    for (const row of rows) {
      if (!direct.has(row.id)) direct.set(row.id, {
        id: row.id, name: row.name_source === 'manual' ? row.display_name : null, aliases: [],
      });
      if (row.alias) direct.get(row.id).aliases.push(row.alias);
    }
    return [...direct.values()].map(item => ({ ...item, name: item.name ?? item.aliases[0] }))
      .filter(item => item.name);
  }
  const franchises = new Map(db.prepare(`SELECT id, display_name FROM franchises ORDER BY id`).all()
    .map((row) => [row.id, { id: row.id, name: row.display_name, aliases: new Set([row.display_name]) }]));
  for (const row of db.prepare(`SELECT franchise_id, alias FROM franchise_aliases
    WHERE source != 'excluded' ORDER BY alias`).all()) {
    franchises.get(row.franchise_id)?.aliases.add(row.alias);
  }
  for (const row of db.prepare(`SELECT fa.franchise_id, a.title_romaji, a.title_english, a.title_native, a.synonyms
    FROM franchise_anime AS fa JOIN anime AS a ON a.id = fa.anime_id`).all()) {
    const franchise = franchises.get(row.franchise_id);
    if (!franchise) continue;
    for (const title of [row.title_romaji, row.title_english, row.title_native]) if (title) franchise.aliases.add(title);
    try {
      const synonyms = JSON.parse(row.synonyms || '[]');
      if (Array.isArray(synonyms)) for (const synonym of synonyms) if (typeof synonym === 'string' && synonym) franchise.aliases.add(synonym);
    } catch {}
  }
  return [...franchises.values()].map((franchise) => ({
    ...franchise,
    aliases: [...franchise.aliases],
  }));
}

/** @param {{id:number,name:string,aliases:string[]}[]} franchises @param {string} input */
export function findFranchises(franchises, input) {
  const query = normalize(input);
  if (query.length < 2) return [];
  const tiers = [[], [], []];
  for (const franchise of franchises) {
    const names = [franchise.name, ...franchise.aliases].map(normalize).filter(Boolean);
    if (names.includes(query)) tiers[0].push(franchise);
    else if (names.some((name) => name.startsWith(query))) tiers[1].push(franchise);
    else if (names.some((name) => name.includes(query))) tiers[2].push(franchise);
  }
  return (tiers.find((tier) => tier.length) ?? []).sort((a, b) => a.id - b.id);
}

/** @param {import('node:sqlite').DatabaseSync} db @param {number} franchiseId @param {string | null} guildId */
export function loadFranchiseCharacters(db, franchiseId, guildId = null, { directOnly = false } = {}) {
  return db.prepare(`SELECT DISTINCT c.id, c.rank, c.name_full, c.name_native, c.name_alternatives,
      EXISTS (SELECT 1 FROM marriages AS m WHERE m.guild_id = ? AND m.character_id = c.id) AS married
    FROM ${directOnly ? 'character_franchise_memberships' : characterFranchiseRelation(db)} AS membership
    JOIN characters AS c ON c.id = membership.character_id
    WHERE membership.franchise_id = ? ORDER BY c.rank`).all(guildId, franchiseId);
}

function validCover(cover) {
  if (typeof cover !== 'string' || !cover.startsWith('https://') || /\s/.test(cover) || !URL.canParse(cover)) return false;
  const url = new URL(cover);
  return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password;
}

/** @param {import('node:sqlite').DatabaseSync} db @param {number} franchiseId */
export function loadFranchiseCover(db, franchiseId, { directOnly = false } = {}) {
  const rows = directOnly ? [] : db.prepare(`SELECT a.cover_image FROM franchise_anime AS fa
    JOIN anime AS a ON a.id = fa.anime_id
    WHERE fa.franchise_id = ? AND a.cover_image IS NOT NULL
    ORDER BY (a.format = 'TV') DESC, a.popularity DESC, a.id ASC`).all(franchiseId);
  for (const row of rows) if (validCover(row.cover_image)) return row.cover_image;
  const hasCuratedCover = db.prepare('PRAGMA table_info(franchises)').all()
    .some((column) => column.name === 'curated_cover_url');
  if (!hasCuratedCover) return null;
  const cover = db.prepare('SELECT curated_cover_url FROM franchises WHERE id = ?').get(franchiseId)?.curated_cover_url;
  return validCover(cover) ? cover : null;
}
