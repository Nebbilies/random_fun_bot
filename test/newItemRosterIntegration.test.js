import test from 'node:test';
import assert from 'node:assert/strict';
import { openCatalog } from '../lib/catalogDb.js';
import { getGameConfig, getConfigView, saveConfigSection } from '../lib/gameConfig.js';
import { getItemDefinition, getRewardItemsInTier } from '../lib/itemRoster.js';
import { addItemToInventory, getUsableInventory, decrementItemCharge } from '../lib/itemStorage.js';
import { getDiscoveredItemIds } from '../lib/itemDiscovery.js';

for (const [id, name, tier, days] of [
  ['shackles_of_liberation', 'Shackles of Liberation', 'legendary', 14],
  ['cupids_misfire', "Cupid's Misfire", 'rare', 4],
]) {
  test(`${id} integrates with config, rewards, expiry and permanent scoped discovery`, t => {
    const db = openCatalog(':memory:');
    t.after(() => db.close());
    const definition = getItemDefinition(id);
    assert.equal(definition.name, name);
    assert.equal(definition.tier, tier);
    assert.equal(definition.maxCharges, 1);
    assert.deepEqual(getGameConfig(db, 'guild').items[id], { rewardEligible: true, startingCharges: 1 });
    assert.ok(getRewardItemsInTier(db, 'guild', tier).some(item => item.id === id));
    const acquired = addItemToInventory(db, 'guild', 'player', id, 1, { now: 1000 });
    assert.equal(acquired.item.expires_at, 1000 + days * 86400000);
    assert.ok(getUsableInventory(db, 'guild', 'player', 1001).some(item => item.item_id === id));
    decrementItemCharge(db, acquired.item.id);
    assert.ok(getDiscoveredItemIds(db, 'guild').has(id));
    assert.ok(!getDiscoveredItemIds(db, 'other').has(id));
    saveConfigSection(db, { guildId: '123', section: 'items',
      values: { [`items.${id}.rewardEligible`]: false }, expectedRevision: getConfigView(db, '123').revision });
    assert.ok(!getRewardItemsInTier(db, '123', tier).some(item => item.id === id));
  });
}
