import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptCharacterSnapshot } from '../lib/characterIdentitySnapshots.js';
import { captureCharacterSnapshot } from '../lib/characterSnapshot.js';
const mapping = new Map([[12, '00000000-0000-4000-8000-000000000012']]);
const own = { characterId: 12, marriageId: 12, ownerId: '12', rank: 12, name: 'Historical 12' };
function adapt(table, column, value, context = {}) {
  const raw = JSON.stringify(value, null, 2);
  const row = { id: 'fixture', ...context, [column]: raw };
  const inventory = adaptCharacterSnapshot(table, column, row);
  const result = adaptCharacterSnapshot(table, column, row, mapping);
  assert.equal(inventory.json, raw);
  if (!inventory.references.length) assert.equal(result.json, raw, 'noncharacter JSON stays byte-for-byte');
  return { ...result, value: JSON.parse(result.json) };
}

test('ownership selections keep marriage, rank, inventory, UI, item/config numbers and historical names', () => {
  const selections = { own, targets: [own], originals: [own], inventoryIds: [12], users: ['12'],
    _ui: { users: ['12'], slot: 'target0', page: 12, privateDelivered: true, privateMessageId: '12' },
    _rules: { hostageDecisionMs: 12 }, _rewardPools: { rare: [{ id: 'item_12', weight: 12 }] } };
  const result = adapt('item_actions', 'selections_json', selections, { kind: 'hostage_note' });
  assert.equal(result.references.length, 3);
  assert.deepEqual(result.value, { ...selections, own: { ...own, characterId: mapping.get(12) },
    targets: [{ ...own, characterId: mapping.get(12) }], originals: [{ ...own, characterId: mapping.get(12) }] });
});

for (const [kind, payload, paths] of [
  ['counterfeit_crown', { privateCharacter: own }, ['privateCharacter']],
  ['chaos_exchange', { character: { id: 12, name: 'Historical 12', rank: 12 } }, ['character']],
  ['chronicle_of_return', { character: { id: 12, name: 'Historical 12', rank: 12 } }, ['character']],
  ['heart_for_a_heart', { originals: [own], targets: [own] }, ['originals', 'targets']],
  ['severed_fate', { originals: [own], targets: [own] }, ['originals', 'targets']],
  ['grand_masquerade', { originals: [own], targets: [own], assignment: [0, 1, 2, 3] }, ['originals', 'targets']],
  ['hostage_note', { choice: 'gamble', loser: own, characters: [own, own] }, ['loser', 'characters']],
  ['hostage_note', { choice: 'exchange', loser: null, characters: [own, own] }, ['characters']],
]) test(`${kind} durable result maps only its reviewed paths (${payload.choice ?? 'result'})`, () => {
  const message = 'Old ID 12, rank 12 https://anilist.co/character/12';
  const result = adapt('item_actions', 'result_json', { status: 'resolved', message, ...payload }, { kind });
  assert.equal(result.value.message, message);
  for (const path of paths) {
    const values = Array.isArray(result.value[path]) ? result.value[path] : [result.value[path]];
    for (const value of values) {
      assert.equal(value.characterId ?? value.id, mapping.get(12));
      assert.equal(value.rank, 12);
      assert.equal(value.name, 'Historical 12');
      if ('marriageId' in value) assert.equal(value.marriageId, 12);
    }
  }
  if (payload.assignment) assert.deepEqual(result.value.assignment, payload.assignment);
});

test('Chronicle selection maps only its stable target identity, never the loss timestamp', () => {
  const target = { characterId: 12, name: 'Historical 12', rank: 12, lostAt: 12 };
  const result = adapt('item_actions', 'selections_json', { returnTarget: target, historyWindowMs: 12 }, { kind: 'chronicle_of_return' });
  assert.deepEqual(result.value, { returnTarget: { ...target, characterId: mapping.get(12) }, historyWindowMs: 12 });
  assert.throws(() => adapt('item_actions', 'selections_json', { returnTarget: target }, { kind: 'alchemist' }));
});

test('noncharacter result variants and snake-case crown history', () => {
  for (const [kind, value] of [
    ['alchemist', { status: 'resolved', rewardId: '12', message: 'Created 12' }],
    ['kaimetsu', { status: 'resolved', kind: 'kaimetsu', actorId: '12', totalDivorced: 12, affectedOwners: 12, noCost: true }],
    ['hostage_note', { status: 'canceled', message: 'Note restored.' }],
    ['severed_fate', { status: 'resolved', blocked: true, message: 'Mirror Shield shattered.' }],
    ['counterfeit_crown', { status: 'expired', message: 'No cost.' }],
  ]) assert.equal(adapt('item_actions', 'result_json', value, { kind }).references.length, 0);
  const crown = { guild_id: '12', user_id: '12', character_id: 12, marriage_id: 12, generation_id: '12' };
  assert.deepEqual(adapt('item_actions', 'crown_json', [crown], { kind: 'hostage_note' }).value,
    [{ ...crown, character_id: mapping.get(12) }]);
  assert.deepEqual(adapt('item_actions', 'crown_json', [], { kind: 'hostage_note' }).value, []);
});

test('inventory escrow snapshot_json contains no character IDs; inventory id is unchanged', () => {
  const snapshot = { id: 12, guild_id: '12', user_id: '12', item_id: 'hostage_note', charges: 12, acquired_at: 'date' };
  assert.deepEqual(adapt('item_action_costs', 'snapshot_json', snapshot).value, snapshot);
});

test('buff snapshots preserve numeric franchise, thresholds, rules and historical franchise name', () => {
  for (const [buff_id, value] of [
    ['franchise_passport', { franchiseId: 12, name: 'Old franchise 12', rolls: 12, startingCharges: 1, rewardEligible: true }],
    ['four_leaf_clover', { rolls: 12, minFavourites: 12, maxRank: 12 }],
    ['pinata_claim_token', { rolls: 12, minFavourites: 12, maxRank: 12, claimTokens: 12 }],
    ['rolling_fever', { rolls: 12, favouritesThreshold: 12, refundRolls: 12 }],
    ['adrenaline_rush', { durationMs: 12, allowanceMultiplier: 12 }],
    ['engagement_ring', { claims: 12, cooldownMultiplier: 0.5 }],
    ['double_date', { durationMs: 12 }],
    ['crown_of_the_sovereign', { claimTokens: 12 }],
  ]) assert.deepEqual(adapt('active_user_buffs', 'data_json', value, { buff_id }).value, value);
});

test('all built-in mystery states preserve anime/puzzle/user IDs and captured terms', () => {
  for (const [event_id, state] of [
    ['doors', { status: 'closed', rollerId: '12', winningDoor: 2, deadlineAt: 12 }],
    ['treasure_hunt', { status: 'closed', puzzleId: '12', startedAt: 12, deadlineAt: 24, clueIndex: 2 }],
    ['clue_reveal', { animeId: 12, title: 'Historical 12', aliases: ['12'], clues: ['Year: 2012'], stage: 2, startedAt: 12, guessedAtStage: { 12: 2 } }],
    ['deadlock', { phase: 'finished', round: 3, startedAt: 12, players: { 12: { score: 12 } }, choices: { 12: '3' } }],
    ['greed_chamber', { phase: 'finished', round: 5, startedAt: 12, players: { 12: { score: 0, banked: 12, status: 'escaped' } }, choices: { 12: 'stay' } }],
  ]) {
    const value = { ...state, rules: { durationMs: 12 }, gameConfig: { mystery: { winnerDelayMs: 12 } } };
    assert.deepEqual(adapt('mystery_sessions', 'state_json', value, { event_id }).value, value);
    assert.equal(adapt('mystery_sessions', 'state_json', { gameConfig: {} }, { event_id }).references.length, 0);
  }
});

for (const [table, column, value, context] of [
  ['item_actions', 'result_json', { character: { id: 12 } }, { kind: 'counterfeit_crown' }],
  ['item_actions', 'selections_json', { own: { ...own, future: { id: 12 } } }, { kind: 'hostage_note' }],
  ['item_actions', 'selections_json', { _rules: { characterId: 12 } }, { kind: 'hostage_note' }],
  ['item_actions', 'selections_json', {}, { kind: 'unknown' }],
  ['active_user_buffs', 'data_json', { franchiseId: 12 }, { buff_id: 'unknown' }],
  ['active_user_buffs', 'data_json', { characterId: 12 }, { buff_id: 'franchise_passport' }],
  ['mystery_sessions', 'state_json', { character: { id: 12 } }, { event_id: 'doors' }],
  ['mystery_sessions', 'state_json', { players: [] }, { event_id: 'deadlock' }],
  ['mystery_sessions', 'state_json', { animeId: 12 }, { event_id: 'unknown' }],
  ['item_action_costs', 'snapshot_json', { id: 12, item_id: 'hostage_note', characterId: 12 }, {}],
]) test(`unknown shape fails closed: ${table}.${column} ${JSON.stringify(value)}`, () => {
  assert.throws(() => adapt(table, column, value, context), new RegExp(`${table}\\[fixture\\]\\.${column}`));
});

test('published mystery terms migrate only their identity and preserve historical provenance', () => {
  const characterSnapshot = captureCharacterSnapshot({ id: 12, name_full: 'Historical', rank: 7,
    favourites: 123, likes_source: 'generated', anime_titles: '["Old show"]' });
  const value = { gameConfig: {}, characterSnapshot };
  const result = adapt('mystery_sessions', 'state_json', value, { event_id: 'doors', character_id: 12 });
  assert.deepEqual(result.value.characterSnapshot, { ...characterSnapshot, id: mapping.get(12) });
  assert.equal(result.references[0].id, 12);
  assert.throws(() => adapt('mystery_sessions', 'state_json', value, { event_id: 'doors', character_id: 99 }), /snapshot\/session identity mismatch/);
  for (const invalid of [null, { ...characterSnapshot, version: 999 }, { ...characterSnapshot, future: 12 },
    { ...characterSnapshot, favourites: -1 }, { ...characterSnapshot, likes_source: 'unknown' }]) {
    assert.throws(() => adapt('mystery_sessions', 'state_json', { characterSnapshot: invalid }, { event_id: 'doors' }), /invalid published character snapshot/);
  }
});

test('malformed, invalid and unmapped references include row/path diagnostics', () => {
  assert.throws(() => adaptCharacterSnapshot('item_actions', 'selections_json', { id: 'broken', kind: 'hostage_note', selections_json: '{' }), /item_actions\[broken\].*Invalid JSON/);
  for (const id of [0, -1, 1.5, '12', null]) assert.throws(() => adapt('item_actions', 'selections_json', { own: { ...own, characterId: id } }, { kind: 'hostage_note' }), /own.characterId.*invalid legacy/);
  assert.throws(() => adapt('item_actions', 'selections_json', { own: { ...own, characterId: 404 } }, { kind: 'hostage_note' }), /own.characterId.*Unresolved reference 404/);
});
