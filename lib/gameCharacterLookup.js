const normalize = (value) => String(value ?? '').normalize('NFKC').toLocaleLowerCase('en-US').trim().replace(/\s+/g, ' ');

function alternatives(character) {
  try {
    const values = JSON.parse(character.name_alternatives || '[]');
    return Array.isArray(values) ? values : [];
  } catch {
    return [];
  }
}

export function loadCharacterIndex(db) {
  return db.prepare(`SELECT id, rank, favourites, name_full, name_native,
    name_alternatives, anime_titles, image_url, site_url FROM characters ORDER BY rank`).all();
}

export function findCharacters(characters, input) {
  const query = normalize(input);
  if (/^#\d+$/.test(query)) {
    const rank = Number(query.slice(1));
    return characters.filter((character) => character.rank === rank);
  }
  if (query.length < 2) return [];

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
