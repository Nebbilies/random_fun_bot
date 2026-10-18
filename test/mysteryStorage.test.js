import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openCatalog, openCatalogReadOnly } from '../lib/catalogDb.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'mystery-storage-'));
  return { dir, path: join(dir, 'catalog.sqlite') };
}

function columns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
}

test('fresh database has mystery storage and one active session per guild', (t) => {
  const { dir, path } = fixture();
  const db = openCatalog(path);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 7);
  assert.ok(columns(db, 'character_rolls').includes('mystery_session_id'));
  assert.ok(columns(db, 'character_rolls').includes('exclusive_user_id'));
  assert.ok(columns(db, 'mystery_sessions').includes('state_json'));
  assert.ok(columns(db, 'mystery_sessions').includes('next_at'));

  db.prepare('INSERT INTO guild_mystery_settings (guild_id, event_channel_id) VALUES (?, ?)')
    .run('1', '10');
  assert.equal(db.prepare('SELECT event_channel_id FROM guild_mystery_settings WHERE guild_id = ?')
    .get('1').event_channel_id, '10');
  db.prepare('INSERT INTO treasure_puzzle_wins (guild_id, puzzle_id, won_at) VALUES (?, ?, ?)')
    .run('1', 'puzzle-1', 1000);
  db.prepare('INSERT INTO treasure_puzzle_wins (guild_id, puzzle_id, won_at) VALUES (?, ?, ?)')
    .run('2', 'puzzle-1', 1001);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM treasure_puzzle_wins').get().n, 2);

  const insert = db.prepare(`INSERT INTO mystery_sessions
    (guild_id, origin_roll_id, event_id, character_id, rank_snapshot, roller_id,
      event_channel_id, state, state_json, started_at, next_at, deadline_at)
    VALUES (?, ?, 'doors', ?, 20, '100', '10', ?, ?, 1000, 2000, 3000)`);
  insert.run('1', 1, 101, 'reserved', '{}');
  assert.throws(() => insert.run('1', 2, 102, 'running', '{}'), /UNIQUE constraint failed/);
  insert.run('2', 3, 103, 'running', '{}');
  db.prepare("UPDATE mystery_sessions SET state = 'completed', resolved_at = 2000, outcome = 'won' WHERE origin_roll_id = 1").run();
  insert.run('1', 2, 102, 'running', '{}');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM mystery_sessions WHERE guild_id = '1'").get().n, 2);
});

test('v5 upgrade preserves existing game records and adds nullable card fields', (t) => {
  const { dir, path } = fixture();
  const old = new DatabaseSync(path);
  old.exec(`
    CREATE TABLE characters (id INTEGER PRIMARY KEY, rank INTEGER NOT NULL UNIQUE, favourites INTEGER NOT NULL,
      name_full TEXT, gender TEXT);
    CREATE TABLE marriages (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL,
      character_id INTEGER NOT NULL, owner_id TEXT NOT NULL, married_at TEXT NOT NULL,
      UNIQUE (guild_id, character_id));
    CREATE TABLE guild_prefixes (guild_id TEXT PRIMARY KEY, prefix TEXT NOT NULL);
    CREATE TABLE roll_allowances (guild_id TEXT NOT NULL, user_id TEXT NOT NULL,
      period INTEGER NOT NULL, used INTEGER NOT NULL, PRIMARY KEY (guild_id, user_id));
    CREATE TABLE claim_allowances (guild_id TEXT NOT NULL, user_id TEXT NOT NULL,
      period INTEGER NOT NULL, PRIMARY KEY (guild_id, user_id));
    CREATE TABLE character_rolls (
      id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL,
      command_message_id TEXT NOT NULL UNIQUE, message_id TEXT UNIQUE,
      character_id INTEGER NOT NULL, character_name TEXT NOT NULL,
      state TEXT NOT NULL, published_at INTEGER, expires_at INTEGER,
      UNIQUE (guild_id, channel_id, message_id));
    INSERT INTO characters (id, rank, favourites, name_full, gender) VALUES (1, 1, 100, 'One', 'Female');
    INSERT INTO marriages (guild_id, character_id, owner_id, married_at) VALUES ('1', 1, '101', 'now');
    INSERT INTO guild_prefixes (guild_id, prefix) VALUES ('1', '?');
    INSERT INTO roll_allowances (guild_id, user_id, period, used) VALUES ('1', '101', 10, 3);
    INSERT INTO claim_allowances (guild_id, user_id, period) VALUES ('1', '101', 10);
    INSERT INTO character_rolls (guild_id, channel_id, command_message_id, message_id,
      character_id, character_name, state, published_at, expires_at)
      VALUES ('1', '10', '1000', '1001', 1, 'One', 'open', 1000, 61000);
    PRAGMA user_version = 5;
  `);
  old.close();

  let db = openCatalog(path);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 7);
  assert.equal(db.prepare("SELECT owner_id FROM marriages WHERE guild_id = '1'").get().owner_id, '101');
  assert.equal(db.prepare("SELECT prefix FROM guild_prefixes WHERE guild_id = '1'").get().prefix, '?');
  assert.equal(db.prepare("SELECT used FROM roll_allowances WHERE guild_id = '1'").get().used, 3);
  assert.equal(db.prepare("SELECT period FROM claim_allowances WHERE guild_id = '1'").get().period, 10);
  assert.deepEqual({ ...db.prepare("SELECT state, message_id, mystery_session_id, exclusive_user_id FROM character_rolls WHERE command_message_id = '1000'").get() },
    { state: 'open', message_id: '1001', mystery_session_id: null, exclusive_user_id: null });
  db.close();
  db = openCatalog(path);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 7);

  const readOnly = openCatalogReadOnly(path);
  assert.equal(readOnly.prepare('PRAGMA user_version').get().user_version, 7);
  readOnly.close();
});

test('openers reject a database newer than the supported schema', (t) => {
  const { dir, path } = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = openCatalog(path);
  db.exec('PRAGMA user_version = 8');
  db.close();
  assert.throws(() => openCatalogReadOnly(path), /Unsupported catalog database version 8/);
  assert.throws(() => openCatalog(path), /Unsupported catalog database version 8/);
});
