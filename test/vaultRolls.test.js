import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { openCatalog } from '../lib/catalogDb.js';
import { reserveRoll } from '../lib/characterRolls.js';
import { passesVaultGate, VAULT_DROP_RATE } from '../lib/vaultRolls.js';

test('passesVaultGate correctly triggers at 0.5% rate', () => {
  assert.equal(VAULT_DROP_RATE, 0.005);
  assert.equal(passesVaultGate(() => 0.004), true);
  assert.equal(passesVaultGate(() => 0.005), false);
  assert.equal(passesVaultGate(() => 0.5), false);
});

test('reserveRoll with vault roll triggers vault status, consumes roll allowance, and does not select character', () => {
  const testDb = openCatalog(':memory:');
  testDb.exec(`
    INSERT INTO characters (id, rank, favourites, name_full, gender)
    VALUES (1, 10, 5000, 'Rem', 'female');
  `);

  const guildId = '1001';
  const channelId = '2001';
  const userId = '3001';

  // Force vault trigger: random returns 0.001 (< 0.005)
  const res = reserveRoll(testDb, {
    guildId,
    channelId,
    commandMessageId: '123456789',
    userId,
    pool: 'w',
    vaultEnabled: true,
    random: () => 0.001,
  });

  assert.equal(res.status, 'vault');
  assert.equal(res.remaining, 6); // 7 default max - 1 used
});
