import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCatalog } from '../lib/catalogDb.js';
import { getMarriage, marryCharacter } from '../lib/characterMarriage.js';
import { swapCharacters, transferCharacter } from '../lib/characterTrade.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'character-trade-'));
  const db = openCatalog(join(directory, 'catalog.sqlite'));
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  db.prepare(`INSERT INTO characters (id, rank, favourites, name_full) VALUES
    (11, 1, 100, 'Eleven'), (12, 2, 90, 'Twelve')`).run();
  return db;
}

function soulbind(db, characterId) {
  db.prepare(`INSERT INTO character_protection_locks (guild_id, character_id, lock_type, protected_until)
    VALUES ('1', ?, 'soulbind', NULL)`).run(characterId);
}

function openEscape(db, characterId, marriageId, ownerId) {
  db.prepare(`INSERT INTO character_rolls (guild_id, channel_id, command_message_id, character_id,
    character_name, state, escape_marriage_id, escape_owner_id)
    VALUES ('1', '10', ?, ?, 'Eleven', 'open', ?, ?)`)
    .run(`cmd-${characterId}`, characterId, marriageId, ownerId);
}

test('transfer hands a character to the new owner', (t) => {
  const db = fixture(t);
  marryCharacter(db, '1', 11, '101');
  const result = transferCharacter(db, {
    guildId: '1', characterId: 11, fromOwnerId: '101', toOwnerId: '102',
  });
  assert.equal(result.status, 'transferred');
  assert.equal(getMarriage(db, '1', 11)?.ownerId, '102');
});

test('transfer refuses a character the giver does not own', (t) => {
  const db = fixture(t);
  marryCharacter(db, '1', 11, '102');
  const result = transferCharacter(db, {
    guildId: '1', characterId: 11, fromOwnerId: '101', toOwnerId: '103',
  });
  assert.equal(result.status, 'not_owned');
  assert.equal(getMarriage(db, '1', 11)?.ownerId, '102');
});

test('transfer refuses a soulbound character', (t) => {
  const db = fixture(t);
  marryCharacter(db, '1', 11, '101');
  soulbind(db, 11);
  const result = transferCharacter(db, {
    guildId: '1', characterId: 11, fromOwnerId: '101', toOwnerId: '102',
  });
  assert.equal(result.status, 'locked');
  assert.equal(getMarriage(db, '1', 11)?.ownerId, '101');
});

test('transfer refuses a character that is trying to escape', (t) => {
  const db = fixture(t);
  marryCharacter(db, '1', 11, '101');
  const marriage = getMarriage(db, '1', 11);
  openEscape(db, 11, marriage?.id ?? 1, '101');
  const result = transferCharacter(db, {
    guildId: '1', characterId: 11, fromOwnerId: '101', toOwnerId: '102',
  });
  assert.equal(result.status, 'escaping');
  assert.equal(getMarriage(db, '1', 11)?.ownerId, '101');
});

test('swap exchanges both characters between the two players', (t) => {
  const db = fixture(t);
  marryCharacter(db, '1', 11, '101');
  marryCharacter(db, '1', 12, '102');
  const result = swapCharacters(db, {
    guildId: '1',
    first: { characterId: 11, ownerId: '101' },
    second: { characterId: 12, ownerId: '102' },
  });
  assert.equal(result.status, 'traded');
  assert.equal(getMarriage(db, '1', 11)?.ownerId, '102');
  assert.equal(getMarriage(db, '1', 12)?.ownerId, '101');
});

test('swap moves neither character when one of them is stuck', (t) => {
  const db = fixture(t);
  marryCharacter(db, '1', 11, '101');
  marryCharacter(db, '1', 12, '102');
  soulbind(db, 12);
  const result = swapCharacters(db, {
    guildId: '1',
    first: { characterId: 11, ownerId: '101' },
    second: { characterId: 12, ownerId: '102' },
  });
  assert.equal(result.status, 'locked');
  assert.equal(getMarriage(db, '1', 11)?.ownerId, '101');
  assert.equal(getMarriage(db, '1', 12)?.ownerId, '102');
});

test('a character cannot be traded for itself', (t) => {
  const db = fixture(t);
  marryCharacter(db, '1', 11, '101');
  const result = swapCharacters(db, {
    guildId: '1',
    first: { characterId: 11, ownerId: '101' },
    second: { characterId: 11, ownerId: '101' },
  });
  assert.equal(result.status, 'same_owner');
  assert.equal(getMarriage(db, '1', 11)?.ownerId, '101');
});
