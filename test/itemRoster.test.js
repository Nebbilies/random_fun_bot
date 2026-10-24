import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ITEM_TIERS,
  ITEM_ROSTER,
  getItemDefinition,
  rollVaultOutcome,
} from '../lib/itemRoster.js';

test('item tiers have expected rates and colors', () => {
  assert.equal(ITEM_TIERS.common.chance, 0.599);
  assert.equal(ITEM_TIERS.common.color, 0x2ecc71);

  assert.equal(ITEM_TIERS.rare.chance, 0.20);
  assert.equal(ITEM_TIERS.rare.color, 0x3498db);

  assert.equal(ITEM_TIERS.epic.chance, 0.15);
  assert.equal(ITEM_TIERS.epic.color, 0x9b59b6);

  assert.equal(ITEM_TIERS.legendary.chance, 0.05);
  assert.equal(ITEM_TIERS.legendary.color, 0xf1c40f);
  assert.deepEqual(ITEM_TIERS['???'], { id: '???', name: '???', chance: 0.001, color: 0, emoji: '⚫' });
});

test('every item in the approved roster has valid tier and properties', () => {
  const expectedItems = [
    // Common
    'hourglass_of_haste', 'four_leaf_clover', 'binoculars',
    // Rare
    'love_letter', 'golden_whistle', 'sirens_call', 'rolling_fever', 'adrenaline_rush', 'pinata', 'engagement_ring',
    // Epic
    'pickpockets_hook', 'mirror_shield', 'bag_of_holding', 'double_date', 'franchise_passport', 'golden_hour', 'blood_pact',
    // Legendary
    'master_key', 'wish_upon_a_star', 'aegis_of_fidelity', 'crown_of_the_sovereign',
    // ???
    'kaimetsu',
  ];

  for (const id of expectedItems) {
    const item = getItemDefinition(id);
    assert.ok(item, `Item ${id} should exist`);
    assert.ok(item.name, `Item ${id} should have a display name`);
    assert.ok(item.description, `Item ${id} should have a description`);
    assert.ok(Object.hasOwn(ITEM_TIERS, item.tier), `Item ${id} tier is invalid`);
  }
});

test('rollVaultOutcome picks tier and item according to random draws', () => {
  // Test common roll: 0.0 -> common
  const commonOutcome = rollVaultOutcome(() => 0.1, () => 0.0);
  assert.equal(commonOutcome.tier, 'common');
  assert.ok(commonOutcome.item);

  // Test rare roll: 0.65 -> rare (0.599 to 0.799)
  const rareOutcome = rollVaultOutcome(() => 0.65, () => 0.0);
  assert.equal(rareOutcome.tier, 'rare');

  // Test epic roll: 0.85 -> epic (0.799 to 0.949)
  const epicOutcome = rollVaultOutcome(() => 0.85, () => 0.0);
  assert.equal(epicOutcome.tier, 'epic');

  // Test legendary roll: 0.98 -> legendary (0.949 to 0.999)
  const legOutcome = rollVaultOutcome(() => 0.98, () => 0.0);
  assert.equal(legOutcome.tier, 'legendary');
});
