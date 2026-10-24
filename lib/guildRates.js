import { getGameConfig } from './gameConfig.js';

export const DEFAULT_VAULT_RATE = 0.01;
export const DEFAULT_PRANK_RATE = 0.01;
// Compatibility export; configuration reads intentionally have no process-local TTL.
export const CACHE_TTL_MS = 0;
export function isValidRate(rate) {
  return typeof rate === 'number' && Number.isFinite(rate) && rate >= 0 && rate <= 1;
}
export function getGuildRates(db, guildId) {
  const config = getGameConfig(db, guildId);
  return { vaultRate: config.vault.dropRate, prankRate: config.rolls.prankRate };
}
export function setGuildRates(db, guildId, updates, now = Date.now()) {
  if (typeof guildId !== 'string' || !/^\d+$/.test(guildId)) throw new Error('Invalid guildId');
  for (const key of ['vaultRate', 'prankRate']) {
    if (updates[key] !== undefined && !isValidRate(updates[key])) throw new Error(`Invalid ${key}`);
  }
  const mappings = [['vaultRate', 'vault.dropRate'], ['prankRate', 'rolls.prankRate']];
  if (mappings.every(([field]) => updates[field] === undefined)) return getGuildRates(db, guildId);
  // Legacy rows require both values. Preserve the untouched override (or its
  // absence) across the INSERT bridge. Savepoints support outer transactions.
  db.exec('SAVEPOINT set_guild_rates');
  try {
    const current = getGuildRates(db, guildId);
    const read = db.prepare('SELECT value_json FROM game_config_overrides WHERE scope_id=? AND key=?');
    const untouched = mappings.filter(([field]) => updates[field] === undefined)
      .map(([, key]) => [key, read.get(guildId, key)]);
    db.prepare(`INSERT INTO guild_game_rates (guild_id, vault_rate, prank_rate, updated_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(guild_id) DO UPDATE SET
      vault_rate=excluded.vault_rate, prank_rate=excluded.prank_rate, updated_at=excluded.updated_at`)
      .run(guildId, updates.vaultRate ?? current.vaultRate, updates.prankRate ?? current.prankRate, now);
    const put = db.prepare(`INSERT INTO game_config_overrides(scope_id,key,value_json) VALUES(?,?,?)
      ON CONFLICT(scope_id,key) DO UPDATE SET value_json=excluded.value_json`);
    for (const [key, row] of untouched) {
      if (row) put.run(guildId, key, row.value_json);
      else db.prepare('DELETE FROM game_config_overrides WHERE scope_id=? AND key=?').run(guildId, key);
    }
    // Explicit setters must win even if the legacy column was unchanged and
    // the UPDATE bridge correctly skipped it (a web override may be newer).
    for (const [field, key] of mappings) {
      if (updates[field] !== undefined) put.run(guildId, key, JSON.stringify(updates[field]));
    }
    const result = getGuildRates(db, guildId);
    db.exec('RELEASE set_guild_rates');
    return result;
  } catch (error) {
    db.exec('ROLLBACK TO set_guild_rates; RELEASE set_guild_rates');
    throw error;
  }
}
export function clearGuildRateCache() {}
