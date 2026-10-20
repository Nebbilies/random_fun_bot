import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openCatalog } from '../lib/catalogDb.js';
import {
  renderInventoryEmbed,
  renderInventoryComponents,
  renderInventoryHelpEmbed,
  run as invCommand,
} from '../commands/inv.js';
import { executeItemUse } from '../commands/use.js';
import { addItemToInventory, getInventory } from '../lib/itemStorage.js';

test('renderInventoryEmbed displays slots, items, active buffs, and footer helper', () => {
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
  assert.ok(embed.data.footer.text.includes('!use <item> [args]'));
  assert.ok(embed.data.footer.text.includes('!inv help'));

  const components = renderInventoryComponents(db, guildId, userId);
  assert.ok(components.length > 0);
});

test('renderInventoryHelpEmbed shows empty message when user has no items', () => {
  const db = openCatalog(':memory:');
  const guildId = '1001';
  const userId = '3001';

  const embed = renderInventoryHelpEmbed(db, guildId, userId, 'EmptyUser');
  assert.ok(embed.data.description.includes('Your inventory is empty'));
});

test('renderInventoryHelpEmbed helps ONLY existing items in user inventory', () => {
  const db = openCatalog(':memory:');
  const guildId = '1001';
  const userId = '3001';

  // Add only Franchise Passport and Golden Whistle
  addItemToInventory(db, guildId, userId, 'franchise_passport', 1);
  addItemToInventory(db, guildId, userId, 'golden_whistle', 3);

  const embed = renderInventoryHelpEmbed(db, guildId, userId, 'PassportUser');
  const desc = embed.data.description;

  // Should include help for Franchise Passport
  assert.ok(desc.includes('Franchise Passport'));
  assert.ok(desc.includes('!use passport <franchise name>'));

  // Should include help for Golden Whistle
  assert.ok(desc.includes('Golden Whistle'));
  assert.ok(desc.includes('Passive item'));

  // Should NOT include items not in user inventory
  assert.ok(!desc.includes('Hourglass of Haste'));
  assert.ok(!desc.includes('Pickpocket'));
  assert.ok(!desc.includes('Master Key'));
  assert.ok(!desc.includes('Blood Pact'));
});

test('!inv help command runs and replies with help embed', async () => {
  const db = openCatalog(':memory:');
  const guildId = '1001';
  const userId = '3001';

  addItemToInventory(db, guildId, userId, 'pickpockets_hook', 1);

  let replyPayload;
  const ctx = {
    args: ['inv', 'help'],
    message: {
      guildId,
      author: { id: userId, username: 'ThiefUser' },
      reply: async (payload) => { replyPayload = payload; },
    },
    yoshiko: { catalogDb: db },
  };

  await invCommand(ctx);
  assert.ok(replyPayload?.embeds?.[0]);
  const helpEmbed = replyPayload.embeds[0];
  assert.ok(helpEmbed.data.description.includes("Pickpocket's Hook"));
  assert.ok(helpEmbed.data.description.includes('!use hook @user'));
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
