import { matchNames, prepareNames, normalizeName as normalize } from './nameSearch.js';
import { hydrateCharacterFranchises } from './characterSeries.js';
import { characterLikesProjection } from './characterLikesProjection.js';

/**
 * Canonical UUIDs are opaque catalog identities. Positive safe integers require
 * an explicit legacy database connection (schema version 0 through 10).
 * This validates shape, not existence. Source IDs are never resolved automatically.
 * @param {unknown} value
 * @param {any} [db]
 * @returns {value is string | number}
 */
export function isValidCharacterId(value, db = null) {
  if (typeof value === 'string') return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || !db) return false;
  // Do not cache: an explicit upgrade can change the schema on this connection.
  const version = db.prepare('PRAGMA user_version').get()?.user_version;
  return Number.isInteger(version) && version >= 0 && version <= 10;
}

function alternatives(character) {
  try {
    const values = JSON.parse(character.name_alternatives || '[]');
    return Array.isArray(values) ? values : [];
  } catch {
    return [];
  }
}

const preparedIndexes = new WeakMap();
/** Prepare only immutable catalog snapshot arrays; live harem arrays use fresh reads. */
export function prepareCharacterSearchIndex(characters) {
  const ordered = characters.map((character, index) => ({ character, index }))
    .sort((a, b) => a.character.rank - b.character.rank || a.index - b.index);
  preparedIndexes.set(characters, { rows: ordered.map(row => row.character),
    names: ordered.map(row => searchNames(row.character)) });
  return characters;
}

function searchNames(character) {
  return prepareNames(character.name_full, [character.name_native, ...alternatives(character)]);
}

/**
 * @typedef {{id: string | number, rank: number, favourites: number, likes_source: string, name_full: string,
 *   name_native: string | null, name_alternatives: string | null,
 *   anime_titles: string | null, image_url: string | null,
 *   site_url: string | null}} CatalogSearchCharacter
 */

/** @returns {CatalogSearchCharacter[]} */
export function loadCharacterIndex(db) {
  const rows = /** @type {CatalogSearchCharacter[]} */ (db.prepare(`SELECT id, rank, favourites, ${characterLikesProjection(db)}, name_full, name_native,
    name_alternatives, anime_titles, image_url, site_url FROM characters ORDER BY rank`).all());
  if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='character_curated_aliases'").get()) {
    const byId = new Map(rows.map(character => [character.id, character]));
    for (const alias of db.prepare('SELECT character_id, alias FROM character_curated_aliases ORDER BY normalized_alias').all()) {
      const character = byId.get(alias.character_id);
      if (character) character.name_alternatives = JSON.stringify([...alternatives(character), alias.alias]);
    }
  }
  return hydrateCharacterFranchises(db, rows);
}

/**
 * @template {{id: string | number, rank: number, name_full: string, name_native?: string | null,
 *   name_alternatives?: string | null}} T
 * @param {T[]} characters
 * @param {string} input
 * @returns {T[]}
 */
export function findCharacters(characters, input) {
  return searchCharacters(characters, input).matches;
}

/** Detailed lookup only for callers that must acknowledge typo-corrected transfers.
 * @template {{id: string | number, rank: number, name_full: string, name_native?: string | null, name_alternatives?: string | null}} T
 * @param {T[]} characters
 * @param {string} input
 */
export function searchCharacters(characters, input) {
  const query = normalize(input);
  if (/^#(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(query)) {
    const rank = Number(query.slice(1).replaceAll(',', ''));
    return { matches: characters.filter((character) => character.rank === rank), matchType: 'exact' };
  }
  if (query.startsWith('#')) return { matches: [], matchType: 'none' };
  // Rank is a stable tie-breaker, never a reason to discard equally plausible names.
  const prepared = preparedIndexes.get(characters);
  const rows = prepared?.rows ?? [...characters].sort((a, b) => a.rank - b.rank);
  const result = matchNames(prepared?.names ?? rows.map(searchNames), query);
  return { matches: result.indices.map(index => rows[index]), matchType: result.matchType };
}
