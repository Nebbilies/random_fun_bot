import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import { openCatalog } from '../lib/catalogDb.js';
import {
  DEFAULT_PRANK_RATE,
  DEFAULT_VAULT_RATE,
  CACHE_TTL_MS,
  getGuildRates,
  setGuildRates,
  clearGuildRateCache,
  isValidRate,
} from '../lib/guildRates.js';
import { reserveRoll } from '../lib/characterRolls.js';

beforeEach(() => {
  clearGuildRateCache();
});

test('isValidRate validates rate bounds between 0.0 and 1.0', () => {
  assert.equal(isValidRate(0), true);
  assert.equal(isValidRate(1), true);
  assert.equal(isValidRate(0.05), true);
  assert.equal(isValidRate(-0.01), false);
  assert.equal(isValidRate(1.01), false);
  assert.equal(isValidRate(NaN), false);
  assert.equal(isValidRate(Infinity), false);
  assert.equal(isValidRate('0.05'), false);
  assert.equal(isValidRate(null), false);
  assert.equal(isValidRate(undefined), false);
});

test('getGuildRates returns defaults when no guild rate record exists', () => {
  const db = openCatalog(':memory:');
  const rates = getGuildRates(db, '99999');
  assert.equal(rates.vaultRate, DEFAULT_VAULT_RATE);
  assert.equal(rates.prankRate, DEFAULT_PRANK_RATE);
  db.close();
});

test('setGuildRates stores custom rates in DB and caches immediately', () => {
  const db = openCatalog(':memory:');
  const guildId = '12345';
  const now = 1_000_000;

  const updated = setGuildRates(db, guildId, { vaultRate: 0.05, prankRate: 0.02 }, now);
  assert.equal(updated.vaultRate, 0.05);
  assert.equal(updated.prankRate, 0.02);

  // Directly verify database row
  const row = db.prepare('SELECT vault_rate, prank_rate FROM guild_game_rates WHERE guild_id = ?').get(guildId);
  assert.equal(row.vault_rate, 0.05);
  assert.equal(row.prank_rate, 0.02);

  // Reading via getGuildRates returns cached rates
  const cachedRates = getGuildRates(db, guildId, now + 1000);
  assert.equal(cachedRates.vaultRate, 0.05);
  assert.equal(cachedRates.prankRate, 0.02);

  db.close();
});

test('cache serves rates without querying database repeatedly until TTL expires', () => {
  const db = openCatalog(':memory:');
  const guildId = '55555';
  let now = 10_000_000;

  setGuildRates(db, guildId, { vaultRate: 0.1, prankRate: 0.05 }, now);

  // Directly tamper database row without using setGuildRates
  db.prepare('UPDATE guild_game_rates SET vault_rate = 0.5 WHERE guild_id = ?').run(guildId);

  // Within TTL: getGuildRates should still return cached 0.1
  const cached = getGuildRates(db, guildId, now + 60_000);
  assert.equal(cached.vaultRate, 0.1);

  // After TTL: cache expires and refreshes from DB
  const refreshed = getGuildRates(db, guildId, now + CACHE_TTL_MS + 1);
  assert.equal(refreshed.vaultRate, 0.5);

  db.close();
});

test('clearGuildRateCache invalidates cached entries immediately', () => {
  const db = openCatalog(':memory:');
  const guildId = '77777';
  const now = 10_000_000;

  setGuildRates(db, guildId, { vaultRate: 0.1 }, now);
  db.prepare('UPDATE guild_game_rates SET vault_rate = 0.2 WHERE guild_id = ?').run(guildId);

  clearGuildRateCache(guildId);
  const reloaded = getGuildRates(db, guildId, now + 1000);
  assert.equal(reloaded.vaultRate, 0.2);

  db.close();
});

test('setGuildRates rejects invalid rates and invalid guildId', () => {
  const db = openCatalog(':memory:');
  assert.throws(() => setGuildRates(db, '', { vaultRate: 0.1 }), /Invalid guildId/);
  assert.throws(() => setGuildRates(db, '123', { vaultRate: -0.1 }), /Invalid vaultRate/);
  assert.throws(() => setGuildRates(db, '123', { vaultRate: 1.5 }), /Invalid vaultRate/);
  assert.throws(() => setGuildRates(db, '123', { prankRate: 2 }), /Invalid prankRate/);
  db.close();
});

test('custom guild rates are respected by reserveRoll in characterRolls', () => {
  const db = openCatalog(':memory:');
  const guildId = '1000';
  const channelId = '2000';
  const userId = '3000';
  const now = 100_000;

  db.prepare("INSERT INTO characters (id, rank, favourites, name_full, gender) VALUES (1, 1, 100, 'Hero', 'female')").run();

  // Set vaultRate = 0.5 and prankRate = 0
  setGuildRates(db, guildId, { vaultRate: 0.5, prankRate: 0 }, now);

  // draw = 0.4: since vaultRate is 0.5, 0.4 < 0.5 triggers vault!
  const resVault = reserveRoll(db, {
    guildId,
    channelId,
    commandMessageId: '10001',
    userId,
    pool: 'w',
    vaultEnabled: true,
    prankEnabled: true,
    random: () => 0.4,
    now,
  });
  assert.equal(resVault.status, 'vault');

  // Set vaultRate = 0 and prankRate = 0.1
  setGuildRates(db, guildId, { vaultRate: 0, prankRate: 0.1 }, now);

  // draw = 0.08: since prankRate is 0.1, 0.08 < 0.1 triggers prank!
  const resPrank = reserveRoll(db, {
    guildId,
    channelId,
    commandMessageId: '10002',
    userId,
    pool: 'w',
    vaultEnabled: true,
    prankEnabled: true,
    random: () => 0.08,
    now,
  });
  assert.equal(resPrank.status, 'prank');

  db.close();
});
