import { characterFranchiseRelation } from "./characterFranchises.js";

function names(value) {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(parsed)
      ? parsed.filter((name) => typeof name === "string" && name.trim())
      : [];
  } catch {
    return [];
  }
}

const compareNames = (a, b) =>
  a.toLowerCase() < b.toLowerCase()
    ? -1
    : a.toLowerCase() > b.toLowerCase()
      ? 1
      : a < b
        ? -1
        : a > b
          ? 1
          : 0;

/** One display policy; anime order is historical, franchise order is canonical. */
export function characterSeries(
  character,
  unknown = "Unknown anime",
  shorten = (value) => value,
) {
  const anime = names(character?.anime_titles);
  const franchises = [...new Set(names(character?.franchise_names))].sort(
    compareNames,
  );
  const titles = anime.length ? anime : franchises;
  return {
    label: !anime.length && franchises.length ? "Franchise" : "Anime",
    text: titles.length
      ? `${shorten(titles[0])}${titles.length > 1 && character?.version !== 1 ? ` (+${titles.length - 1} more)` : ""}`
      : unknown,
  };
}

/** Hydrate only live catalog reads, never published snapshots. Batches avoid N+1 reads.
 * The identity key differs for marriage rows (their id is the marriage identity).
 */
export function hydrateCharacterFranchises(db, rows, identityKey = "id") {
  if (!rows.length) return rows;
  // Small legacy/test catalogs may not have franchise tables at all.
  if (
    !db
      .prepare(
        "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='franchises'",
      )
      .get()
  )
    return rows;
  const byId = new Map();
  for (const row of rows) {
    row.franchise_names = "[]";
    const id = row[identityKey];
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(row);
  }
  const ids = [...byId.keys()];
  for (let start = 0; start < ids.length; start += 500) {
    const batch = ids.slice(start, start + 500);
    const memberships = db
      .prepare(
        `SELECT DISTINCT membership.character_id AS id, f.display_name AS name
      FROM ${characterFranchiseRelation(db)} AS membership
      JOIN franchises f ON f.id = membership.franchise_id
      WHERE membership.character_id IN (${batch.map(() => "?").join(",")})`,
      )
      .all(...batch);
    const grouped = new Map();
    for (const membership of memberships) {
      if (!grouped.has(membership.id)) grouped.set(membership.id, []);
      grouped.get(membership.id).push(membership.name);
    }
    for (const [id, titles] of grouped) {
      for (const row of byId.get(id))
        row.franchise_names = JSON.stringify(
          [...new Set(titles)].sort(compareNames),
        );
    }
  }
  return rows;
}
