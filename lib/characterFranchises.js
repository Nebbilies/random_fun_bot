/**
 * Trusted SQL relation exposing character_id and franchise_id on release and legacy catalogs.
 * Detect per call: a connection may have release extensions installed after it is opened.
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function characterFranchiseRelation(db) {
  return db.prepare(`SELECT 1 FROM sqlite_schema
    WHERE type = 'view' AND name = 'effective_character_franchises'`).get()
    ? 'effective_character_franchises'
    : `(SELECT DISTINCT ca.character_id, fa.franchise_id
        FROM character_anime AS ca
        JOIN franchise_anime AS fa ON fa.anime_id = ca.anime_id)`;
}
