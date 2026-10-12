import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const DEFAULT_FILE = fileURLToPath(new URL('../data/bot.sqlite', import.meta.url));

export function openCatalog(path = DEFAULT_FILE) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > 1) {
    db.close();
    throw new Error(`Unsupported catalog database version ${version}`);
  }
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  if (version === 0) db.exec('BEGIN IMMEDIATE');
  try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS catalog_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS guild_prefixes (
      guild_id TEXT PRIMARY KEY, prefix TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS stage_characters (
      id INTEGER PRIMARY KEY, favourites INTEGER NOT NULL, name_full TEXT,
      name_native TEXT, name_alternatives TEXT, gender TEXT, age TEXT,
      date_of_birth TEXT, description TEXT, image_url TEXT, site_url TEXT,
      anime_titles TEXT, anime_ids TEXT, anime_adult INTEGER
    );
    CREATE INDEX IF NOT EXISTS stage_character_rank ON stage_characters (favourites ASC, id DESC);
    CREATE TABLE IF NOT EXISTS characters (
      id INTEGER PRIMARY KEY, rank INTEGER NOT NULL UNIQUE, favourites INTEGER NOT NULL,
      name_full TEXT, name_native TEXT, name_alternatives TEXT, gender TEXT,
      age TEXT, date_of_birth TEXT, description TEXT, image_url TEXT,
      site_url TEXT, anime_titles TEXT, anime_ids TEXT, anime_adult INTEGER
    );
    CREATE TABLE IF NOT EXISTS tag_candidates (
      character_id INTEGER NOT NULL, tag_name TEXT NOT NULL,
      post_count INTEGER NOT NULL DEFAULT 0, reason TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (character_id, tag_name)
    );
    CREATE TABLE IF NOT EXISTS tag_match_progress (
      character_id INTEGER PRIMARY KEY, matched_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tag_search_cache (
      query TEXT PRIMARY KEY, response TEXT NOT NULL, fetched_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tag_decisions (
      character_id INTEGER PRIMARY KEY, status TEXT NOT NULL,
      tag_name TEXT, source TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS character_tag_reports (
      id INTEGER PRIMARY KEY, character_id INTEGER NOT NULL,
      reporter_id TEXT NOT NULL, reported_at TEXT NOT NULL,
      resolved_at TEXT, outcome TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS open_character_tag_reporter
      ON character_tag_reports (character_id, reporter_id) WHERE resolved_at IS NULL;
    CREATE TABLE IF NOT EXISTS duckduckgo_tag_attempts (
      character_id INTEGER PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
      query TEXT NOT NULL, first_url TEXT, second_url TEXT,
      outcome TEXT NOT NULL, tag_name TEXT, details TEXT NOT NULL,
      searched_at TEXT NOT NULL
    );
  `);
  if (version === 0) db.exec('PRAGMA user_version = 1; COMMIT;');
  } catch (error) {
    if (version === 0) db.exec('ROLLBACK');
    db.close();
    throw error;
  }
  return db;
}

export function openCatalogReadOnly(path = DEFAULT_FILE) {
  const db = new DatabaseSync(path, { readOnly: true });
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > 1) {
    db.close();
    throw new Error(`Unsupported catalog database version ${version}`);
  }
  return db;
}

export function getMeta(db, key) {
  return db.prepare('SELECT value FROM catalog_meta WHERE key = ?').get(key)?.value ?? null;
}

export function setMeta(db, key, value) {
  db.prepare('INSERT INTO catalog_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

export function transaction(db, callback) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = callback();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

// A bounded leaderboard makes interrupted scans cheap to resume.
export function keepCandidate(db, character, limit = 15_000) {
  const { id } = character;
  const favourites = character.favourites ?? 0;
  if (!Number.isInteger(id) || !Number.isInteger(favourites)) throw new Error('Invalid AniList character');
  const existing = db.prepare('SELECT id FROM stage_characters WHERE id = ?').get(id);
  if (existing) return true;
  const count = db.prepare('SELECT COUNT(*) AS count FROM stage_characters').get().count;
  const worst = count >= limit
    ? db.prepare('SELECT id, favourites FROM stage_characters ORDER BY favourites ASC, id DESC LIMIT 1').get()
    : null;
  if (worst && (favourites < worst.favourites || (favourites === worst.favourites && id > worst.id))) return false;
  db.prepare('INSERT INTO stage_characters (id, favourites) VALUES (?, ?)').run(id, favourites);
  if (worst) db.prepare('DELETE FROM stage_characters WHERE id = ?').run(worst.id);
  return true;
}

export function publishCatalog(db, beforeInsert = () => {}) {
  return transaction(db, () => {
    beforeInsert();
    const rows = db.prepare('SELECT * FROM stage_characters ORDER BY favourites DESC, id ASC').all();
    if (rows.some((row) => !row.name_full)) throw new Error('Cannot publish incomplete catalog metadata');
    db.exec('DELETE FROM characters');
    db.exec('DELETE FROM tag_candidates; DELETE FROM tag_match_progress');
    db.exec("DELETE FROM tag_decisions WHERE source = 'automatic'");
    const insert = db.prepare(`INSERT INTO characters
      (id, rank, favourites, name_full, name_native, name_alternatives, gender, age,
       date_of_birth, description, image_url, site_url, anime_titles, anime_ids, anime_adult)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    rows.forEach((row, index) => insert.run(row.id, index + 1, row.favourites,
      row.name_full, row.name_native, row.name_alternatives, row.gender, row.age,
      row.date_of_birth, row.description, row.image_url, row.site_url,
      row.anime_titles, row.anime_ids, row.anime_adult));
    db.prepare(`UPDATE character_tag_reports SET resolved_at = ?, outcome = 'unavailable'
      WHERE resolved_at IS NULL AND NOT EXISTS
      (SELECT 1 FROM characters WHERE characters.id = character_tag_reports.character_id)`)
      .run(new Date().toISOString());
    setMeta(db, 'published_at', new Date().toISOString());
    return rows.length;
  });
}

export function saveDecision(db, characterId, status, tagName = null, source = 'manual') {
  if (!['approve', 'no_match'].includes(status)) throw new Error('Invalid tag decision');
  if (status === 'approve' && !tagName) throw new Error('Tag required for approval');
  db.prepare(`INSERT INTO tag_decisions (character_id, status, tag_name, source, updated_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(character_id) DO UPDATE SET
    status = excluded.status, tag_name = excluded.tag_name,
    source = excluded.source, updated_at = excluded.updated_at`)
    .run(characterId, status, status === 'approve' ? tagName : null, source, new Date().toISOString());
}

export function reportCharacterTag(db, characterId, reporterId) {
  if (!Number.isInteger(characterId) || typeof reporterId !== 'string' || !reporterId) {
    throw new Error('Invalid character tag report');
  }
  return db.prepare(`INSERT OR IGNORE INTO character_tag_reports
    (character_id, reporter_id, reported_at)
    SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM characters WHERE id = ?)`)
    .run(characterId, reporterId, new Date().toISOString(), characterId).changes === 1;
}

export function resolveCharacterTagReports(db, characterId, outcome) {
  if (!['corrected', 'dismissed'].includes(outcome)) throw new Error('Invalid report resolution');
  return db.prepare(`UPDATE character_tag_reports SET resolved_at = ?, outcome = ?
    WHERE character_id = ? AND resolved_at IS NULL`)
    .run(new Date().toISOString(), outcome, characterId).changes;
}
