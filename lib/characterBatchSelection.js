import { searchCharacters } from "./gameCharacterLookup.js";

export const CHARACTER_BATCH_LIMIT = 10;

/** @typedef {import('./characterMarriage.js').MarriageRow} MarriageRow */
/** @typedef {{query: string, matches: MarriageRow[], row: MarriageRow | null}} SelectionEntry */

/**
 * @param {MarriageRow[]} rows
 * @param {string} input
 * @param {{confirmFuzzy?: boolean, exactSingleCharacter?: boolean}} [rules]
 */
export function planCharacterSelection(
  rows,
  input,
  { confirmFuzzy = false, exactSingleCharacter = false } = {},
) {
  const queries = input.split("$").map((query) => query.trim());
  if (queries.length > CHARACTER_BATCH_LIMIT)
    return { status: /** @type {const} */ ("limit") };
  if (queries.some((query) => !query))
    return { status: /** @type {const} */ ("empty") };

  /** @type {SelectionEntry[]} */
  const entries = [];
  for (const query of queries) {
    const { matches, matchType } =
      exactSingleCharacter && queries.length === 1 && query.length === 1
        ? exactFullName(rows, query)
        : searchCharacters(rows, query);
    if (!matches.length)
      return { status: /** @type {const} */ ("missing"), query };
    const needsChoice =
      matches.length > 1 ||
      (matchType === "fuzzy" && (queries.length > 1 || confirmFuzzy));
    entries.push({ query, matches, row: needsChoice ? null : matches[0] });
  }
  return { status: /** @type {const} */ ("ok"), entries };
}

/** @param {MarriageRow[]} rows @param {string} query */
function exactFullName(rows, query) {
  const normalized = query.normalize("NFKC").toLocaleLowerCase("en-US");
  return {
    matches: rows.filter(
      (row) =>
        row.name_full?.normalize("NFKC").toLocaleLowerCase("en-US") ===
        normalized,
    ),
    matchType: /** @type {const} */ ("exact"),
  };
}

/** @param {SelectionEntry[]} entries */
export function characterSelectionProgress(entries) {
  const selected = new Map();
  for (const { row } of entries) {
    if (!row) continue;
    if (selected.has(row.characterId))
      return { status: /** @type {const} */ ("duplicate"), row };
    selected.set(row.characterId, row);
  }
  const next = entries.find((entry) => !entry.row);
  if (next) return { status: /** @type {const} */ ("choose"), entry: next };
  return {
    status: /** @type {const} */ ("ready"),
    rows: [...selected.values()],
  };
}
