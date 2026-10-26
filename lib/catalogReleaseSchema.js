import { isCharacterId, normalizeAniListCharacterId } from './characterIdentity.js';

// Explicit extension foundation only. Not a complete production schema or startup migration.
export const CATALOG_RELEASE_VERSION = 12;
const MAX_SAFE = '9007199254740991';
const safe = (column, minimum = 0) =>
  `typeof(${column}) = 'integer' AND ${column} BETWEEN ${minimum} AND ${MAX_SAFE}`;
const text = column => `length(trim(${column})) > 0`;
const hash = column => `length(${column}) = 64 AND ${column} NOT GLOB '*[^0-9a-f]*'`;
const object = column => `CASE WHEN json_valid(${column}) THEN json_type(${column}) = 'object' ELSE 0 END`;
const role = "role IN ('admin', 'moderator')";

function validateFoundation(db) {
  for (const row of db.prepare('SELECT id, creation_method FROM character_identities').all()) {
    if (!isCharacterId(row.id) || row.id !== row.id.toLowerCase()) {
      throw new Error('Invalid canonical character UUID in character_identities');
    }
    if (!['imported', 'manual'].includes(row.creation_method)) throw new Error('Invalid creation_method');
  }
  const invalid = db.prepare(`SELECT 1 FROM characters AS c
    WHERE favourites IS NULL OR NOT (${safe('favourites')}) OR rank IS NULL OR NOT (${safe('rank', 1)})
      OR tie_order IS NULL OR NOT (${safe('tie_order', 1)})
      OR likes_source IS NULL OR likes_source NOT IN ('anilist', 'generated')
      OR NOT EXISTS (SELECT 1 FROM character_identities AS i WHERE i.id = c.id)
      OR (likes_source = 'anilist' AND NOT EXISTS
        (SELECT 1 FROM character_sources AS s WHERE s.character_id = c.id AND s.source = 'anilist'))
    LIMIT 1`).get();
  if (invalid) throw new Error('Invalid character counts, rank, tie_order, likes_source or identity/source');
  if (db.prepare('SELECT 1 FROM characters GROUP BY tie_order HAVING count(*) > 1 LIMIT 1').get()) {
    throw new Error('Duplicate tie_order');
  }
  for (const row of db.prepare('SELECT source, external_id, character_id FROM character_sources').all()) {
    if (row.source !== 'anilist') throw new Error('Invalid character source');
    try {
      if (normalizeAniListCharacterId(row.external_id) !== row.external_id) throw new Error();
    } catch {
      throw new Error('Invalid canonical positive safe external ID');
    }
    if (!db.prepare('SELECT 1 FROM character_identities WHERE id = ?').get(row.character_id)) {
      throw new Error('Invalid source identity');
    }
  }
  if (db.prepare('SELECT 1 FROM character_sources GROUP BY source, external_id HAVING count(*) > 1 LIMIT 1').get()
    || db.prepare('SELECT 1 FROM character_sources GROUP BY source, character_id HAVING count(*) > 1 LIMIT 1').get()) {
    throw new Error('Duplicate character source');
  }
  if (db.prepare('PRAGMA foreign_key_check').get()) throw new Error('Invalid foundation foreign keys');
}

/**
 * Install partial release extensions on an explicitly migrated synthetic v11 catalog.
 * The caller must supply an idle, dedicated writable connection with foreign keys enabled.
 * Owns its transaction; refuses all versions except 11, including repeated initialization.
 * Does not fetch/import data, repair invalid rows, strengthen all inherited DDL, or enable startup.
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function initializeCatalogReleaseSchema(db) {
  // BEGIN is deliberately outside the catch: failure must never roll back a caller's transaction.
  db.exec('BEGIN IMMEDIATE');
  try {
    if (Number(db.prepare('PRAGMA user_version').get().user_version) !== 11) {
      throw new Error('Catalog release extensions require explicitly migrated version 11');
    }
    if (Number(db.prepare('PRAGMA foreign_keys').get().foreign_keys) !== 1) {
      throw new Error('Catalog release extensions require foreign_keys ON');
    }
    validateFoundation(db);
    db.exec(`
      ALTER TABLE character_rolls ADD COLUMN character_snapshot_json TEXT
        CHECK (character_snapshot_json IS NULL OR ${object('character_snapshot_json')});
      CREATE TABLE character_curated_aliases (
        character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
        alias TEXT NOT NULL CHECK (${text('alias')}),
        normalized_alias TEXT NOT NULL CHECK (${text('normalized_alias')}),
        PRIMARY KEY (character_id, normalized_alias)
      ) STRICT;
      CREATE INDEX character_curated_alias_by_name ON character_curated_aliases(normalized_alias);
      CREATE TABLE character_curation (
        character_id TEXT PRIMARY KEY NOT NULL REFERENCES characters(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
        reference_url TEXT CHECK (reference_url IS NULL OR ${text('reference_url')})
      ) STRICT;
      CREATE TABLE character_franchise_memberships (
        character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
        franchise_id INTEGER NOT NULL REFERENCES franchises(id) ON DELETE RESTRICT ON UPDATE RESTRICT
          CHECK (${safe('franchise_id', 1)}),
        PRIMARY KEY (character_id, franchise_id)
      ) STRICT;
      CREATE INDEX character_franchise_memberships_by_franchise
        ON character_franchise_memberships(franchise_id, character_id);
      CREATE VIEW effective_character_franchises AS
        SELECT character_id, franchise_id FROM character_franchise_memberships
        UNION
        SELECT ca.character_id, fa.franchise_id FROM character_anime AS ca
          JOIN franchise_anime AS fa ON fa.anime_id = ca.anime_id
          JOIN characters AS c ON c.id = ca.character_id
          JOIN franchises AS f ON f.id = fa.franchise_id;
      ALTER TABLE franchises ADD COLUMN curated_cover_url TEXT
        CHECK (curated_cover_url IS NULL OR
          (substr(curated_cover_url, 1, 8) = 'https://' AND length(curated_cover_url) > 8
           AND curated_cover_url NOT GLOB '*[ ' || char(9) || char(10) || char(13) || ']*'));
      ALTER TABLE franchises ADD COLUMN reference_url TEXT
        CHECK (reference_url IS NULL OR ${text('reference_url')});
      CREATE TABLE catalog_state (
        singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
        revision INTEGER NOT NULL CHECK (${safe('revision')}),
        source_revision INTEGER NOT NULL CHECK (${safe('source_revision')}),
        appearance_revision INTEGER NOT NULL CHECK (${safe('appearance_revision')})
      ) STRICT;
      INSERT INTO catalog_state VALUES (1, 0, 0, 0);
      CREATE TABLE catalog_previews (
        id TEXT PRIMARY KEY NOT NULL CHECK (${text('id')}),
        account TEXT NOT NULL CHECK (${text('account')}),
        role TEXT NOT NULL CHECK (${role}),
        operation TEXT NOT NULL CHECK (${text('operation')}),
        payload_hash TEXT NOT NULL CHECK (${hash('payload_hash')}),
        payload_json TEXT NOT NULL CHECK (${object('payload_json')}),
        revision INTEGER NOT NULL CHECK (${safe('revision')}),
        source_revision INTEGER NOT NULL CHECK (${safe('source_revision')}),
        appearance_revision INTEGER NOT NULL CHECK (${safe('appearance_revision')}),
        created_at INTEGER NOT NULL CHECK (${safe('created_at')}),
        expires_at INTEGER NOT NULL CHECK (${safe('expires_at')} AND expires_at > created_at)
      ) STRICT;
      CREATE TABLE catalog_mutations (
        id INTEGER PRIMARY KEY CHECK (${safe('id', 1)}),
        preview_id TEXT NOT NULL UNIQUE REFERENCES catalog_previews(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
        character_id TEXT REFERENCES character_identities(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
        account TEXT NOT NULL CHECK (${text('account')}),
        role TEXT NOT NULL CHECK (${role}),
        operation TEXT NOT NULL CHECK (${text('operation')}),
        revision INTEGER NOT NULL UNIQUE CHECK (${safe('revision', 1)}),
        before_json TEXT NOT NULL CHECK (${object('before_json')}),
        after_json TEXT NOT NULL CHECK (${object('after_json')}),
        duplicate_override_reason TEXT CHECK
          (duplicate_override_reason IS NULL OR ${text('duplicate_override_reason')}),
        created_at INTEGER NOT NULL CHECK (${safe('created_at')})
      ) STRICT;
      CREATE TABLE catalog_confirmation_results (
        account TEXT NOT NULL CHECK (${text('account')}),
        idempotency_key TEXT NOT NULL CHECK (${text('idempotency_key')}),
        payload_hash TEXT NOT NULL CHECK (${hash('payload_hash')}),
        mutation_id INTEGER NOT NULL UNIQUE REFERENCES catalog_mutations(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
        result_json TEXT NOT NULL CHECK (${object('result_json')}),
        created_at INTEGER NOT NULL CHECK (${safe('created_at')}),
        PRIMARY KEY (account, idempotency_key)
      ) STRICT;
      PRAGMA user_version = ${CATALOG_RELEASE_VERSION};
    `);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
