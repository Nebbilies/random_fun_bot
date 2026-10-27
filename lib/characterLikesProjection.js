/**
 * Select count provenance on both legacy v10 and migrated catalogs. Inspect the
 * current schema rather than caching: maintenance can rebuild characters on the
 * same connection. Do not mask SQL/schema errors as legacy compatibility.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} [alias] Trusted SQL table alias (not user input).
 * @returns {string}
 */
export function characterLikesProjection(db, alias = '') {
  if (alias && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) {
    throw new Error('Invalid character table alias');
  }
  const hasSource = db.prepare('PRAGMA table_info(characters)').all()
    .some((column) => column.name === 'likes_source');
  return hasSource ? `${alias ? `${alias}.` : ''}likes_source AS likes_source`
    : "'anilist' AS likes_source";
}
