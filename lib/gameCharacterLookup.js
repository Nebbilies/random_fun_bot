import { characterLikesProjection } from './characterLikesProjection.js';

/**
 * Temporary pre-cutover bridge: canonical UUIDs are opaque catalog identities;
 * positive safe integers remain valid only for the existing legacy schema.
 * This validates shape, not existence. Source IDs are never resolved automatically.
 * @param {unknown} value
 * @returns {value is string | number}
 */
export function isValidCharacterId(value) {
  return (typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value))
    || (typeof value === 'number' && Number.isSafeInteger(value) && value > 0);
}

const normalize = (value) => String(value ?? '').normalize('NFKC').toLocaleLowerCase('en-US').trim().replace(/\s+/g, ' ');

function alternatives(character) {
  try {
    const values = JSON.parse(character.name_alternatives || '[]');
    return Array.isArray(values) ? values : [];
  } catch {
    return [];
  }
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
  return rows;
}

/**
 * @template {{id: string | number, rank: number, name_full: string, name_native?: string | null,
 *   name_alternatives?: string | null}} T
 * @param {T[]} characters
 * @param {string} input
 * @returns {T[]}
 */
export function findCharacters(characters, input) {
  const query = normalize(input);
  if (/^#(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(query)) {
    const rank = Number(query.slice(1).replaceAll(',', ''));
    return characters.filter((character) => character.rank === rank);
  }
  if (query.length < 2) return [];

  /** @type {T[][]} */
  const tiers = [[], [], [], [], [], []];
  for (const character of characters) {
    const full = normalize(character.name_full);
    const other = [character.name_native, ...alternatives(character)].map(normalize).filter(Boolean);
    if (full === query) tiers[0].push(character);
    else if (other.includes(query)) tiers[1].push(character);
    else if (full.startsWith(query)) tiers[2].push(character);
    else if (other.some((name) => name.startsWith(query))) tiers[3].push(character);
    else if (full.includes(query)) tiers[4].push(character);
    else if (other.some((name) => name.includes(query))) tiers[5].push(character);
  }
  return (tiers.find((tier) => tier.length) ?? []).sort((a, b) => a.rank - b.rank);
}
