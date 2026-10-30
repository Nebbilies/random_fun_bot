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
import { getConfigView, saveConfigSection } from '../lib/gameConfig.js';

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

test('inventory renderers share a controlled clock for lifetime, slots, help and buttons', t => {
  const db = openCatalog(':memory:');
  t.after(() => db.close());
  const now = Date.now();
  const acquired = addItemToInventory(db, '1001', '3001', 'golden_whistle', 3, { now });
  addItemToInventory(db, '1001', '3001', 'hourglass_of_haste', 1, { now });
  // Rare entries last four days; common entries expire after two.
  const renderAt = now + 115_200_000;
  const embed = renderInventoryEmbed(db, '1001', '3001', 'TestUser', renderAt, false);
  assert.ok(embed.data.fields.some(field => field.name.endsWith('Golden Whistle (3 charges) (2d 16h)')));
  const boundary = now + 172_800_000;
  const expired = renderInventoryEmbed(db, '1001', '3001', 'TestUser', boundary);
  assert.match(expired.data.title, /\[1\/5\]/);
  assert.ok(expired.data.fields.every(field => !field.name.includes('Hourglass')));
  assert.deepEqual(renderInventoryComponents(db, '1001', '3001', boundary), []);
  assert.doesNotMatch(renderInventoryHelpEmbed(db, '1001', '3001', 'TestUser', true, boundary).data.description, /Hourglass/);
  assert.equal(getInventory(db, '1001', '3001', now)[0].expires_at, now + 172_800_000);
  assert.equal(acquired.status, 'added');
});

test('lifetime configuration edits leave owned inventory countdowns unchanged', t => {
  const db = openCatalog(':memory:');
  t.after(() => db.close());
  const now = Date.now();
  addItemToInventory(db, '1001', '3001', 'hourglass_of_haste', 1, { now });
  const before = renderInventoryEmbed(db, '1001', '3001', 'TestUser', now).data.fields[0].name;
  saveConfigSection(db, { guildId: '1001', section: 'itemExpiryDays',
    values: { 'itemExpiryDays.common': 365 }, expectedRevision: getConfigView(db, '1001').revision });
  assert.equal(renderInventoryEmbed(db, '1001', '3001', 'TestUser', now).data.fields[0].name, before);
  assert.match(before, /\(2d\)$/);
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
    prefix: '!',
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

test('!inv @user displays target user inventory without use buttons', async () => {
  const db = openCatalog(':memory:');
  const guildId = '1001';
  const authorId = '3001';
  const targetId = '4002';

  addItemToInventory(db, guildId, targetId, 'bag_of_holding', 1);

  let replyPayload;
  const ctx = {
    args: ['inv', `<@${targetId}>`],
    prefix: '!',
    message: {
      guildId,
      author: { id: authorId, username: 'Viewer' },
      mentions: {
        users: new Map([[targetId, { id: targetId, username: 'TargetUser' }]]),
      },
      reply: async (payload) => { replyPayload = payload; },
    },
    yoshiko: { catalogDb: db },
  };

  await invCommand(ctx);
  assert.ok(replyPayload?.embeds?.[0]);
  assert.ok(replyPayload.embeds[0].data.title.includes('TargetUser'));
  assert.ok(replyPayload.embeds[0].data.fields.some((f) => f.name.includes('Bag of Holding')));
  assert.equal(replyPayload.components.length, 0); // No action buttons for other user's inventory
});

test('!inv help @user displays target user item help', async () => {
  const db = openCatalog(':memory:');
  const guildId = '1001';
  const authorId = '3001';
  const targetId = '4002';

  addItemToInventory(db, guildId, targetId, 'franchise_passport', 1);

  let replyPayload;
  const ctx = {
    args: ['inv', 'help', `<@${targetId}>`],
    prefix: '!',
    message: {
      guildId,
      author: { id: authorId, username: 'Viewer' },
      mentions: {
        users: new Map([[targetId, { id: targetId, username: 'TargetUser' }]]),
      },
      reply: async (payload) => { replyPayload = payload; },
    },
    yoshiko: { catalogDb: db },
  };

  await invCommand(ctx);
  assert.ok(replyPayload?.embeds?.[0]);
  assert.ok(replyPayload.embeds[0].data.title.includes('TargetUser'));
  assert.ok(replyPayload.embeds[0].data.description.includes('Franchise Passport'));
  assert.ok(replyPayload.embeds[0].data.description.includes(`<@${targetId}>'s inventory`));
});

test('!inv with invalid argument replies with usage', async () => {
  let replyText;
  const ctx = {
    args: ['inv', 'invalid_arg'],
    prefix: '!',
    message: {
      guildId: '1001',
      author: { id: '3001', username: 'Viewer' },
      reply: async (msg) => { replyText = msg; },
    },
    yoshiko: { catalogDb: null },
  };

  await invCommand(ctx);
  assert.ok(replyText.includes('Usage: !inv [@user]'));
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
