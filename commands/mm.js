import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder,
  escapeMarkdown, MessageFlags, SectionBuilder, ThumbnailBuilder, TextDisplayBuilder } from 'discord.js';
import { listMarriages } from '../lib/characterMarriage.js';
import { formatNumber } from '../lib/formatNumber.js';
import { resolveUserTarget } from '../lib/userTarget.js';

const PAGE_SIZE = 20;
const CONTROL_LIFETIME_MS = 60 * 60 * 1000;

/** @param {import('discord.js').MessageActionRowComponentBuilder[]} components */
function actionRow(...components) {
  return /** @type {ActionRowBuilder<import('discord.js').MessageActionRowComponentBuilder>} */ (
    new ActionRowBuilder().addComponents(components));
}

function short(value, length = 150) {
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

function pageComponents(rows, targetId, sort, page, disabled = false) {
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const start = page * PAGE_SIZE;
  const lines = rows.slice(start, start + PAGE_SIZE).map((row) => {
    const name = escapeMarkdown(short(row.name_full || `Character ${row.characterId}`));
    return sort === 'rank' ? `#${formatNumber(row.rank)} - ${name}` : name;
  });
  const displays = [
      new TextDisplayBuilder().setContent(`## <@${targetId}>'s harem`),
      new TextDisplayBuilder().setContent(lines.length ? lines.join('\n') : 'No marriages yet.'),
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

/** @param {any} ctx @param {'time' | 'rank'} [sort] */
export async function runMarriages(ctx, sort = 'time') {
  const token = ctx.args?.[1];
  const { targetId, valid } = resolveUserTarget(token, ctx.message.author.id, ctx.message);
  if ((ctx.args && ctx.args.length > 2) || (token && !valid)) {
    const prefix = ctx.prefix ?? '!';
    const commandName = ctx.args?.[0] ?? (sort === 'rank' ? 'mmr' : 'mm');
    await ctx.message.reply(`Usage: ${prefix}${commandName} [@user]`);
    return;
  }
  const rows = listMarriages(ctx.yoshiko.catalogDb, ctx.message.guildId, targetId, sort);
  let page = 0;
  let expired = false;
  const reply = await ctx.message.reply({
    flags: MessageFlags.IsComponentsV2,
    components: pageComponents(rows, targetId, sort, page),
    allowedMentions: { parse: [] },
  });
  if (rows.length <= PAGE_SIZE || !reply?.createMessageComponentCollector) return;
  const collector = reply.createMessageComponentCollector({ time: CONTROL_LIFETIME_MS });
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
      else if (interaction.customId === 'mm:next' && (page + 1) * PAGE_SIZE < rows.length) page++;
      await reply.edit({ components: pageComponents(rows, targetId, sort, page) });
    } catch (error) {
      console.error('Marriage page interaction failed:', error);
    }
  });
  collector.on('end', () => {
    expired = true;
    reply.edit({ components: pageComponents(rows, targetId, sort, page, true) }).catch(console.error);
  });
}

export async function run(ctx) {
  await runMarriages(ctx, 'time');
}
