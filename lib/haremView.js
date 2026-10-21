import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, escapeMarkdown,
  SectionBuilder, ThumbnailBuilder, TextDisplayBuilder } from 'discord.js';
import { formatNumber } from './formatNumber.js';

/**
 * Shared rendering for the "harem" list of a player.
 *
 * The list view is used by `!mm` and by the trade and gift flows, which show a
 * player their own characters before they pick one to offer.
 */

export const HArem_PAGE_SIZE = 20;

/** @param {import('discord.js').MessageActionRowComponentBuilder[]} components */
function actionRow(...components) {
  return /** @type {ActionRowBuilder<import('discord.js').MessageActionRowComponentBuilder>} */ (
    new ActionRowBuilder().addComponents(components));
}

function short(value, length = 150) {
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

/**
 * @param {any[]} rows
 * @returns {number}
 */
export function haremPageCount(rows) {
  return Math.max(1, Math.ceil(rows.length / HArem_PAGE_SIZE));
}

/**
 * Builds the Components V2 container that lists a player's characters.
 * @param {any[]} rows marriage rows, already sorted
 * @param {string} targetId owner of the listed characters
 * @param {'time' | 'rank'} [sort]
 * @param {number} [page]
 * @param {{disabled?: boolean, notice?: string | null, title?: string, prevId?: string, nextId?: string}} [options]
 */
export function haremListComponents(rows, targetId, sort = 'time', page = 0, options = {}) {
  const {
    disabled = false,
    notice = null,
    title = `## <@${targetId}>'s harem`,
    prevId = 'mm:prev',
    nextId = 'mm:next',
  } = options;
  const pages = haremPageCount(rows);
  const start = page * HArem_PAGE_SIZE;
  const lines = rows.slice(start, start + HArem_PAGE_SIZE).map((row) => {
    const name = escapeMarkdown(short(row.name_full || `Character ${row.characterId}`));
    return sort === 'rank' ? `**#${formatNumber(row.rank)}** - ${name}` : name;
  });
  const titleDisplay = new TextDisplayBuilder().setContent(title);
  const listDisplay = new TextDisplayBuilder()
    .setContent(lines.length ? lines.join('\n') : 'No marriages yet.');
  const pageDisplay = new TextDisplayBuilder().setContent(`Page ${page + 1} of ${pages}`);
  const top = rows.reduce((best, row) => !best || row.rank < best.rank ? row : best, null);
  const container = new ContainerBuilder().setAccentColor(0x5865f2);
  // A notice lives outside the section: a section holds at most three text displays.
  if (notice) container.addTextDisplayComponents(new TextDisplayBuilder().setContent(notice));
  if (top?.image_url) {
    container.addSectionComponents(new SectionBuilder()
      .addTextDisplayComponents(titleDisplay, listDisplay, pageDisplay)
      .setThumbnailAccessory(new ThumbnailBuilder().setURL(top.image_url)));
  } else container.addTextDisplayComponents(titleDisplay, listDisplay, pageDisplay);
  if (pages > 1) {
    container.addActionRowComponents(actionRow(
      new ButtonBuilder().setCustomId(prevId).setLabel('Previous')
        .setStyle(ButtonStyle.Secondary).setDisabled(disabled || page === 0),
      new ButtonBuilder().setCustomId(nextId).setLabel('Next')
        .setStyle(ButtonStyle.Secondary).setDisabled(disabled || page === pages - 1),
    ));
  }
  return [container];
}
