import { DatabaseSync } from 'node:sqlite';
import { VAULT_DROP_RATE } from './vaultRolls.js';

export const DEFAULT_PRANK_RATE = 0.01;
export const DEFAULT_VAULT_RATE = VAULT_DROP_RATE; // 0.01

/**
 * @typedef {{
 *   vaultRate: number,
 *   prankRate: number
 * }} GuildRates
 */

/** @type {Map<string, { rates: GuildRates, expiresAt: number }>} */
const guildRateCache = new Map();

/** Cache TTL: 3 seconds in ms to protect against roll bursts while syncing across processes almost in real-time */
export const CACHE_TTL_MS = 3 * 1000;

/**
 * Validate a guild rate value (between 0.0 and 1.0 inclusive)
 * @param {number} rate
 * @returns {boolean}
 */
export function isValidRate(rate) {
  return typeof rate === 'number' && Number.isFinite(rate) && rate >= 0 && rate <= 1;
}

/**
 * Clear the in-memory cache entirely or for a specific guild.
 * Useful for tests or invalidation triggers.
 * @param {string} [guildId]
 */
export function clearGuildRateCache(guildId) {
  if (guildId) {
    guildRateCache.delete(guildId);
  } else {
    guildRateCache.clear();
  }
}

/**
 * List all configured guild rates from the database.
 * @param {DatabaseSync} db
 * @returns {Array<{ guildId: string, vaultRate: number, prankRate: number, updatedAt: number }>}
 */
export function listAllGuildRates(db) {
  const rows = db.prepare('SELECT guild_id, vault_rate, prank_rate, updated_at FROM guild_game_rates ORDER BY updated_at DESC').all();
  return rows.map((r) => ({
    guildId: String(r.guild_id),
    vaultRate: Number(r.vault_rate),
    prankRate: Number(r.prank_rate),
    updatedAt: Number(r.updated_at),
  }));
}

/**
 * Get rates for a guild, using the in-memory cache when fresh.
 * @param {DatabaseSync} db
 * @param {string} guildId
 * @param {number} [now]
 * @returns {GuildRates}
 */
export function getGuildRates(db, guildId, now = Date.now()) {
  if (!guildId) {
    return {
      vaultRate: DEFAULT_VAULT_RATE,
      prankRate: DEFAULT_PRANK_RATE,
    };
  }

  const cached = guildRateCache.get(guildId);
  if (cached && now < cached.expiresAt) {
    return cached.rates;
  }

  // Load from database
  const row = /** @type {{ vault_rate: number | null, prank_rate: number | null } | undefined} */ (
    db.prepare('SELECT vault_rate, prank_rate FROM guild_game_rates WHERE guild_id = ?').get(guildId)
  );

  const rates = {
    vaultRate: row?.vault_rate != null ? Number(row.vault_rate) : DEFAULT_VAULT_RATE,
    prankRate: row?.prank_rate != null ? Number(row.prank_rate) : DEFAULT_PRANK_RATE,
  };

  guildRateCache.set(guildId, {
    rates,
    expiresAt: now + CACHE_TTL_MS,
  });

  return rates;
}

/**
 * Update rates for a guild in the database and immediately refresh the cache.
 * @param {DatabaseSync} db
 * @param {string} guildId
 * @param {Partial<GuildRates>} newRates
 * @param {number} [now]
 * @returns {GuildRates}
 */
export function setGuildRates(db, guildId, newRates, now = Date.now()) {
  if (!guildId || typeof guildId !== 'string' || !/^\d+$/.test(guildId)) {
    throw new Error('Invalid guildId');
  }

  const current = getGuildRates(db, guildId, now);

  const vaultRate = newRates.vaultRate !== undefined ? newRates.vaultRate : current.vaultRate;
  const prankRate = newRates.prankRate !== undefined ? newRates.prankRate : current.prankRate;

  if (!isValidRate(vaultRate)) {
    throw new Error('Invalid vaultRate: must be a finite number between 0 and 1');
  }
  if (!isValidRate(prankRate)) {
    throw new Error('Invalid prankRate: must be a finite number between 0 and 1');
  }

  db.prepare(`
    INSERT INTO guild_game_rates (guild_id, vault_rate, prank_rate, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET
      vault_rate = excluded.vault_rate,
      prank_rate = excluded.prank_rate,
      updated_at = excluded.updated_at
  `).run(guildId, vaultRate, prankRate, now);

  const updatedRates = { vaultRate, prankRate };

  guildRateCache.set(guildId, {
    rates: updatedRates,
    expiresAt: now + CACHE_TTL_MS,
  });

  return updatedRates;
}
