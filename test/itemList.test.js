import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { ComponentType, MessageFlags, escapeMarkdown } from 'discord.js';
import { openCatalog } from '../lib/catalogDb.js';
import { getConfigView, saveConfigSection } from '../lib/gameConfig.js';
import { addItemToInventory } from '../lib/itemStorage.js';
import { ITEM_ROSTER, getResolvedItemDefinition } from '../lib/itemRoster.js';
import { guildItemList, itemListPages, itemListComponents } from '../lib/itemList.js';
import { run } from '../commands/itemlist.js';
import { run as alias } from '../commands/il.js';

function fixture(t) {
  const db = openCatalog(':memory:');
  t.after(() => db.close());
  return db;
}

test('guild list conceals unknown names and descriptions and uses effective discovered definitions', t => {
  const db = fixture(t);
  assert.equal(guildItemList(db, '123').length, ITEM_ROSTER.length);
  assert.ok(guildItemList(db, '123').slice(0, -1).every(line => line === '• **???** - ???'));
  saveConfigSection(db, { guildId: '123', section: 'items',
    values: { 'items.hourglass_of_haste.rewardEligible': false }, expectedRevision: getConfigView(db, '123').revision });
  addItemToInventory(db, '123', 'u', 'hourglass_of_haste');
  const item = getResolvedItemDefinition(db, '123', 'hourglass_of_haste');
  assert.ok(guildItemList(db, '123').includes(`• **${escapeMarkdown(item.name)}** - ${escapeMarkdown(item.description)}`));
  assert.ok(guildItemList(db, 'other').slice(0, -1).every(line => line === '• **???** - ???'));
  for (const tier of ['common', 'rare', 'epic', 'legendary', '???']) {
    assert.equal(guildItemList(db, '123', tier).length, ITEM_ROSTER.filter(item => item.tier === tier).length);
  }
});

test('known items sort by tier then name', t => {
  const db = fixture(t);
  for (const [i, item] of ITEM_ROSTER.entries()) addItemToInventory(db, '123', `u${i}`, item.id);
  const tiers = ['common', 'rare', 'epic', 'legendary', '???'];
  const sorted = [...ITEM_ROSTER].sort((a, b) => tiers.indexOf(a.tier) - tiers.indexOf(b.tier) || a.name.localeCompare(b.name, 'en'));
  assert.deepEqual(guildItemList(db, '123').map(line => line.split('**')[1]), sorted.map(item => escapeMarkdown(item.name)));
});

test('pagination bounds row count and text length and supports empty filters', () => {
  assert.equal(itemListPages(Array(21).fill('• **???** - ???')).length, 3);
  assert.equal(itemListPages(Array(4).fill('x'.repeat(1200))).length, 2);
  const card = itemListComponents(itemListPages([]), 0, 'all')[0].toJSON();
  assert.equal(card.type, ComponentType.Container);
  assert.equal(card.components[2].content, 'No items in this category.');
});

test('catalog and release announcement share Discord message-wide text budget', () => {
  const changelog = 'Release '.repeat(300);
  const pages = itemListPages([...Array(20).fill('x'.repeat(349)), 'long description '.repeat(400)], 3800 - changelog.length);
  for (let page = 0; page < pages.length; page++) {
    const card = itemListComponents(pages, page, 'all', false, changelog)[0].toJSON();
    const total = card.components.reduce((sum, component) => sum + (component.content?.length ?? 0), 0);
    assert.ok(total <= 4000, `combined text ${total}`);
  }
});

test('release announcement remains visible on filtered and disabled catalog pages', () => {
  const changelog = '**Changelog 28/10/2026**: Added **two** new *Rare* items: **???** and **???**.';
  for (const disabled of [false, true]) {
    const card = itemListComponents(itemListPages([]), 0, 'common', disabled, changelog)[0].toJSON();
    assert.ok(card.components.some(component => component.content === changelog));
  }
});

test('alias, shared select, page reset, refreshed discovery, and expiration', async t => {
  assert.equal(alias, run);
  const db = fixture(t);
  const collector = new EventEmitter();
  let payload;
  let options;
  const sent = { edit: async value => { payload = value; },
    createMessageComponentCollector: value => { options = value; return collector; } };
  await run({ yoshiko: { catalogDb: db }, message: { guildId: '123', author: { id: 'author' },
    reply: async value => { payload = value; return sent; } } });
  assert.equal(payload.flags, MessageFlags.IsComponentsV2);
  assert.deepEqual(payload.allowedMentions.parse, []);
  assert.equal(typeof options.time, 'number');
  const card = () => payload.components[0].toJSON();
  assert.ok(card().components.some(component => component.content?.includes('**Changelog 28/10/2026**')));
  const collect = async (customId, values) => collector.listeners('collect')[0]({
    customId, values, user: { id: 'someone-else' }, deferUpdate: async () => {},
  });
  await collect('itemlist:next');
  assert.match(card().components[3].content, /Page 2/);
  await collect('itemlist:tier', ['common']);
  assert.match(card().components[3].content, /Page 1 of 1/);
  assert.equal(card().components[2].content.split('\n').length, 3);
  assert.equal(card().components[1].components[0].options.find(option => option.default).value, 'common');
  addItemToInventory(db, '123', 'u', 'hourglass_of_haste');
  await collect('itemlist:tier', ['common']);
  assert.match(card().components[2].content, /Hourglass of Haste/);
  await collect('itemlist:tier', ['invalid']);
  assert.equal(card().components[1].components[0].options.find(option => option.default).value, 'common');
  await collect('itemlist:tier', ['all']);
  collector.emit('end');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(card().components[1].components[0].disabled, true);
  assert.ok(card().components.find(component => component.type === ComponentType.ActionRow && component.components[0]?.custom_id === 'itemlist:prev').components.every(button => button.disabled));
  await collect('itemlist:next');
  assert.match(card().components[3].content, /Page 1/);
});
