const DEFAULT_CAPACITY = 5;
const MAX_CAPACITY = 8;

export function initItemStorage(db) {
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
}

export function getInventoryCapacity(db, guildId, userId) {
  const row = db.prepare('SELECT max_slots FROM user_inventory_limits WHERE guild_id = ? AND user_id = ?')
    .get(guildId, userId);
  return row ? row.max_slots : DEFAULT_CAPACITY;
}

export function expandInventoryCapacity(db, guildId, userId) {
  const current = getInventoryCapacity(db, guildId, userId);
  const next = Math.min(MAX_CAPACITY, current + 1);
  db.prepare(`
    INSERT INTO user_inventory_limits (guild_id, user_id, max_slots)
    VALUES (?, ?, ?)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET max_slots = excluded.max_slots
  `).run(guildId, userId, next);
  return next;
}

export function getInventory(db, guildId, userId) {
  return db.prepare('SELECT * FROM user_inventory WHERE guild_id = ? AND user_id = ? ORDER BY id ASC')
    .all(guildId, userId);
}

export function addItemToInventory(db, guildId, userId, itemId, charges = 1) {
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

export function removeItemFromInventory(db, inventoryId) {
  const info = db.prepare('DELETE FROM user_inventory WHERE id = ?').run(inventoryId);
  return info.changes > 0;
}

export function decrementItemCharge(db, inventoryId) {
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

export function addActiveBuff(db, guildId, userId, buffId, dataJson = null, expiresAt = null, rollsToAdd = null) {
  // Check if buff already exists to stack it
  const existing = db.prepare('SELECT * FROM active_user_buffs WHERE guild_id = ? AND user_id = ? AND buff_id = ?')
    .get(guildId, userId, buffId);

  if (existing) {
    let nextExpires = existing.expires_at;
    if (expiresAt !== null) {
      const now = Date.now();
      const currentRemaining = Math.max(0, (existing.expires_at || now) - now);
      const addedDuration = expiresAt - now;
      nextExpires = now + currentRemaining + addedDuration;
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

  const info = db.prepare(`
    INSERT INTO active_user_buffs (guild_id, user_id, buff_id, data_json, expires_at, remaining_rolls)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(guildId, userId, buffId, dataJson, expiresAt, rollsToAdd);

  return db.prepare('SELECT * FROM active_user_buffs WHERE id = ?').get(info.lastInsertRowid);
}

export function getActiveBuffs(db, guildId, userId, now = Date.now()) {
  const rows = db.prepare('SELECT * FROM active_user_buffs WHERE guild_id = ? AND user_id = ?')
    .all(guildId, userId);

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
