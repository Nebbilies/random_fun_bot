import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder,
  escapeMarkdown, StringSelectMenuBuilder, TextDisplayBuilder,
} from 'discord.js';
import { ITEM_TIERS, getResolvedItemDefinitions } from './itemRoster.js';
import { getDiscoveredItemIds, maskUndiscoveredItem } from './itemDiscovery.js';

export const ITEM_LIST_PAGE_SIZE = 10;
const tiers = Object.keys(ITEM_TIERS);
export const ITEM_LIST_FILTERS = ['all', ...tiers];

export function guildItemList(db, guildId, filter = 'all') {
  const discovered = getDiscoveredItemIds(db, guildId);
  return getResolvedItemDefinitions(db, guildId)
    .filter(item => filter === 'all' || item.tier === filter)
    .sort((a, b) => tiers.indexOf(a.tier) - tiers.indexOf(b.tier) || a.name.localeCompare(b.name, 'en'))
    .map(item => discovered.has(item.id) ? item : maskUndiscoveredItem(item))
    .map(item => `• **${escapeMarkdown(item.name)}** - ${escapeMarkdown(item.description).replace(/\s*\n\s*/g, ' ')}`);
}

// Bound both row count and text size so configuration/catalog growth cannot
// exceed Discord's text-display or total message content limits.
export function itemListPages(lines) {
  const pages = [[]];
  for (const line of lines) {
    const page = pages.at(-1);
    if (page.length && (page.length >= ITEM_LIST_PAGE_SIZE || [...page, line].join('\n').length > 3500)) {
      pages.push([]);
    }
    pages.at(-1).push(line);
  }
  return pages;
}

export function itemListComponents(pages, page, filter, disabled = false) {
  const container = new ContainerBuilder().setAccentColor(ITEM_TIERS[filter]?.color ?? 0x3498db)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent('## Guild item list'))
    .addActionRowComponents(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId('itemlist:tier').setPlaceholder('Choose an item rarity')
        .setDisabled(disabled).addOptions(ITEM_LIST_FILTERS.map(value => ({
          label: value === 'all' ? 'All items' : ITEM_TIERS[value].name,
          value, default: value === filter,
        }))),
    ))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      pages[page].join('\n') || 'No items in this category.'))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`Page ${page + 1} of ${pages.length}`));
  if (pages.length > 1) container.addActionRowComponents(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('itemlist:prev').setLabel('Previous').setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled || page === 0),
    new ButtonBuilder().setCustomId('itemlist:next').setLabel('Next').setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled || page === pages.length - 1),
  ));
  return [container];
}
