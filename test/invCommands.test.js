import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openCatalog } from '../lib/catalogDb.js';
import { renderInventoryEmbed, renderInventoryComponents } from '../commands/inv.js';
import { executeItemUse } from '../commands/use.js';
import { addItemToInventory, getInventory } from '../lib/itemStorage.js';

test('renderInventoryEmbed displays slots, items, and active buffs', () => {
  const db = openCatalog(':memory:');
  const guildId = '1001';
  const userId = '3001';

  addItemToInventory(db, guildId, userId, 'hourglass_of_haste', 1);
  addItemToInventory(db, guildId, userId, 'golden_whistle', 3);

  const embed = renderInventoryEmbed(db, guildId, userId, 'TestUser');
  assert.ok(embed.data.title.includes('TestUser'));
  assert.ok(embed.data.title.includes('[2/5]'));
  assert.ok(embed.data.fields.some((f) => f.name.includes('Hourglass of Haste')));
  assert.ok(embed.data.fields.some((f) => f.name.includes('Golden Whistle (3 charges)')));

  const components = renderInventoryComponents(db, guildId, userId);
  assert.ok(components.length > 0);
});

test('executeItemUse finds item, applies effect, and consumes charge', () => {
  const db = openCatalog(':memory:');
  const guildId = '1001';
  const userId = '3001';

  addItemToInventory(db, guildId, userId, 'love_letter', 1);
  db.prepare('INSERT INTO claim_allowances (guild_id, user_id, period) VALUES (?, ?, 10)').run(guildId, userId);

  const res = executeItemUse(db, guildId, userId, 'love_letter', []);
  assert.equal(res.success, true);
  assert.ok(res.message.includes('marriage claim cooldown'));

  // Item should be consumed
  assert.equal(getInventory(db, guildId, userId).length, 0);
});
