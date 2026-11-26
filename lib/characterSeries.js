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

/** Main franchises are the only franchise names displayed on character cards. */
export function characterMainFranchises(
  character,
  limit = 180,
  encode = (name) => name,
) {
  const titles = [...new Set(names(character?.main_franchise_names))]
    .sort(compareNames)
    .map(encode);
  if (!titles.length || limit < 1) return null;

  const label = titles.length === 1 ? "Franchise" : "Franchises";
  const full = titles.join(", ");
  if (full.length <= limit) return { label, text: full };
  const omitted = (count) => (count ? ` (+${count} more)` : "");
  let visible = "";
  let shown = 0;
  for (let index = 0; index < titles.length; index++) {
    const next = visible ? `${visible}, ${titles[index]}` : titles[index];
    const suffix = omitted(titles.length - index - 1);
    if ((next + suffix).length > limit) break;
    visible = next;
    shown++;
  }

  if (visible) return { label, text: visible + omitted(titles.length - shown) };

  const suffix = omitted(titles.length - 1);
  const available = limit - suffix.length;
  if (available < 1) return null;
  return {
    label,
    text: titles[0].slice(0, available - 1).toWellFormed() + "…" + suffix,
  };
}

export function hydrateCharacterMainFranchises(db, rows, identityKey = "id") {
  if (!rows.length) return rows;
  const byId = new Map(rows.map((row) => [row[identityKey], []]));
  if (
    db
      .prepare(
        "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='character_main_franchises'",
      )
      .get()
  ) {
    const ids = [...byId.keys()];
    for (let start = 0; start < ids.length; start += 500) {
      const batch = ids.slice(start, start + 500);
      const assignments = db
        .prepare(
          `SELECT DISTINCT m.character_id, f.display_name
         FROM character_main_franchises m JOIN franchises f ON f.id=m.franchise_id
         WHERE m.character_id IN (${batch.map(() => "?").join(",")})`,
        )
        .all(...batch);
      for (const { character_id, display_name } of assignments)
        if (display_name.trim()) byId.get(character_id).push(display_name);
    }
  }
  for (const row of rows)
    row.main_franchise_names = JSON.stringify(
      byId.get(row[identityKey]).sort(compareNames),
    );
  return rows;
}

/** Enrich legacy snapshots for rendering while keeping the saved terms intact. */
export function withCharacterMainFranchises(db, character) {
  if (!character || Object.hasOwn(character, "main_franchise_names"))
    return character;
  return hydrateCharacterMainFranchises(db, [{ ...character }])[0];
}
