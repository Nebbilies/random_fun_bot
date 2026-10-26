import { isCharacterId } from './characterIdentity.js';

// Flat, JSON-safe published terms. Deliberately excludes source metadata and
// arbitrary event/catalog fields. anime_titles remains the catalog's JSON text.
const TEXT_LIMITS = Object.freeze({ name_full: 4096, image_url: 8192,
  anime_titles: 32768, gender: 128, tag_name: 512 });
const KEYS = ['version', 'id', 'rank', 'favourites', 'likes_source', ...Object.keys(TEXT_LIMITS)];
const own = (value, key) => value != null && Object.hasOwn(value, key);

function validIdentity(id) {
  return (Number.isSafeInteger(id) && id > 0)
    || (isCharacterId(id) && id === id.toLowerCase());
}

/** Validate without coercion; a present but corrupt snapshot must never go live. */
export function validateCharacterSnapshot(snapshot, characterId = snapshot?.id) {
  const invalid = () => { throw new Error('Invalid mystery character snapshot'); };
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)
    || snapshot.version !== 1 || !validIdentity(snapshot.id) || snapshot.id !== characterId
    || Object.keys(snapshot).length !== KEYS.length
    || !KEYS.every((key) => own(snapshot, key))
    || !Number.isSafeInteger(snapshot.rank) || snapshot.rank <= 0
    || !Number.isSafeInteger(snapshot.favourites) || snapshot.favourites < 0
    || !['anilist', 'generated'].includes(snapshot.likes_source)) invalid();
  for (const [key, limit] of Object.entries(TEXT_LIMITS)) {
    if (snapshot[key] !== null && (typeof snapshot[key] !== 'string'
      || snapshot[key].length > limit)) invalid();
  }
  return Object.freeze({ ...snapshot });
}

/** Capture before handing the selected row to any event implementation. */
export function captureCharacterSnapshot(character) {
  const snapshot = { version: 1, id: character.id, rank: character.rank,
    favourites: character.favourites, likes_source: character.likes_source ?? 'anilist' };
  for (const key of Object.keys(TEXT_LIMITS)) snapshot[key] = character[key] ?? null;
  return validateCharacterSnapshot(snapshot, character.id);
}

/** Absence alone is legacy compatibility; null/unknown versions fail closed. */
export function characterSnapshotFromState(state, characterId, rankSnapshot) {
  const snapshot = own(state, 'characterSnapshot')
    ? validateCharacterSnapshot(state.characterSnapshot, characterId) : null;
  if (snapshot && rankSnapshot !== undefined && snapshot.rank !== rankSnapshot) {
    throw new Error('Invalid mystery character snapshot: rank mismatch');
  }
  return snapshot;
}

/** Keep original published terms even when an event replaces its entire state. */
export function retainCharacterSnapshot(original, replacement, characterId) {
  const snapshot = characterSnapshotFromState(original, characterId);
  return snapshot ? { ...replacement, characterSnapshot: snapshot } : replacement;
}
