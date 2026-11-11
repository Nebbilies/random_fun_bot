/** SQLite operations for allowances. Callers own transactions and game decisions. */

export function readRollAllowance(db, guildId, userId) {
  return db.prepare('SELECT period, used FROM roll_allowances WHERE guild_id = ? AND user_id = ?')
    .get(guildId, userId);
}

export function writeRollAllowance(db, guildId, userId, period, used) {
  db.prepare(`INSERT INTO roll_allowances (guild_id, user_id, period, used) VALUES (?, ?, ?, ?)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET period=excluded.period, used=excluded.used`)
    .run(guildId, userId, period, used);
}

export function readUsedRollAllowances(db) {
  return db.prepare('SELECT * FROM roll_allowances WHERE used > 0').all();
}

/** Prepare once for a global adjustment; the callback supplies the game-rule result. */
export function updateUsedRollAllowances(db, resolveUsed) {
  let updated = 0;
  const update = db.prepare('UPDATE roll_allowances SET used = ? WHERE guild_id = ? AND user_id = ?');
  for (const row of readUsedRollAllowances(db)) {
    const used = resolveUsed(row);
    if (used === null) continue;
    update.run(used, row.guild_id, row.user_id);
    updated++;
  }
  return updated;
}

export function writeMaxRolls(db, guildId, amount) {
  db.prepare(`INSERT INTO guild_roll_limits (guild_id, max_rolls) VALUES (?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET max_rolls = excluded.max_rolls`).run(guildId, amount);
}

export function clearClaimUsage(db) {
  const updated = Number(db.prepare('DELETE FROM claim_allowances').run().changes);
  db.prepare('DELETE FROM claim_events').run();
  return updated;
}

export function readDailyClaim(db, guildId, userId) {
  return db.prepare('SELECT * FROM daily_roll_claims WHERE guild_id=? AND user_id=?').get(guildId, userId);
}

export function writeDailyClaim(db, guildId, userId, period, nextReset) {
  db.prepare(`INSERT INTO daily_roll_claims (guild_id, user_id, period, reset_at)
    VALUES (?, ?, ?, ?) ON CONFLICT(guild_id, user_id) DO UPDATE SET period=excluded.period, reset_at=excluded.reset_at`)
    .run(guildId, userId, period, nextReset);
}

export function readClaimAllowance(db, guildId, userId) {
  return db.prepare('SELECT period FROM claim_allowances WHERE guild_id = ? AND user_id = ?')
    .get(guildId, userId);
}

export function readClaimEvent(db, guildId, userId) {
  return db.prepare('SELECT claimed_at FROM claim_events WHERE guild_id = ? AND user_id = ?')
    .get(guildId, userId);
}

/** Eligibility reads must not prune expired buffs or materialize legacy counters. */
export function readClaimBuffs(db, guildId, userId, now) {
  return db.prepare(`SELECT * FROM active_user_buffs WHERE guild_id=? AND user_id=?
    AND (expires_at IS NULL OR expires_at>?) AND (remaining_rolls IS NULL OR remaining_rolls>0)
    AND (starts_at IS NULL OR starts_at<=?) ORDER BY id`).all(guildId, userId, now, now);
}

export function refundRollAllowance(db, guildId, userId, period, amount) {
  db.prepare(`UPDATE roll_allowances SET used = MAX(0, used - ?)
    WHERE guild_id = ? AND user_id = ? AND period = ?`).run(amount, guildId, userId, period);
}

/** Both writes join the successful marriage's existing transaction. */
export function recordClaimUsage(db, guildId, userId, period, now) {
  db.prepare(`INSERT INTO claim_allowances (guild_id, user_id, period) VALUES (?, ?, ?)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET period = excluded.period`)
    .run(guildId, userId, period);
  db.prepare(`INSERT INTO claim_events (guild_id, user_id, claimed_at) VALUES (?, ?, ?)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET claimed_at = excluded.claimed_at`)
    .run(guildId, userId, now);
}
