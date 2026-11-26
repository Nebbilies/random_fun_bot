import { isCharacterId } from "./characterIdentity.js";

// Flat, JSON-safe published terms. Deliberately excludes source metadata and
// arbitrary event/catalog fields. Older snapshots keep their exact keys.
// v3 freezes the main-franchise names shown on the character card.
// anime_titles remains the catalog's JSON text.
const TEXT_LIMITS = Object.freeze({
  name_full: 4096,
  image_url: 8192,
  anime_titles: 32768,
  gender: 128,
  tag_name: 512,
});
const V2_TEXT_LIMITS = Object.freeze({
  ...TEXT_LIMITS,
  franchise_names: 32768,
});
const V3_TEXT_LIMITS = Object.freeze({
  ...TEXT_LIMITS,
  main_franchise_names: 32768,
});
const limitsFor = (version) =>
  version === 3 ? V3_TEXT_LIMITS : version === 2 ? V2_TEXT_LIMITS : TEXT_LIMITS;
const keysFor = (limits) => [
  "version",
  "id",
  "rank",
  "favourites",
  "likes_source",
  ...Object.keys(limits),
];
const own = (value, key) => value != null && Object.hasOwn(value, key);

function validIdentity(id) {
  return (
    (Number.isSafeInteger(id) && id > 0) ||
    (isCharacterId(id) && id === id.toLowerCase())
  );
}

/** Validate without coercion; a present but corrupt snapshot must never go live. */
export function validateCharacterSnapshot(
  snapshot,
  characterId = snapshot?.id,
) {
  const invalid = () => {
    throw new Error("Invalid mystery character snapshot");
  };
  const limits = limitsFor(snapshot?.version);
  const keys = keysFor(limits);
  if (
    !snapshot ||
    typeof snapshot !== "object" ||
    Array.isArray(snapshot) ||
    ![1, 2, 3].includes(snapshot.version) ||
    !validIdentity(snapshot.id) ||
    snapshot.id !== characterId ||
    Object.keys(snapshot).length !== keys.length ||
    !keys.every((key) => own(snapshot, key)) ||
    !Number.isSafeInteger(snapshot.rank) ||
    snapshot.rank <= 0 ||
    !Number.isSafeInteger(snapshot.favourites) ||
    snapshot.favourites < 0 ||
    !["anilist", "generated"].includes(snapshot.likes_source)
  )
    invalid();
  for (const [key, limit] of Object.entries(limits)) {
    if (
      snapshot[key] !== null &&
      (typeof snapshot[key] !== "string" || snapshot[key].length > limit)
    )
      invalid();
  }
  if (snapshot.version >= 2) {
    try {
      const names = JSON.parse(
        snapshot.version === 3
          ? snapshot.main_franchise_names
          : snapshot.franchise_names,
      );
      if (
        !Array.isArray(names) ||
        names.some((name) => typeof name !== "string" || !name.trim())
      )
        invalid();
    } catch {
      invalid();
    }
  }
  return Object.freeze({ ...snapshot });
}

/** Capture before handing the selected row to any event implementation. */
export function captureCharacterSnapshot(character) {
  // Re-capturing historical terms must not upgrade or enrich them.
  const version = [1, 2].includes(character.version) ? character.version : 3;
  const snapshot = {
    version,
    id: character.id,
    rank: character.rank,
    favourites: character.favourites,
    likes_source: character.likes_source ?? "anilist",
  };
  for (const key of Object.keys(limitsFor(version))) {
    const empty =
      key === "franchise_names" || key === "main_franchise_names" ? "[]" : null;
    snapshot[key] = character[key] ?? empty;
  }
  return validateCharacterSnapshot(snapshot, character.id);
}

/** Absence alone is legacy compatibility; null/unknown versions fail closed. */
export function characterSnapshotFromState(state, characterId, rankSnapshot) {
  const snapshot = own(state, "characterSnapshot")
    ? validateCharacterSnapshot(state.characterSnapshot, characterId)
    : null;
  if (
    snapshot &&
    rankSnapshot !== undefined &&
    snapshot.rank !== rankSnapshot
  ) {
    throw new Error("Invalid mystery character snapshot: rank mismatch");
  }
  return snapshot;
}

/** Keep original published terms even when an event replaces its entire state. */
export function retainCharacterSnapshot(original, replacement, characterId) {
  const snapshot = characterSnapshotFromState(original, characterId);
  return snapshot
    ? { ...replacement, characterSnapshot: snapshot }
    : replacement;
}
