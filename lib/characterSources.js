import { requireCharacterId, normalizeAniListCharacterId } from './characterIdentity.js';

/** This schema is initialized explicitly by the identity migration/new schema path. */
export function initCharacterSources(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS character_sources (
    character_id TEXT NOT NULL REFERENCES character_identities(id),
    source TEXT NOT NULL CHECK (source = 'anilist'),
    external_id TEXT NOT NULL,
    PRIMARY KEY (source, external_id),
    UNIQUE (character_id, source)
  )`);
}

export function resolveAniListCharacter(db, externalId) {
  const id = normalizeAniListCharacterId(externalId);
  return db.prepare("SELECT character_id FROM character_sources WHERE source = 'anilist' AND external_id = ?")
    .get(id)?.character_id ?? null;
}

/** Caller owns verification and transaction/audit; never merge on a conflicting key. */
export function linkAniListCharacter(db, characterId, externalId) {
  const uuid = requireCharacterId(characterId);
  const sourceId = normalizeAniListCharacterId(externalId);
  if (!db.prepare('SELECT 1 FROM character_identities WHERE id = ?').get(uuid)) throw new Error('Unknown character identity');
  const linked = resolveAniListCharacter(db, sourceId);
  if (linked && linked !== uuid) throw new Error('AniList reference already belongs to another character');
  const current = db.prepare("SELECT external_id FROM character_sources WHERE character_id = ? AND source = 'anilist'").get(uuid);
  if (current && current.external_id !== sourceId) throw new Error('Character already has an AniList reference; use explicit replacement');
  if (linked === uuid) return false;
  db.prepare("INSERT INTO character_sources (character_id, source, external_id) VALUES (?, 'anilist', ?)").run(uuid, sourceId);
  return true;
}
