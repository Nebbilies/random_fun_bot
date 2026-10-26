import { getMeta } from './catalogDb.js';

/** Anime enrichment depends on source identity/appearance inputs, not rank or
 * manual metadata. Legacy catalogs retain their timestamp coverage contract. */
export function characterAppearanceSourceToken(db) {
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='catalog_state'").get()) return getMeta(db,'published_at');
  const row=db.prepare('SELECT source_revision FROM catalog_state WHERE singleton=1').get();
  if (!row || !Number.isSafeInteger(row.source_revision) || row.source_revision<0) throw new Error('Invalid source revision');
  return `source:${row.source_revision}`;
}
export function hasImportedCharacterSources(db) {
  return Boolean(db.prepare("SELECT 1 FROM character_sources WHERE source='anilist' LIMIT 1").get());
}
