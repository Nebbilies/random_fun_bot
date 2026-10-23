import { randomUUID } from 'node:crypto';

export function initItemActions(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS item_actions (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, guild_id TEXT NOT NULL, actor_id TEXT NOT NULL,
      channel_id TEXT NOT NULL, inventory_id INTEGER NOT NULL, state TEXT NOT NULL,
      selections_json TEXT NOT NULL, result_json TEXT, created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, deadline_at INTEGER, message_id TEXT,
      delivery_pending INTEGER NOT NULL DEFAULT 0, crown_json TEXT
    );
    CREATE TABLE IF NOT EXISTS item_action_costs (
      action_id TEXT NOT NULL, inventory_id INTEGER NOT NULL UNIQUE, snapshot_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS item_character_reservations (
      guild_id TEXT NOT NULL, character_id INTEGER NOT NULL, action_id TEXT NOT NULL,
      owner_id TEXT NOT NULL, marriage_id INTEGER NOT NULL,
      PRIMARY KEY (guild_id, character_id)
    );
    CREATE TABLE IF NOT EXISTS counterfeit_crowns (
      guild_id TEXT NOT NULL, user_id TEXT NOT NULL, character_id INTEGER NOT NULL,
      marriage_id INTEGER NOT NULL, generation_id TEXT NOT NULL,
      PRIMARY KEY (guild_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS item_actions_pending ON item_actions(state, deadline_at);
  `);
}

export function getItemAction(db, id) {
  const row = db.prepare('SELECT * FROM item_actions WHERE id = ?').get(id);
  return row ? { ...row, selections: JSON.parse(row.selections_json), result: row.result_json ? JSON.parse(row.result_json) : null } : null;
}

export function getCounterfeitCrown(db, guildId, userId) {
  return db.prepare('SELECT * FROM counterfeit_crowns WHERE guild_id = ? AND user_id = ?').get(guildId, userId) ?? null;
}

export function setCounterfeitCrown(db, guildId, userId, character) {
  const generation = randomUUID();
  db.prepare(`INSERT INTO counterfeit_crowns VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(guild_id,user_id) DO UPDATE SET character_id=excluded.character_id,
    marriage_id=excluded.marriage_id,generation_id=excluded.generation_id`)
    .run(guildId, userId, character.characterId, character.marriageId, generation);
  return getCounterfeitCrown(db, guildId, userId);
}
