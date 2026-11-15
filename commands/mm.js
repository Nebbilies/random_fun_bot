import { characterSeries } from '../lib/characterSeries.js';
import { getGameConfig } from '../lib/gameConfig.js';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder,
  escapeMarkdown, MediaGalleryBuilder, MediaGalleryItemBuilder, MessageFlags,
  SectionBuilder, ThumbnailBuilder, TextDisplayBuilder } from 'discord.js';
import { listMarriages, listMarriagesByFranchise } from '../lib/characterMarriage.js';
import { formatNumber } from '../lib/formatNumber.js';
import { HArem_PAGE_SIZE, haremListComponents } from '../lib/haremView.js';
import { resolveUserTarget } from '../lib/userTarget.js';

const PAGE_SIZE = HArem_PAGE_SIZE;


/** @param {import('discord.js').MessageActionRowComponentBuilder[]} components */
function actionRow(...components) {
  return /** @type {ActionRowBuilder<import('discord.js').MessageActionRowComponentBuilder>} */ (
    new ActionRowBuilder().addComponents(components));
}

function short(value, length = 150) {
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

/**
 * Parses a marriage command name to extract valid modifiers.
 * Base command is 'mm' or 'mymarry'.
 * Allowed modifier letters:
 * - 'r': sort by catalog rank
 * - 'a': franchise grouping
 * - 'i': individual card view (precedence over 'a')
 *
 * @param {string} commandName
 */
export function parseMarriageCommand(commandName) {
  const match = String(commandName ?? '').toLowerCase().match(/^(mm|mymarry)([a-z]*)$/);
  if (!match) return null;
  const base = match[1];
  const flagChars = match[2].split('');
  const flags = { rank: false, franchise: false, individual: false };
  for (const char of flagChars) {
    if (char === 'r') flags.rank = true;
    else if (char === 'a') flags.franchise = true;
    else if (char === 'i') flags.individual = true;
    else return { valid: false, invalidChar: char, base };
  }
  return {
    valid: true,
    base,
    flags,
    // 'i' takes precedence over 'a'
    view: flags.individual ? 'individual' : (flags.franchise ? 'franchise' : 'list'),
    sort: flags.rank ? 'rank' : 'time',
  };
}

function franchisePageComponents(groups, rows, targetId, sort, page, disabled = false) {
  const totalCharacters = groups.reduce((sum, g) => sum + g.characters.length, 0);
  const pages = Math.max(1, Math.ceil(totalCharacters / PAGE_SIZE));

  if (totalCharacters === 0) {
    const displays = [
      new TextDisplayBuilder().setContent(`## <@${targetId}>'s harem`),
      new TextDisplayBuilder().setContent('No marriages yet.'),
      new TextDisplayBuilder().setContent('Page 1 of 1'),
    ];
    return [new ContainerBuilder().setAccentColor(0x5865f2).addTextDisplayComponents(...displays)];
  }

  const start = page * PAGE_SIZE;
  const end = start + PAGE_SIZE;

  const sections = [];
  let charCounter = 0;

  for (const group of groups) {
    const groupCount = group.characters.length;
    const groupStart = charCounter;
    const groupEnd = charCounter + groupCount;
    charCounter = groupEnd;

    // Check if this group overlaps with [start, end)
    if (groupEnd <= start || groupStart >= end) {
      continue;
    }

    const overlapStart = Math.max(start, groupStart);
    const overlapEnd = Math.min(end, groupEnd);

    const firstIndexInGroup = overlapStart - groupStart;
    const isContinued = firstIndexInGroup > 0;
    const heading = isContinued
      ? `**${escapeMarkdown(group.name)} (continued) - ${groupCount}**`
      : `**${escapeMarkdown(group.name)} - ${groupCount}**`;

    const slice = group.characters.slice(firstIndexInGroup, overlapEnd - groupStart);
    const lines = slice.map((row) => {
      const name = escapeMarkdown(short(row.name_full || `Character ${row.characterId}`));
      return sort === 'rank' ? `**#${formatNumber(row.rank)}** - ${name}` : name;
    });

    sections.push(`${heading}\n${lines.join('\n')}`);
  }

  const content = sections.length ? sections.join('\n\n') : 'No marriages yet.';
  const displays = [
    new TextDisplayBuilder().setContent(`## <@${targetId}>'s harem`),
    new TextDisplayBuilder().setContent(content),
    new TextDisplayBuilder().setContent(`Page ${page + 1} of ${pages}`),
  ];
  const top = rows.reduce((best, row) => !best || row.rank < best.rank ? row : best, null);
  const container = new ContainerBuilder().setAccentColor(0x5865f2);
  if (top?.image_url) {
    container.addSectionComponents(new SectionBuilder().addTextDisplayComponents(...displays)
      .setThumbnailAccessory(new ThumbnailBuilder().setURL(top.image_url)));
  } else container.addTextDisplayComponents(...displays);
  if (pages > 1) {
    container.addActionRowComponents(actionRow(
      new ButtonBuilder().setCustomId('mm:prev').setLabel('Previous')
        .setStyle(ButtonStyle.Secondary).setDisabled(disabled || page === 0),
      new ButtonBuilder().setCustomId('mm:next').setLabel('Next')
        .setStyle(ButtonStyle.Secondary).setDisabled(disabled || page === pages - 1),
    ));
  }
  return [container];
}

function individualCardComponents(rows, targetId, index, disabled = false) {
  const total = rows.length;
  if (total === 0) {
    const displays = [
      new TextDisplayBuilder().setContent(`## <@${targetId}>'s harem`),
      new TextDisplayBuilder().setContent('No marriages yet.'),
      new TextDisplayBuilder().setContent('Character 0 of 0'),
    ];
    return [new ContainerBuilder().setAccentColor(0x5865f2).addTextDisplayComponents(...displays)];
  }

  const row = rows[index];
  const title = escapeMarkdown(short(row.name_full || `Character ${row.characterId}`, 250));
  const heading = row.site_url?.startsWith('https://')
    ? `# [${title}](${row.site_url})`
    : `# ${title}`;

  const series = characterSeries(row, 'Unknown', short);
  const details = [
    `**${series.label}:** ${escapeMarkdown(series.text)}`,
    `**Rank:** #${formatNumber(row.rank)}`,
  ];
  const footer = `<@${targetId}>'s harem • Character ${index + 1} of ${total}`;

  const container = new ContainerBuilder().setAccentColor(0x5865f2)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(heading),
      new TextDisplayBuilder().setContent(details.join('\n')),
    );

  if (row.image_url) {
    container.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(
      new MediaGalleryItemBuilder().setURL(row.image_url).setDescription(row.name_full || `Character ${row.characterId}`),
    ));
  }

  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(footer));

  if (total > 1) {
    container.addActionRowComponents(actionRow(
      new ButtonBuilder().setCustomId('mm:prev').setLabel('Previous')
        .setStyle(ButtonStyle.Secondary).setDisabled(disabled || index === 0),
      new ButtonBuilder().setCustomId('mm:next').setLabel('Next')
        .setStyle(ButtonStyle.Secondary).setDisabled(disabled || index === total - 1),
    ));
  }
  return [container];
}

/**
 * @param {any} ctx
 * @param {'time' | 'rank' | { sort?: 'time' | 'rank', view?: 'list' | 'franchise' | 'individual' }} [options]
 */
export async function runMarriages(ctx, options = {}) {
  const token = ctx.args?.[1];
  const { targetId, valid } = resolveUserTarget(token, ctx.message.author.id, ctx.message);
  const commandName = ctx.args?.[0] ?? 'mm';
  const prefix = ctx.prefix ?? '!';

  const parsed = parseMarriageCommand(commandName);
  if (parsed && !parsed.valid) {
    await ctx.message.reply(`Unknown modifier "${parsed.invalidChar}". Valid modifiers: a (franchise), i (individual card), r (sort by rank).`);
    return;
  }

  if ((ctx.args && ctx.args.length > 2) || (token && !valid)) {
    await ctx.message.reply(`Usage: ${prefix}${commandName} [@user]`);
    return;
  }

  /** @type {'time' | 'rank'} */
  const sort = (typeof options === 'string' && (options === 'rank' || options === 'time'))
    ? options
    : (typeof options === 'object' && options.sort === 'rank' ? 'rank' : (parsed?.sort === 'rank' ? 'rank' : 'time'));

  const view = typeof options === 'object' && options.view
    ? options.view
    : (parsed?.view ?? 'list');

  const rows = listMarriages(ctx.yoshiko.catalogDb, ctx.message.guildId, targetId, sort);
  const groups = view === 'franchise'
    ? listMarriagesByFranchise(ctx.yoshiko.catalogDb, ctx.message.guildId, targetId, sort)
    : [];

  let page = 0;
  let maxPages = 1;
  if (view === 'individual') {
    maxPages = Math.max(1, rows.length);
  } else if (view === 'franchise') {
    const totalChars = groups.reduce((sum, g) => sum + g.characters.length, 0);
    maxPages = Math.max(1, Math.ceil(totalChars / PAGE_SIZE));
  } else {
    maxPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  }

  const render = (disabled = false) => {
    if (view === 'individual') return individualCardComponents(rows, targetId, page, disabled);
    if (view === 'franchise') {
      return franchisePageComponents(groups, rows, targetId, sort, page, disabled);
    }
    return haremListComponents(rows, targetId, sort, page, { disabled });
  };

  let expired = false;
  const reply = await ctx.message.reply({
    flags: MessageFlags.IsComponentsV2,
    components: render(false),
    allowedMentions: { parse: [] },
  });

  if (maxPages <= 1 || !reply?.createMessageComponentCollector) return;

  const controlLifetime = getGameConfig(ctx.yoshiko.catalogDb, ctx.message.guildId).controls.lifetimeMs;
  const collector = reply.createMessageComponentCollector({ time: controlLifetime });
  collector.on('collect', async (interaction) => {
    try {
      if (interaction.user.id !== ctx.message.author.id || interaction.guildId !== ctx.message.guildId) {
        await interaction.reply({ content: 'Only the command user can change pages.', flags: MessageFlags.Ephemeral });
        return;
      }
      if (expired) {
        await interaction.reply({ content: 'These buttons have expired.', flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.deferUpdate();
      if (interaction.customId === 'mm:prev' && page > 0) page--;
      else if (interaction.customId === 'mm:next' && page < maxPages - 1) page++;
      await reply.edit({ components: render(false) });
    } catch (error) {
      console.error('Marriage page interaction failed:', error);
    }
  });
  collector.on('end', () => {
    expired = true;
    reply.edit({ components: render(true) }).catch(console.error);
  });
}

export async function run(ctx) {
  await runMarriages(ctx);
}
