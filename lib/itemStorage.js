import { initItemActions } from './itemActionStorage.js';

import { getGameConfig } from './gameConfig.js';
import { getResolvedItemDefinition } from './itemRoster.js';

export function initItemStorage(db) {
  initItemActions(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      charges INTEGER NOT NULL,
      acquired_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS user_inventory_idx ON user_inventory (guild_id, user_id);

    CREATE TABLE IF NOT EXISTS user_inventory_limits (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      max_slots INTEGER NOT NULL,
      PRIMARY KEY (guild_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS active_user_buffs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      buff_id TEXT NOT NULL,
      data_json TEXT,
      expires_at INTEGER,
      remaining_rolls INTEGER
    );
    CREATE INDEX IF NOT EXISTS active_user_buffs_idx ON active_user_buffs (guild_id, user_id);

    CREATE TABLE IF NOT EXISTS character_protection_locks (
      guild_id TEXT NOT NULL,
      character_id INTEGER NOT NULL,
      lock_type TEXT NOT NULL,
      protected_until INTEGER,
      PRIMARY KEY (guild_id, character_id)
    );
  `);
  const buffColumns = db.prepare('PRAGMA table_info(active_user_buffs)').all();
  if (!buffColumns.some(column => column.name === 'starts_at')) {
    // NULL preserves the immediately-active semantics of pre-migration buffs.
    db.exec('ALTER TABLE active_user_buffs ADD COLUMN starts_at INTEGER');
  }
  const columns = db.prepare('PRAGMA table_info(user_inventory_limits)').all();
  if (!columns.some(column => column.name === 'earned_slots')) {
    db.exec('ALTER TABLE user_inventory_limits ADD COLUMN earned_slots INTEGER NOT NULL DEFAULT 0');
    db.exec('UPDATE user_inventory_limits SET earned_slots = MAX(0, max_slots - 5)');
  }
}

export function getInventoryCapacity(db, guildId, userId) {
  const row = db.prepare('SELECT max_slots, earned_slots FROM user_inventory_limits WHERE guild_id = ? AND user_id = ?')
    .get(guildId, userId);
  const base = getGameConfig(db, guildId).capacity?.inventoryBase ?? 5;
  // Legacy absolute capacities were migrated relative to the historical base (5).
  // Only earned expansions survive base changes; possessions are never removed.
  return base + (row?.earned_slots ?? 0);
}

export function expandInventoryCapacity(db, guildId, userId) {
  const current = getInventoryCapacity(db, guildId, userId);
  const max = getGameConfig(db, guildId).capacity?.inventoryMax ?? 8;
  const slots = getResolvedItemDefinition(db, guildId, 'bag_of_holding')?.rules.capacityIncrease ?? 1;
  const next = Math.max(current, Math.min(max, current + slots));
  const earned = db.prepare('SELECT earned_slots FROM user_inventory_limits WHERE guild_id = ? AND user_id = ?').get(guildId, userId)?.earned_slots ?? 0;
  db.prepare(`
    INSERT INTO user_inventory_limits (guild_id, user_id, max_slots, earned_slots)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET max_slots = excluded.max_slots, earned_slots = excluded.earned_slots
  `).run(guildId, userId, next, earned + next - current);
  return next;
}

export function getInventory(db, guildId, userId) {
  return db.prepare('SELECT * FROM user_inventory WHERE guild_id = ? AND user_id = ? ORDER BY id ASC')
    .all(guildId, userId);
}

export function addItemToInventory(db, guildId, userId, itemId, charges = undefined) {
  charges ??= getResolvedItemDefinition(db, guildId, itemId)?.startingCharges ?? 1;
  const currentCount = db.prepare('SELECT COUNT(*) as count FROM user_inventory WHERE guild_id = ? AND user_id = ?')
    .get(guildId, userId).count;
  const capacity = getInventoryCapacity(db, guildId, userId);

  if (currentCount >= capacity) {
    return { status: 'full', capacity, currentCount };
  }

  const nowIso = new Date().toISOString();
  const info = db.prepare(`
    INSERT INTO user_inventory (guild_id, user_id, item_id, charges, acquired_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(guildId, userId, itemId, charges, nowIso);

  const item = db.prepare('SELECT * FROM user_inventory WHERE id = ?').get(info.lastInsertRowid);
  return { status: 'added', item };
}

export function isInventoryEscrowed(db, inventoryId) {
  return Boolean(db.prepare('SELECT 1 FROM item_action_costs WHERE inventory_id = ?').get(inventoryId));
}

export function getUsableInventory(db, guildId, userId) {
  return getInventory(db, guildId, userId).filter((item) => !isInventoryEscrowed(db, item.id));
}

export function removeItemFromInventory(db, inventoryId) {
  if (isInventoryEscrowed(db, inventoryId)) return false;
  const info = db.prepare('DELETE FROM user_inventory WHERE id = ?').run(inventoryId);
  return info.changes > 0;
}

export function decrementItemCharge(db, inventoryId) {
  if (isInventoryEscrowed(db, inventoryId)) return { remainingCharges: 0, removed: false, escrowed: true };
  const item = db.prepare('SELECT * FROM user_inventory WHERE id = ?').get(inventoryId);
  if (!item) return { remainingCharges: 0, removed: true };

  const nextCharges = item.charges - 1;
  if (nextCharges <= 0) {
    db.prepare('DELETE FROM user_inventory WHERE id = ?').run(inventoryId);
    return { remainingCharges: 0, removed: true };
  }

  db.prepare('UPDATE user_inventory SET charges = ? WHERE id = ?').run(nextCharges, inventoryId);
  return { remainingCharges: nextCharges, removed: false };
}

export function addCharacterLock(db, guildId, characterId, lockType, protectedUntil) {
  if (db.prepare('SELECT 1 FROM item_character_reservations WHERE guild_id = ? AND character_id = ?').get(guildId, characterId)) {
    throw new Error('This character is reserved by a Hostage challenge.');
  }
  db.prepare('DELETE FROM counterfeit_crowns WHERE guild_id = ? AND character_id = ?').run(guildId, characterId);
  db.prepare(`
    INSERT INTO character_protection_locks (guild_id, character_id, lock_type, protected_until)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(guild_id, character_id) DO UPDATE SET
      lock_type = excluded.lock_type,
      protected_until = excluded.protected_until
  `).run(guildId, characterId, lockType, protectedUntil);
}

export function removeCharacterLock(db, guildId, characterId) {
  db.prepare('DELETE FROM character_protection_locks WHERE guild_id = ? AND character_id = ?')
    .run(guildId, characterId);
}

export function isCharacterLocked(db, guildId, characterId, now = Date.now()) {
  const row = db.prepare('SELECT * FROM character_protection_locks WHERE guild_id = ? AND character_id = ?')
    .get(guildId, characterId);
  if (!row) return { locked: false };

  // If protected_until is null, it's permanent (soulbind)
  if (row.protected_until === null) {
    return { locked: true, lockType: row.lock_type, permanent: true };
  }

  if (row.protected_until > now) {
    return { locked: true, lockType: row.lock_type, expiresAt: row.protected_until };
  }

  // Expired lock: clean it up
  removeCharacterLock(db, guildId, characterId);
  return { locked: false };
}

/**
 * @param {string | null} [dataJson]
 * @param {number | null} [expiresAt]
 * @param {number | null} [rollsToAdd]
 */
export function addActiveBuff(db, guildId, userId, buffId, dataJson = null, expiresAt = null, rollsToAdd = null) {
  // Timed item snapshots carry their duration, so their supplied deadline also
  // identifies activation time (including callers using simulated time).
  let now = Date.now();
  if (expiresAt !== null && dataJson !== null) {
    try {
      const duration = JSON.parse(dataJson)?.durationMs;
      if (Number.isFinite(duration) && duration > 0) now = expiresAt - duration;
    } catch { /* Legacy/custom data need not be a JSON rules snapshot. */ }
  }
  const tail = db.prepare(`SELECT * FROM active_user_buffs
    WHERE guild_id = ? AND user_id = ? AND buff_id = ?
      AND (expires_at IS NULL OR expires_at > ?)
      AND (remaining_rolls IS NULL OR remaining_rolls > 0)
    ORDER BY id DESC LIMIT 1`).get(guildId, userId, buffId, now);
  // Never merge into an earlier matching rule across a distinct queued snapshot.
  const existing = tail?.data_json === dataJson ? tail : undefined;

  if (existing) {
    let nextExpires = existing.expires_at;
    if (expiresAt !== null) {
      const addedDuration = Math.max(0, expiresAt - now);
      nextExpires = Math.max(now, existing.expires_at ?? now) + addedDuration;
    }

    let nextRolls = existing.remaining_rolls;
    if (rollsToAdd !== null) {
      nextRolls = (existing.remaining_rolls || 0) + rollsToAdd;
    }

    db.prepare(`
      UPDATE active_user_buffs
      SET expires_at = ?, remaining_rolls = ?, data_json = COALESCE(?, data_json)
      WHERE id = ?
    `).run(nextExpires, nextRolls, dataJson, existing.id);

    return db.prepare('SELECT * FROM active_user_buffs WHERE id = ?').get(existing.id);
  }

  const startsAt = expiresAt === null ? null : Math.max(now, tail?.expires_at ?? now);
  const deadline = expiresAt === null ? null : (startsAt ?? now) + Math.max(0, expiresAt - now);
  const info = db.prepare(`
    INSERT INTO active_user_buffs (guild_id, user_id, buff_id, data_json, expires_at, remaining_rolls, starts_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(guildId, userId, buffId, dataJson, deadline, rollsToAdd, startsAt);

  return db.prepare('SELECT * FROM active_user_buffs WHERE id = ?').get(info.lastInsertRowid);
}

export function getActiveBuffs(db, guildId, userId, now = Date.now()) {
  return filterActiveBuffs(db, db.prepare('SELECT * FROM active_user_buffs WHERE guild_id = ? AND user_id = ? ORDER BY id')
    .all(guildId, userId), now);
}

/** Guild-wide buffs are stored against an empty user id. */
export function getGuildBuffs(db, guildId, now = Date.now()) {
  return filterActiveBuffs(db,
    db.prepare("SELECT * FROM active_user_buffs WHERE guild_id = ? AND user_id = '' ORDER BY id").all(guildId), now);
}

function filterActiveBuffs(db, rows, now) {
  const active = [];
  for (const row of rows) {
    if (row.expires_at !== null && row.expires_at <= now) {
      db.prepare('DELETE FROM active_user_buffs WHERE id = ?').run(row.id);
      continue;
    }
    if (row.remaining_rolls !== null && row.remaining_rolls <= 0) {
      db.prepare('DELETE FROM active_user_buffs WHERE id = ?').run(row.id);
      continue;
    }
    if (row.starts_at !== null && row.starts_at > now) continue;
    active.push(row);
  }
  return active;
}

export function consumeBuffRoll(db, buffRecordId) {
  const row = db.prepare('SELECT remaining_rolls FROM active_user_buffs WHERE id = ?').get(buffRecordId);
  if (!row) return;

  const next = row.remaining_rolls - 1;
  if (next <= 0) {
    db.prepare('DELETE FROM active_user_buffs WHERE id = ?').run(buffRecordId);
  } else {
    db.prepare('UPDATE active_user_buffs SET remaining_rolls = ? WHERE id = ?').run(next, buffRecordId);
  }
}
