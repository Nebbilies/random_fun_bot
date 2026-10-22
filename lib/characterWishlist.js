/** A player may hold at most seven wishes in one server. */
export const WISHLIST_LIMIT = 7;

/**
 * @typedef {{characterId: number, rank: number | null, name: string, inCatalog: boolean,
 *   nameNative: string | null, nameAlternatives: string | null, createdAt: number}} Wish
 */

const normalize = (value) => String(value ?? '').normalize('NFKC')
  .toLocaleLowerCase('en-US').trim().replace(/\s+/g, ' ');

function alternatives(wish) {
  try {
    const values = JSON.parse(wish.nameAlternatives || '[]');
    return Array.isArray(values) ? values.filter((name) => typeof name === 'string' && name.trim()) : [];
  } catch {
    return [];
  }
}

function countWishes(db, guildId, userId) {
  return Number(db.prepare(`SELECT COUNT(*) AS count FROM character_wishes
    WHERE guild_id = ? AND user_id = ?`).get(guildId, userId)?.count ?? 0);
}

/**
 * Adds one wish, enforcing the per-player cap inside an immediate transaction.
 * @param {{guildId: string, userId: string, characterId: number, now?: number}} wish
 * @returns {{status: 'added' | 'duplicate' | 'full', count: number}}
 */
export function addWish(db, { guildId, userId, characterId, now = Date.now() }) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const present = db.prepare(`SELECT 1 AS present FROM character_wishes
      WHERE guild_id = ? AND user_id = ? AND character_id = ?`).get(guildId, userId, characterId);
    const count = countWishes(db, guildId, userId);
    if (present) { db.exec('COMMIT'); return { status: 'duplicate', count }; }
    if (count >= WISHLIST_LIMIT) { db.exec('COMMIT'); return { status: 'full', count }; }
    db.prepare(`INSERT INTO character_wishes (guild_id, user_id, character_id, created_at)
      VALUES (?, ?, ?, ?)`).run(guildId, userId, characterId, Number(now));
    db.exec('COMMIT');
    return { status: 'added', count: count + 1 };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** @returns {boolean} whether a wish was removed. */
export function removeWish(db, { guildId, userId, characterId }) {
  const result = db.prepare(`DELETE FROM character_wishes
    WHERE guild_id = ? AND user_id = ? AND character_id = ?`).run(guildId, userId, characterId);
  return Number(result.changes) > 0;
}

/** @returns {number} how many wishes the caller held. */
export function clearWishes(db, { guildId, userId }) {
  const result = db.prepare('DELETE FROM character_wishes WHERE guild_id = ? AND user_id = ?')
    .run(guildId, userId);
  return Number(result.changes);
}

/**
 * The caller's wishes in add order. A character still published reports its current rank;
 * one that left the catalog keeps its name from the identity record and reports no rank.
 * @returns {Wish[]}
 */
export function getWishes(db, { guildId, userId }) {
  return db.prepare(`SELECT wish.character_id AS characterId, character.rank AS rank,
      COALESCE(character.name_full, identity.name_full) AS name,
      character.name_native AS nameNative, character.name_alternatives AS nameAlternatives,
      CASE WHEN character.id IS NULL THEN 0 ELSE 1 END AS inCatalog, wish.created_at AS createdAt
    FROM character_wishes AS wish
    LEFT JOIN characters AS character ON character.id = wish.character_id
    LEFT JOIN character_identities AS identity ON identity.id = wish.character_id
    WHERE wish.guild_id = ? AND wish.user_id = ?
    ORDER BY wish.created_at, wish.character_id`).all(guildId, userId)
    .map((row) => ({ ...row, rank: row.rank ?? null, name: row.name ?? 'Unknown character',
      inCatalog: Boolean(row.inCatalog) }));
}

/**
 * Every player whose wishlist holds this character in this server, oldest wish first.
 * @returns {string[]}
 */
export function findWishMatchers(db, { guildId, characterId }) {
  return db.prepare(`SELECT user_id AS userId FROM character_wishes
    WHERE guild_id = ? AND character_id = ? ORDER BY created_at, user_id`).all(guildId, characterId)
    .map((row) => row.userId);
}

/**
 * Resolves a typed query against wishes the caller already holds, mirroring the catalog
 * search tiers. Never returns a character the caller has not wished for.
 * @param {Wish[]} wishes
 * @param {string} input
 * @returns {Wish[]}
 */
export function matchWishes(wishes, input) {
  const query = normalize(input);
  if (/^#(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(query)) {
    const rank = Number(query.slice(1).replaceAll(',', ''));
    return wishes.filter((wish) => wish.rank === rank);
  }
  if (query.length < 2) return [];
  /** @type {Wish[][]} */
  const tiers = [[], [], [], [], [], []];
  for (const wish of wishes) {
    const full = normalize(wish.name);
    const other = [wish.nameNative, ...alternatives(wish)].map(normalize).filter(Boolean);
    if (full === query) tiers[0].push(wish);
    else if (other.includes(query)) tiers[1].push(wish);
    else if (full.startsWith(query)) tiers[2].push(wish);
    else if (other.some((name) => name.startsWith(query))) tiers[3].push(wish);
    else if (full.includes(query)) tiers[4].push(wish);
    else if (other.some((name) => name.includes(query))) tiers[5].push(wish);
  }
  return tiers.find((tier) => tier.length) ?? [];
}
