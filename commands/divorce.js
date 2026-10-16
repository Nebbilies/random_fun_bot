import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder,
  escapeMarkdown, MessageFlags, PermissionFlagsBits, StringSelectMenuBuilder,
  TextDisplayBuilder } from 'discord.js';
import { divorceCharacter, getMarriage, listMarriages } from '../lib/characterMarriage.js';
import { findCharacters } from '../lib/gameCharacterLookup.js';
import { formatNumber } from '../lib/formatNumber.js';

const PAGE_SIZE = 25;
const CONTROL_LIFETIME_MS = 60 * 60 * 1000;

/** @param {import('discord.js').MessageActionRowComponentBuilder[]} components */
function actionRow(...components) {
  return /** @type {ActionRowBuilder<import('discord.js').MessageActionRowComponentBuilder>} */ (
    new ActionRowBuilder().addComponents(components));
}

function button(id, label, style = ButtonStyle.Secondary, disabled = false) {
  return new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(disabled);
}

function pickerComponents(matches, page, disabled = false) {
  const pages = Math.ceil(matches.length / PAGE_SIZE);
  const options = matches.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((row) => ({
    label: `#${formatNumber(row.rank)} • ${(row.name_full || `Character ${row.characterId}`).slice(0, 65)} • ID ${row.characterId}`.slice(0, 100),
    value: String(row.characterId),
  }));
  const container = new ContainerBuilder().setAccentColor(0x5865f2)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `## Choose a marriage to end\nPage ${page + 1} of ${pages}`,
    ))
    .addActionRowComponents(actionRow(
      new StringSelectMenuBuilder().setCustomId('divorce:choose')
        .setPlaceholder('Select a character').setDisabled(disabled).addOptions(options),
    ));
  if (pages > 1) {
    container.addActionRowComponents(actionRow(
      button('divorce:prev', 'Previous', ButtonStyle.Secondary, disabled || page === 0),
      button('divorce:next', 'Next', ButtonStyle.Secondary, disabled || page === pages - 1),
    ));
  }
  return [container];
}

function confirmationComponents(row, disabled = false) {
  const name = escapeMarkdown(row.name_full || `Character ${row.characterId}`);
  return [new ContainerBuilder().setAccentColor(0xed4245)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `## Divorce ${name}?\n#${formatNumber(row.rank)} • AniList ID ${row.characterId} • Owner <@${row.ownerId}>`,
    ))
    .addActionRowComponents(actionRow(
      button('divorce:confirm', 'Divorce', ButtonStyle.Danger, disabled),
      button('divorce:cancel', 'Cancel', ButtonStyle.Secondary, disabled),
    ))];
}

function resultComponents(message) {
  return [new ContainerBuilder().setAccentColor(0x5865f2)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(message))];
}

function isAdministrator(permissions) {
  return Boolean(permissions?.has(PermissionFlagsBits.Administrator));
}

export async function run(ctx) {
  const actorId = ctx.message.author.id;
  const guildId = ctx.message.guildId;
  const words = ctx.args.slice(1);
  const targetToken = words[0];
  const mention = targetToken?.match(/^<@!?(\d+)>$/);
  const targetIsId = /^\d+$/.test(targetToken ?? '');
  const targetId = mention?.[1] ?? (targetIsId ? targetToken : actorId);
  if (mention || targetIsId) words.shift();
  if (targetId !== actorId && !isAdministrator(ctx.message.member?.permissions)) {
    await ctx.message.reply('Only an Administrator can divorce another user’s character.');
    return;
  }
  const query = words.join(' ').trim();
  if (!query) {
    await ctx.message.reply(`Usage: ${ctx.prefix}divorce [@user or user ID] <character name>`);
    return;
  }

  const marriages = listMarriages(ctx.yoshiko.catalogDb, guildId, targetId, 'rank');
  const matches = query.length === 1
    ? marriages.filter((row) => row.name_full?.normalize('NFKC').toLocaleLowerCase('en-US')
      === query.normalize('NFKC').toLocaleLowerCase('en-US'))
    : findCharacters(marriages, query);
  if (!matches.length) {
    await ctx.message.reply('No matching married character found for that user in this server.');
    return;
  }

  let page = 0;
  let selected = matches.length === 1 ? matches[0] : null;
  let expired = false;
  let finished = false;
  let busy = false;
  const reply = await ctx.message.reply({
    flags: MessageFlags.IsComponentsV2,
    components: selected ? confirmationComponents(selected) : pickerComponents(matches, page),
    allowedMentions: { parse: [] },
  });
  if (!reply?.createMessageComponentCollector) return;
  const collector = reply.createMessageComponentCollector({ time: CONTROL_LIFETIME_MS });
  collector.on('collect', async (interaction) => {
    try {
      if (interaction.user.id !== actorId || interaction.guildId !== guildId) {
        await interaction.reply({ content: 'Only the command user can decide this divorce.', flags: MessageFlags.Ephemeral });
        return;
      }
      if (expired || finished || busy) {
        await interaction.reply({ content: 'This divorce prompt is no longer available.', flags: MessageFlags.Ephemeral });
        return;
      }
      busy = true;
      await interaction.deferUpdate();
      const id = interaction.customId;
      if (id === 'divorce:choose' && !selected) {
        const choice = matches.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
          .find((row) => String(row.characterId) === interaction.values?.[0]);
        if (choice) {
          selected = choice;
          await reply.edit({ components: confirmationComponents(choice) });
        }
      } else if (id === 'divorce:prev' && !selected && page > 0) {
        page--;
        await reply.edit({ components: pickerComponents(matches, page) });
      } else if (id === 'divorce:next' && !selected && (page + 1) * PAGE_SIZE < matches.length) {
        page++;
        await reply.edit({ components: pickerComponents(matches, page) });
      } else if (id === 'divorce:cancel' && selected) {
        finished = true;
        await reply.edit({ components: resultComponents('Divorce cancelled.') });
        collector.stop();
      } else if (id === 'divorce:confirm' && selected) {
        const stillAdmin = targetId === actorId || isAdministrator(interaction.memberPermissions);
        const current = getMarriage(ctx.yoshiko.catalogDb, guildId, selected.characterId);
        const canDivorce = stillAdmin && current?.id === selected.id && current.ownerId === targetId;
        const divorced = canDivorce && divorceCharacter(ctx.yoshiko.catalogDb,
          guildId, selected.characterId, targetId, selected.id);
        finished = true;
        await reply.edit({ components: resultComponents(divorced
          ? `Divorced ${escapeMarkdown(selected.name_full)}.`
          : 'Marriage or permission changed. Nothing was divorced.') });
        collector.stop();
      }
    } catch (error) {
      console.error('Divorce interaction failed:', error);
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: 'Divorce failed. Please try again later.', flags: MessageFlags.Ephemeral })
          .catch(console.error);
      }
    } finally {
      busy = false;
    }
  });
  collector.on('end', () => {
    expired = true;
    if (!finished) reply.edit({ components: selected
      ? confirmationComponents(selected, true) : pickerComponents(matches, page, true) }).catch(console.error);
  });
}
