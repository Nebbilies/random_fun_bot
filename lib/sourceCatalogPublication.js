import { createCharacterId, normalizeAniListCharacterId } from './characterIdentity.js';

const FIELDS = ['name_full', 'name_native', 'name_alternatives', 'gender', 'age', 'date_of_birth',
  'description', 'image_url', 'site_url', 'anime_titles', 'anime_ids', 'anime_adult'];

/** UUID-schema publisher. Network hydration must finish before entering this transaction.
 * Existing ranks/tie_order, never UUID lexical order, define the prior tie order.
 * Caller must supply BEGIN IMMEDIATE/rollback/commit; catalogDb owns that boundary.
 */
export function publishSourceCatalog(db) {
  const current = db.prepare('SELECT c.*, i.creation_method FROM characters c JOIN character_identities i ON i.id=c.id ORDER BY c.rank').all();
  if (current.length !== Number(db.prepare('SELECT count(*) AS n FROM characters').get().n)) throw new Error('Missing character identity');
  const byId = new Map(current.map((row) => [row.id, row]));
  const bySource = new Map(db.prepare("SELECT character_id,external_id FROM character_sources WHERE source='anilist'").all().map((row) => [row.external_id, row.character_id]));
  const identity = db.prepare('SELECT creation_method FROM character_identities WHERE id=?');
  const link = db.prepare("INSERT INTO character_sources (character_id,source,external_id) VALUES (?,'anilist',?)");
  const addIdentity = db.prepare("INSERT INTO character_identities (id,name_full,image_url,creation_method) VALUES (?,?,?,'imported')");
  const updateIdentity = db.prepare('UPDATE character_identities SET name_full=?,image_url=? WHERE id=?');
  const incoming = db.prepare('SELECT * FROM stage_characters ORDER BY id').all();
  const next = [...current];
  let nextOrder = current.reduce((max, row) => Math.max(max, row.tie_order ?? row.rank), 0);
  if (!Number.isSafeInteger(nextOrder + incoming.length + 1)) throw new Error('Catalog tie order overflow');
  for (const sourceRow of incoming) {
    const externalId = normalizeAniListCharacterId(sourceRow.id);
    if (!Number.isSafeInteger(sourceRow.favourites) || sourceRow.favourites < 0) throw new Error('Invalid source likes');
    let id = bySource.get(externalId);
    let record = id ? identity.get(id) : null;
    if (id && !record) throw new Error('Source mapping points to missing identity');
    let row = id ? byId.get(id) : null;
    if (!row && sourceRow.name_full == null) throw new Error('Cannot publish incomplete catalog metadata');
    if (!id) {
      id = createCharacterId();
      addIdentity.run(id, sourceRow.name_full, sourceRow.image_url);
      link.run(id, externalId);
      record = { creation_method: 'imported' };
    }
    if (!row) {
      row = { id, rank: 0, favourites: sourceRow.favourites, likes_source: 'anilist', tie_order: ++nextOrder, creation_method: record.creation_method };
      for (const field of FIELDS) row[field] = sourceRow[field];
      next.push(row); byId.set(id, row);
    } else {
      // Linked manually created metadata remains curated independently of likes.
      if (record.creation_method !== 'manual' && sourceRow.name_full != null) {
        for (const field of FIELDS) row[field] = sourceRow[field];
      }
      if (row.likes_source === 'anilist') row.favourites = sourceRow.favourites;
    }
    if (record.creation_method !== 'manual') updateIdentity.run(row.name_full, row.image_url, id);
  }
  next.sort((a, b) => b.favourites - a.favourites || (a.tie_order ?? a.rank) - (b.tie_order ?? b.rank));
  const maxRank = current.reduce((max, row) => Math.max(max, row.rank), 0);
  const offset = maxRank + next.length + 1;
  if (!Number.isSafeInteger(maxRank + offset)) throw new Error('Catalog rank overflow');
  db.prepare('UPDATE characters SET rank=rank+?').run(offset);
  // Existing tie_order is not rewritten: it is a durable secondary ordering key.
  const columns = ['id', 'rank', 'favourites', ...FIELDS, 'likes_source', 'tie_order'];
  const statement = db.prepare(`INSERT INTO characters (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})
    ON CONFLICT(id) DO UPDATE SET ${columns.filter((key) => key !== 'id').map((key) => `${key}=excluded.${key}`).join(',')}`);
  next.forEach((row, index) => {
    row.rank = index + 1;
    row.tie_order ??= row.rank;
    statement.run(...columns.map((field) => row[field] ?? null));
  });
  db.exec('DELETE FROM tag_candidates; DELETE FROM tag_match_progress');
  const revisionValue = db.prepare("SELECT value FROM catalog_meta WHERE key='catalog_revision'").get()?.value ?? '0';
  const revision = Number(revisionValue);
  if (!Number.isSafeInteger(revision) || revision < 0 || revision === Number.MAX_SAFE_INTEGER) throw new Error('Invalid catalog revision');
  const meta = db.prepare('INSERT INTO catalog_meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  meta.run('catalog_revision', String(revision + 1));
  meta.run('published_at', new Date().toISOString());
  return next.length;
}
