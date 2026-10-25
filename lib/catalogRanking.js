const MAX = Number.MAX_SAFE_INTEGER;

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
