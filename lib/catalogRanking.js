import { isCharacterId } from './characterIdentity.js';

const MAX = Number.MAX_SAFE_INTEGER;

export const CHARACTER_RANKING_POLICY = Object.freeze({ version: 1, danbooruMax: 149200,
  mudaeMin: 1, mudaeMax: 150837, danbooruWeight: '1/2', mudaeWeight: '3/2',
  missing: 'zero-contribution', clamp: false,
  ties: ['mudae-ascending-null-last', 'legacy-ascending-only-both-null-null-last', 'uuid-ascii'] });
export const CHARACTER_RANKING_POLICY_JSON = JSON.stringify(CHARACTER_RANKING_POLICY);
const DENOMINATOR = 45009462400;

export function nullableRankingInteger(value, label, minimum = 0) {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`Invalid ${label}: safe integer required`);
  return value;
}

export function validateMudaeCharacterUrl(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value)) throw new Error('Invalid Mudae character URL');
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error('Invalid Mudae character URL'); }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'mudae.net' || parsed.username || parsed.password || parsed.port
    || !/^\/character\/[1-9]\d*\/[^/]+$/.test(parsed.pathname) || parsed.search || parsed.hash) throw new Error('Invalid Mudae character URL');
  return parsed.href;
}

function scoreNumerator(character) {
  const count = nullableRankingInteger(character.danbooru_post_count, 'Danbooru count');
  const claim = nullableRankingInteger(character.mudae_claim_rank, 'Mudae claim rank', 1);
  return (count === null ? 0n : BigInt(count) * 150836n)
    + (claim === null ? 0n : 3n * (150837n - BigInt(claim)) * 149200n);
}

export function scoreCharacter(character) {
  return Number(scoreNumerator(character)) / DENOMINATOR;
}

/** Pure projection; exact rational order is independent of stored or displayed scores. */
export function projectCharacterRanking(characters) {
  const ids = new Set();
  const keys = characters.map(character => {
    if (!isCharacterId(character.id) || character.id !== character.id.toLowerCase()) throw new Error('Invalid canonical character UUID');
    if (ids.has(character.id)) throw new Error('Duplicate character identity');
    ids.add(character.id);
    const legacy = nullableRankingInteger(character.legacy_rank, 'legacy rank', 1);
    return { character, numerator: scoreNumerator(character),
      legacy: character.danbooru_post_count === null && character.mudae_claim_rank === null ? legacy : null };
  });
  const ascending = (a, b) => a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? -1 : 1;
  keys.sort((a, b) => (a.numerator > b.numerator ? -1 : a.numerator < b.numerator ? 1 : 0)
    || ascending(a.character.mudae_claim_rank, b.character.mudae_claim_rank)
    || ascending(a.legacy, b.legacy) || ascending(a.character.id, b.character.id));
  return keys.map(({ character, numerator }, index) => ({ ...character, rank: index + 1, efficiency: Number(numerator) / DENOMINATOR }));
}

/** Apply only gameplay positions/scores inside the caller's transaction. */
export function applyCharacterRanking(db) {
  if (!db.isTransaction) throw new Error('Ranking publication requires a transaction');
  const rows = db.prepare('SELECT * FROM characters').all();
  const next = projectCharacterRanking(rows);
  const maximum = rows.reduce((n, row) => Math.max(n, row.rank), 0);
  const offset = Math.max(maximum, rows.length) + 1;
  if (!Number.isSafeInteger(maximum + offset)) throw new Error('Catalog rank overflow');
  db.prepare('UPDATE characters SET rank=rank+?').run(offset);
  const update = db.prepare('UPDATE characters SET rank=?, efficiency=? WHERE id=?');
  for (const row of next) update.run(row.rank, row.efficiency, row.id);
  return next;
}

function count(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Likes must be nonnegative safe integers');
  return value;
}

/** Generate likes between neighbors, ordered from highest to lowest. */
export function generateInsertionLikes(upperLikes = null, lowerLikes = null) {
  if (upperLikes === null && lowerLikes === null) return 0;
  if (upperLikes === null) {
    const lower = count(lowerLikes);
    if (lower === MAX) throw new Error('Insertion likes would overflow');
    return lower + 1;
  }
  const upper = count(upperLikes);
  if (lowerLikes === null) return Math.max(0, upper - 1);
  const lower = count(lowerLikes);
  if (upper < lower) throw new Error('Neighbors are not in descending likes order');
  return lower + Math.floor((upper - lower) / 2);
}

/**
 * Pure preview for a creation or move. Input must be the current catalog in rank order.
 * IDs are opaque; callers resolve source references before using this function.
 * The returned rank is the final position, not the pre-removal insertion offset.
 * @param {{id: string, favourites: number}[]} characters
 * @param {number} rank
 * @param {string | null} [movingId]
 */
export function previewRankInsertion(characters, rank, movingId = null) {
  const ids = new Set();
  let previous = MAX;
  for (const character of characters) {
    if (typeof character.id !== 'string' || !character.id || ids.has(character.id)) {
      throw new Error('Catalog identities must be unique nonempty strings');
    }
    ids.add(character.id);
    const likes = count(character.favourites);
    if (likes > previous) throw new Error('Catalog is not in descending likes order');
    previous = likes;
  }
  if (movingId !== null && !ids.has(movingId)) throw new Error('Character to reposition is not in the catalog');
  const remaining = characters.filter((character) => character.id !== movingId);
  if (!Number.isSafeInteger(rank) || rank < 1 || rank > remaining.length + 1) {
    throw new Error('Insertion rank is outside the catalog');
  }
  const upper = remaining[rank - 2] ?? null;
  const lower = remaining[rank - 1] ?? null;
  return {
    rank,
    favourites: generateInsertionLikes(upper?.favourites ?? null, lower?.favourites ?? null),
    upperId: upper?.id ?? null,
    lowerId: lower?.id ?? null,
  };
}

/**
 * Produce a canonical persistent order after insertion. Integer order positions can
 * be written transactionally and subsequently used only as the secondary sort key.
 * Renumbering this order changes no other character's likes or relative position.
 * @param {{id: string, favourites: number}[]} characters
 * @param {{id: string, rank: number}} insertion
 */
export function insertAtRank(characters, { id, rank }) {
  if (typeof id !== 'string' || !id) throw new Error('Character identity is required');
  const movingId = characters.some((character) => character.id === id) ? id : null;
  const preview = previewRankInsertion(characters, rank, movingId);
  const next = characters.filter((character) => character.id !== id).map((character) => ({ ...character }));
  next.splice(rank - 1, 0, { id, favourites: preview.favourites });
  return next.map((character, index) => ({ ...character, rank: index + 1, tieOrder: index + 1 }));
}
