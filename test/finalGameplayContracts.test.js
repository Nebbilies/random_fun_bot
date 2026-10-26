import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFinalCatalog, openCatalog } from '../lib/catalogDb.js';
import { getGameConfig } from '../lib/gameConfig.js';
import { reserveMysteryAwareRoll } from '../lib/mysteryCoordinator.js';
import { reserveRoll } from '../lib/characterRolls.js';
import { addActiveBuff, addItemToInventory, getInventory } from '../lib/itemStorage.js';
import { createItemAction, activateItemAction } from '../lib/itemActions.js';
import { getItemAction } from '../lib/itemActionStorage.js';
import { isValidCharacterId, loadCharacterIndex, findCharacters } from '../lib/gameCharacterLookup.js';
import { getMarriage, marryCharacter, divorceCharacter } from '../lib/characterMarriage.js';
import { getOwnedCharacter, transferCharacter, swapCharacters } from '../lib/characterTrade.js';
import { addWish, removeWish, findWishMatchers } from '../lib/characterWishlist.js';

const ids = ['12345678-1234-4123-8123-123456789abc', 'abcdef01-2345-4678-9abc-def012345678',
  '99999999-8888-4777-8666-555555555555', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'];
const now = 1_800_000_000_000;
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'final-gameplay-'));
  const db = createFinalCatalog(join(dir, 'catalog.sqlite'));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  ids.forEach((id, i) => {
    db.prepare("INSERT INTO character_identities(id,creation_method) VALUES (?,'manual')").run(id);
    db.prepare(`INSERT INTO characters(id,rank,favourites,tie_order,likes_source,name_full,gender)
      VALUES (?,?,?,?,'generated',?,'female')`).run(id, i + 1, 2000 - i, i + 1, `Manual ${i}`);
  });
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 12);
  return db;
}

for (const clover of [false, true]) test(`manual-only Clue fallback creates exactly one ordinary roll (Clover=${clover})`, t => {
  const db = fixture(t);
  const config = structuredClone(getGameConfig(db, '1'));
  for (const [id, event] of Object.entries(config.mysteryEvents)) event.enabled = id === 'clue_reveal';
  const buff = clover ? addActiveBuff(db, '1', '101', 'four_leaf_clover', null, null, 3) : null;
  const request = { guildId: '1', channelId: '10', commandMessageId: '100', userId: '101',
    pool: 'w', now, random: () => 0, mysteryEnabled: true, gameConfig: config };
  const result = reserveMysteryAwareRoll(db, request);
  assert.equal(result.status, 'reserved');
  assert.equal(result.character.id, ids[0]);
  assert.equal(result.remaining, config.rolls.maxRolls - 1);
  assert.equal(db.prepare('SELECT channel_id FROM character_rolls').get().channel_id, '10');
  assert.equal(db.prepare('SELECT count(*) n FROM mystery_sessions').get().n, 0);
  assert.equal(db.prepare('SELECT used FROM roll_allowances').get().used, 1);
  assert.equal(reserveMysteryAwareRoll(db, request).status, 'duplicate');
  assert.equal(db.prepare('SELECT count(*) n FROM character_rolls').get().n, 1);
  if (buff) assert.equal(db.prepare('SELECT remaining_rolls FROM active_user_buffs WHERE id=?').get(buff.id).remaining_rolls, 2);
});

test('invalid mystery selection still rolls back rather than becoming an ordinary roll', t => {
  const db = fixture(t);
  assert.throws(() => reserveRoll(db, { guildId: '1', channelId: '10', commandMessageId: '100',
    userId: '101', pool: 'w', now, random: () => 0,
    mystery: { eventChannelId: '20', selectEvent: () => ({ eventId: 'clue_reveal', durationMs: 0 }) } }), /Invalid mystery event/);
  assert.equal(db.prepare('SELECT count(*) n FROM character_rolls').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM roll_allowances').get().n, 0);
});

function actionFixture(db, kind) {
  const choices = ids.map((characterId, i) => ({ characterId, ownerId: `${i + 1}01`,
    marriageId: marryCharacter(db, '1', characterId, `${i + 1}01`).marriage.id }));
  const item = addItemToInventory(db, '1', '101', kind).item;
  const action = createItemAction(db, { guildId: '1', actorId: '101', channelId: '10',
    inventoryId: item.id, selections: { own: choices[0], targets: kind === 'grand_masquerade' ? choices.slice(1) : [choices[1]] }, now });
  return { action, choices, item, request: { actionId: action.id, guildId: '1', actorId: '101', now: now + 1, random: () => 0 } };
}
for (const kind of ['heart_for_a_heart', 'grand_masquerade']) test(`${kind} live rank refusal cancels durably without cost or revival`, t => {
  const db = fixture(t);
  const { action, choices, item, request } = actionFixture(db, kind);
  const inventory = getInventory(db, '1', '101');
  // Simulate a catalog re-ranking after the confirmation prompt was published.
  db.prepare('UPDATE characters SET rank=10000 WHERE id=?').run(kind === 'heart_for_a_heart' ? ids[0] : ids[1]);
  const result = activateItemAction(db, request);
  assert.equal(result.status, 'invalid');
  const stored = getItemAction(db, action.id);
  assert.equal(stored.state, 'canceled');
  assert.equal(stored.delivery_pending, 1);
  assert.equal(stored.result.noCost, true);
  assert.deepEqual(getInventory(db, '1', '101'), inventory);
  ids.forEach((id, i) => db.prepare('UPDATE characters SET rank=? WHERE id=?').run(i + 1, id));
  assert.equal(activateItemAction(db, request).status, 'canceled');
  choices.forEach(row => assert.equal(getMarriage(db, '1', row.characterId).ownerId, row.ownerId));
  assert.ok(getInventory(db, '1', '101').some(row => row.id === item.id));
  assert.equal(db.prepare('SELECT count(*) n FROM item_character_reservations').get().n, 0);
});

test('SQL failure rolls back but leaves confirmation retryable; unauthorized refusal cannot cancel it', t => {
  const db = fixture(t);
  const { action, request } = actionFixture(db, 'grand_masquerade');
  const inventory = getInventory(db, '1', '101');
  assert.equal(activateItemAction(db, { ...request, actorId: '999' }).status, 'invalid');
  assert.equal(getItemAction(db, action.id).state, 'confirming');
  db.exec("CREATE TRIGGER reject_transfer BEFORE UPDATE ON marriages BEGIN SELECT RAISE(ABORT,'simulated DB failure'); END");
  assert.throws(() => activateItemAction(db, request), /simulated DB failure/);
  assert.equal(getItemAction(db, action.id).state, 'confirming');
  assert.deepEqual(getInventory(db, '1', '101'), inventory);
  db.exec('DROP TRIGGER reject_transfer');
  assert.equal(activateItemAction(db, request).status, 'resolved');
});

test('final APIs reject numeric/source IDs, while UUIDs and rank search work', t => {
  const db = fixture(t);
  assert.equal(isValidCharacterId(ids[0], db), true);
  for (const id of [1, Number.MAX_SAFE_INTEGER, '1', 'anilist:1', ids[0].toUpperCase()]) {
    assert.equal(isValidCharacterId(id, db), false);
    for (const call of [
      () => getMarriage(db, '1', id), () => marryCharacter(db, '1', id, '101'),
      () => divorceCharacter(db, '1', id, '101', 1), () => getOwnedCharacter(db, '1', '101', id),
      () => addWish(db, { guildId: '1', userId: '101', characterId: id }),
      () => removeWish(db, { guildId: '1', userId: '101', characterId: id }),
      () => findWishMatchers(db, { guildId: '1', characterId: id }),
      () => transferCharacter(db, { guildId: '1', characterId: id, fromOwnerId: '101', toOwnerId: '201' }),
      () => swapCharacters(db, { guildId: '1', first: { characterId: ids[0], ownerId: '101' }, second: { characterId: id, ownerId: '201' } }),
    ]) assert.throws(call, /Invalid/);
  }
  assert.equal(findCharacters(loadCharacterIndex(db), '#1')[0].id, ids[0]);
  assert.equal(marryCharacter(db, '1', ids[0], '101').status, 'married');
  assert.equal(addWish(db, { guildId: '1', userId: '101', characterId: ids[0] }).status, 'added');
  assert.equal(transferCharacter(db, { guildId: '1', characterId: ids[0], fromOwnerId: '101', toOwnerId: '201' }).status, 'transferred');
});

test('numeric IDs require a legacy connection and validation observes schema changes', t => {
  const db = openCatalog(':memory:');
  t.after(() => db.close());
  assert.equal(isValidCharacterId(1), false);
  assert.equal(isValidCharacterId(1, db), true);
  db.exec("INSERT INTO characters(id,rank,favourites,name_full) VALUES(1,1,1,'Legacy')");
  assert.equal(marryCharacter(db, '1', 1, '101').status, 'married');
  assert.equal(getOwnedCharacter(db, '1', '101', 1).characterId, 1);
  assert.equal(addWish(db, { guildId: '1', userId: '101', characterId: 1 }).status, 'added');
  for (const version of [11, 12, 13]) {
    db.exec(`PRAGMA user_version=${version}`);
    assert.equal(isValidCharacterId(1, db), false);
    assert.throws(() => getMarriage(db, '1', 1), /Invalid/);
  }
  db.exec('PRAGMA user_version=10');
  assert.equal(isValidCharacterId(1, db), true);
});
