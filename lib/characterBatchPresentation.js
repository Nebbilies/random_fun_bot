import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, escapeMarkdown,
  StringSelectMenuBuilder, TextDisplayBuilder } from 'discord.js';
import { formatNumber } from './formatNumber.js';
import { CHARACTER_BATCH_LIMIT } from './characterBatchSelection.js';

export const CHARACTER_PICKER_PAGE_SIZE = 25;
export const CHARACTER_BATCH_INSTRUCTIONS = `Separate names with \`$\` (up to ${CHARACTER_BATCH_LIMIT}).`;

/** @param {string} value @param {number} max */
function shorten(value, max) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** @param {string} query */
export function displayCharacterQuery(query) {
  return escapeMarkdown(shorten(query, 100));
}

/** @param {{name: string, rank: number}} row */
export function characterBatchLine({ name, rank }) {
  return `#${formatNumber(rank)} • **${escapeMarkdown(shorten(name, 75))}**`;
}

/** @param {import('discord.js').MessageActionRowComponentBuilder[]} components */
export function characterActionRow(...components) {
  return /** @type {ActionRowBuilder<import('discord.js').MessageActionRowComponentBuilder>} */ (
    new ActionRowBuilder().addComponents(components));
}

/** @param {import('./characterMarriage.js').MarriageRow[]} matches @param {number} page */
export function characterPickerPage(matches, page) {
  return matches.slice(page * CHARACTER_PICKER_PAGE_SIZE, (page + 1) * CHARACTER_PICKER_PAGE_SIZE);
}

/** @param {{matches: import('./characterMarriage.js').MarriageRow[], page: number, title: string,
 * detail: string, chooseId: string, previousId: string, nextId: string, disabled?: boolean}} input */
export function characterPickerComponents({ matches, page, title, detail, chooseId, previousId, nextId, disabled = false }) {
  const pages = Math.ceil(matches.length / CHARACTER_PICKER_PAGE_SIZE);
  const options = characterPickerPage(matches, page).map(row => ({
    label: shorten(`#${formatNumber(row.rank)} • ${row.name_full || `Character ${row.characterId}`}`, 100),
    value: String(row.characterId),
  }));
  const container = new ContainerBuilder().setAccentColor(0x5865f2)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `## ${title}\n${detail}${pages > 1 ? `\nPage ${page + 1} of ${pages}` : ''}`,
    ))
    .addActionRowComponents(characterActionRow(new StringSelectMenuBuilder().setCustomId(chooseId)
      .setPlaceholder('Select a character').setDisabled(disabled).addOptions(options)));
  if (pages > 1) {
    container.addActionRowComponents(characterActionRow(
      new ButtonBuilder().setCustomId(previousId).setLabel('Previous').setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled || page === 0),
      new ButtonBuilder().setCustomId(nextId).setLabel('Next').setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled || page === pages - 1),
    ));
  }
  return [container];
}
