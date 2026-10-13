import { getMeta } from './catalogDb.js';

const normalize = (value) => String(value ?? '').normalize('NFKC')
  .toLocaleLowerCase('en-US').trim().replace(/\s+/g, ' ');

export function isFranchiseCatalogCurrent(db) {
  const source = getMeta(db, 'franchise_source_published_at');
  return Boolean(source && source === getMeta(db, 'published_at'));
}

/** @param {import('node:sqlite').DatabaseSync} db */
export function loadFranchiseIndex(db) {
  const franchises = new Map(db.prepare(`SELECT id, display_name FROM franchises ORDER BY id`).all()
    .map((row) => [row.id, { id: row.id, name: row.display_name, aliases: new Set([row.display_name]) }]));
  for (const row of db.prepare(`SELECT franchise_id, alias FROM franchise_aliases
    WHERE source != 'excluded' ORDER BY alias`).all()) {
    franchises.get(row.franchise_id)?.aliases.add(row.alias);
  }
  for (const row of db.prepare(`SELECT fa.franchise_id, a.title_romaji, a.title_english, a.title_native, a.synonyms
    FROM franchise_anime AS fa JOIN anime AS a ON a.id = fa.anime_id`).all()) {
    const franchise = franchises.get(row.franchise_id);
    if (!franchise) continue;
    for (const title of [row.title_romaji, row.title_english, row.title_native]) if (title) franchise.aliases.add(title);
    try {
      const synonyms = JSON.parse(row.synonyms || '[]');
      if (Array.isArray(synonyms)) for (const synonym of synonyms) if (typeof synonym === 'string' && synonym) franchise.aliases.add(synonym);
    } catch {}
  }
  return [...franchises.values()].map((franchise) => ({
    ...franchise,
    aliases: [...franchise.aliases],
  }));
}

/** @param {{id:number,name:string,aliases:string[]}[]} franchises @param {string} input */
export function findFranchises(franchises, input) {
  const query = normalize(input);
  if (query.length < 2) return [];
  const tiers = [[], [], []];
  for (const franchise of franchises) {
    const names = [franchise.name, ...franchise.aliases].map(normalize).filter(Boolean);
    if (names.includes(query)) tiers[0].push(franchise);
    else if (names.some((name) => name.startsWith(query))) tiers[1].push(franchise);
    else if (names.some((name) => name.includes(query))) tiers[2].push(franchise);
  }
  return (tiers.find((tier) => tier.length) ?? []).sort((a, b) => a.id - b.id);
}

/** @param {import('node:sqlite').DatabaseSync} db @param {number} franchiseId */
export function loadFranchiseCharacters(db, franchiseId) {
  return db.prepare(`SELECT DISTINCT c.id, c.rank, c.name_full, c.name_native, c.name_alternatives
    FROM franchise_anime AS fa
    JOIN character_anime AS ca ON ca.anime_id = fa.anime_id
    JOIN characters AS c ON c.id = ca.character_id
    WHERE fa.franchise_id = ? ORDER BY c.rank`).all(franchiseId);
}
