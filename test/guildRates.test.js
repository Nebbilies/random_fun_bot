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
import { getConfigView, initGameConfig, saveConfigSection } from '../lib/gameConfig.js';

function saveRate(db, guildId, key, value) {
  return saveConfigSection(db, {
    guildId, section: key.split('.')[0], values: { [key]: value },
    expectedRevision: getConfigView(db).revision,
  });
}

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

test('rate reads see committed changes immediately without a process-local cache', () => {
  const db = openCatalog(':memory:');
  const guildId = '55555';
  let now = 10_000_000;

  setGuildRates(db, guildId, { vaultRate: 0.1, prankRate: 0.05 }, now);

  // Directly tamper database row without using setGuildRates
  db.prepare('UPDATE guild_game_rates SET vault_rate = 0.5 WHERE guild_id = ?').run(guildId);

  // Separate web/bot processes must observe committed changes on their next action.
  const cached = getGuildRates(db, guildId, now + 1_000);
  assert.equal(cached.vaultRate, 0.5);

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

for (const [field, key, companion, companionKey] of [
  ['vaultRate', 'vault.dropRate', 'prankRate', 'rolls.prankRate'],
  ['prankRate', 'rolls.prankRate', 'vaultRate', 'vault.dropRate'],
]) {
  test(`partial ${field} setter preserves companion inheritance and newer overrides`, () => {
    const db = openCatalog(':memory:');
    try {
      saveRate(db, null, companionKey, 0.2);
      setGuildRates(db, '123', { [field]: 0.3 });
      assert.equal(getConfigView(db, '123').sources[companionKey], 'global');
      saveRate(db, null, companionKey, 0.4);
      assert.equal(getGuildRates(db, '123')[companion], 0.4);

      saveRate(db, '123', companionKey, 0.6);
      setGuildRates(db, '123', { [field]: 0.5 });
      assert.equal(getGuildRates(db, '123')[companion], 0.6);
      assert.equal(getConfigView(db, '123').sources[companionKey], 'guild');

      // Setting the same legacy value must still replace a newer web override.
      saveRate(db, '123', key, 0.8);
      setGuildRates(db, '123', { [field]: 0.5 });
      assert.equal(getGuildRates(db, '123')[field], 0.5);
    } finally { db.close(); }
  });

  test(`raw legacy ${field} UPDATE preserves unrelated web overrides and inheritance`, () => {
    const db = openCatalog(':memory:');
    const column = field === 'vaultRate' ? 'vault_rate' : 'prank_rate';
    try {
      setGuildRates(db, '123', { vaultRate: 0.1, prankRate: 0.2 });
      saveRate(db, '123', companionKey, 0.6);
      db.prepare(`UPDATE guild_game_rates SET ${column}=? WHERE guild_id=?`).run(0.3, '123');
      assert.equal(getGuildRates(db, '123')[field], 0.3);
      assert.equal(getGuildRates(db, '123')[companion], 0.6);

      saveConfigSection(db, { guildId: '123', section: companionKey.split('.')[0],
        reset: [companionKey], expectedRevision: getConfigView(db).revision });
      saveRate(db, null, companionKey, 0.7);
      db.prepare(`UPDATE guild_game_rates SET ${column}=? WHERE guild_id=?`).run(0.4, '123');
      assert.equal(getConfigView(db, '123').sources[companionKey], 'global');
      assert.equal(getGuildRates(db, '123')[companion], 0.7);

      saveRate(db, '123', key, 0.9);
      db.prepare(`UPDATE guild_game_rates SET ${column}=${column}, updated_at=42 WHERE guild_id=?`).run('123');
      assert.equal(getGuildRates(db, '123')[field], 0.9);
    } finally { db.close(); }
  });
}

test('schema initialization replaces old unconditional legacy UPDATE triggers', () => {
  const db = openCatalog(':memory:');
  try {
    db.exec(`DROP TRIGGER game_config_guild_game_rates_update;
      CREATE TRIGGER game_config_guild_game_rates_update AFTER UPDATE ON guild_game_rates BEGIN
        INSERT INTO game_config_overrides(scope_id,key,value_json)
        VALUES(NEW.guild_id,'rolls.prankRate',CAST(NEW.prank_rate AS TEXT))
        ON CONFLICT(scope_id,key) DO UPDATE SET value_json=excluded.value_json;
      END;`);
    setGuildRates(db, '123', { vaultRate: 0.1, prankRate: 0.2 });
    saveRate(db, '123', 'rolls.prankRate', 0.8);
    initGameConfig(db);
    initGameConfig(db);
    db.prepare('UPDATE guild_game_rates SET vault_rate=0.3 WHERE guild_id=?').run('123');
    assert.deepEqual(getGuildRates(db, '123'), { vaultRate: 0.3, prankRate: 0.8 });
  } finally { db.close(); }
});

test('partial setter rolls back legacy values, overrides and revision on failure', () => {
  const db = openCatalog(':memory:');
  try {
    const before = getConfigView(db, '123');
    // Fail after the legacy INSERT and its bridge have already succeeded.
    db.exec(`CREATE TRIGGER reject_rate BEFORE DELETE ON game_config_overrides
      WHEN OLD.scope_id='123' AND OLD.key='rolls.prankRate'
      BEGIN SELECT RAISE(ABORT, 'reject rate'); END;`);
    assert.throws(() => setGuildRates(db, '123', { vaultRate: 0.5 }), /reject rate/);
    assert.equal(db.prepare('SELECT * FROM guild_game_rates WHERE guild_id=?').get('123'), undefined);
    assert.deepEqual(getConfigView(db, '123'), before);
    assert.equal(db.isTransaction, false);
  } finally { db.close(); }
});

test('partial setter participates in an outer transaction without committing it', () => {
  const db = openCatalog(':memory:');
  try {
    const before = getConfigView(db, '123');
    db.exec('BEGIN');
    setGuildRates(db, '123', { prankRate: 0.5 });
    assert.equal(db.isTransaction, true);
    assert.equal(getGuildRates(db, '123').prankRate, 0.5);
    db.exec('ROLLBACK');
    assert.deepEqual(getConfigView(db, '123'), before);
    assert.equal(db.prepare('SELECT * FROM guild_game_rates WHERE guild_id=?').get('123'), undefined);
  } finally { db.close(); }
});

test('raw legacy INSERT intentionally maps both rates', () => {
  const db = openCatalog(':memory:');
  try {
    db.prepare('INSERT INTO guild_game_rates(guild_id,vault_rate,prank_rate,updated_at) VALUES(?,?,?,?)')
      .run('123', 0.2, 0.3, 0);
    assert.deepEqual(getGuildRates(db, '123'), { vaultRate: 0.2, prankRate: 0.3 });
    const { sources } = getConfigView(db, '123');
    assert.equal(sources['vault.dropRate'], 'guild');
    assert.equal(sources['rolls.prankRate'], 'guild');
  } finally { db.close(); }
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
