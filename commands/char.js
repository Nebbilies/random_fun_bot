import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, escapeMarkdown,
  LabelBuilder, MediaGalleryBuilder, MediaGalleryItemBuilder, MessageFlags,
  ModalBuilder, StringSelectMenuBuilder, TextDisplayBuilder, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { findCharacters } from '../lib/gameCharacterLookup.js';
import { reportCharacterTag } from '../lib/catalogDb.js';
import { formatNumber } from '../lib/formatNumber.js';

const PAGE_SIZE = 25;
const CONTROL_LIFETIME_MS = 60 * 60 * 1000;
const PAGE_INPUT_ID = 'char:page-number';

function jsonArray(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string' && item.trim()) : [];
  } catch {
    return [];
  }
}

function short(value, length = 180) {
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

function button(id, label, disabled = false) {
  return new ButtonBuilder().setCustomId(id).setLabel(label)
    .setStyle(ButtonStyle.Secondary).setDisabled(disabled);
}

function chooserComponents(matches, page, disabled = false) {
  const pages = Math.ceil(matches.length / PAGE_SIZE);
  const options = matches.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((character) => {
    const anime = jsonArray(character.anime_titles)[0] || 'Unknown anime';
    return {
      label: short(`#${formatNumber(character.rank)} • ${character.name_full} (${anime})`, 100),
      value: String(character.id),
    };
  });
  return [new ContainerBuilder().setAccentColor(0x5865f2)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `## Choose a character\n${formatNumber(matches.length)} matches • Page ${page + 1} of ${pages}`,
    ))
    .addActionRowComponents(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId('char:choose')
        .setPlaceholder('Select a character').setDisabled(disabled).addOptions(options),
    ))
    .addActionRowComponents(new ActionRowBuilder().addComponents(
      button('char:page:prev', 'Previous', disabled || page === 0),
      button('char:page:next', 'Next', disabled || page === pages - 1),
      button('char:page:jump', 'Jump to page', disabled || pages === 1),
    ))];
}

function cardComponents(character, image, position, hasMoreImages, canGoBack, disabled = false) {
  const titles = jsonArray(character.anime_titles);
  const names = [character.name_native, ...jsonArray(character.name_alternatives)]
    .filter((name, index, all) => name && name !== character.name_full && all.indexOf(name) === index)
    .slice(0, 3);
  const anime = titles.length ? `${short(titles[0])}${titles.length > 1 ? ` (+${titles.length - 1} more)` : ''}` : 'Unknown';
  const title = escapeMarkdown(short(character.name_full, 250));
  const heading = character.site_url?.startsWith('https://')
    ? `# [${title}](${character.site_url})` : `# ${title}`;
  const details = [
    `**Anime:** ${escapeMarkdown(anime)}`,
    ...(names.length ? ['**Other names:**', ...names.map((name) => `• ${escapeMarkdown(short(name))}`)] : []),
    `**Rank:** #${formatNumber(character.rank)} • **Favorites:** ${formatNumber(character.favourites)}`,
  ];
  const container = new ContainerBuilder().setAccentColor(0x5865f2)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(heading),
      new TextDisplayBuilder().setContent(details.join('\n')),
    );
  if (image.url) {
    container.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(
      new MediaGalleryItemBuilder().setURL(image.url).setDescription(character.name_full),
    ));
  }
  if (image.source === 'danbooru') {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `[Image source](https://safebooru.donmai.us/posts/${image.postId})`,
    ));
  }
  const controls = [button('char:report', 'Report tag', disabled)];
  if (hasMoreImages) {
    controls.push(
      new ButtonBuilder().setCustomId('char:image:prev').setEmoji('⬅️')
        .setStyle(ButtonStyle.Primary).setDisabled(disabled || position === 0),
      new ButtonBuilder().setCustomId('char:image:next').setEmoji('➡️')
        .setStyle(ButtonStyle.Success).setDisabled(disabled),
    );
  }
  if (canGoBack) controls.push(button('char:back', 'Back to results', disabled));
  container.addActionRowComponents(new ActionRowBuilder().addComponents(controls));
  return [container];
}

function jumpModal(pages, id) {
  return new ModalBuilder().setCustomId(id).setTitle('Jump to results page')
    .addLabelComponents(new LabelBuilder().setLabel(`Page number (1–${pages})`).setTextInputComponent(
      new TextInputBuilder().setCustomId(PAGE_INPUT_ID).setStyle(TextInputStyle.Short)
        .setRequired(true).setPlaceholder('Enter a page number'),
    ));
}

export async function run(ctx) {
  const commandName = ctx.args[0] || 'char';
  const query = ctx.args.slice(1).join(' ').trim();
  if (!query) {
    await ctx.message.reply(`Usage: ${ctx.prefix}${commandName} <name or #rank>`);
    return;
  }

  const matches = findCharacters(ctx.yoshiko.characterIndex, query);
  if (!matches.length) {
    await ctx.message.reply('No character found. Try a fuller name or a rank such as #625.');
    return;
  }

  let page = 0;
  let selected = null;
  let decision = null;
  let history = [];
  let position = 0;
  let busy = false;
  let expired = false;

  async function loadCard(character) {
    const approved = ctx.yoshiko.catalogDb.prepare('SELECT tag_name FROM tag_decisions WHERE character_id = ? AND status = ?')
      .get(character.id, 'approve');
    const image = await ctx.yoshiko.imagePicker.pick(
      ctx.message.guildId, character.id, approved?.tag_name, character.image_url,
    );
    return { character, approved, image };
  }

  function renderCard(disabled = false) {
    return cardComponents(selected, history[position], position,
      history[0].poolSize > 1, matches.length > 1, disabled);
  }

  if (matches.length === 1) {
    const card = await loadCard(matches[0]);
    selected = card.character;
    decision = card.approved;
    history = [card.image];
  }
  const reply = await ctx.message.reply({
    flags: MessageFlags.IsComponentsV2,
    components: selected ? renderCard() : chooserComponents(matches, page),
    allowedMentions: { parse: [], repliedUser: false },
  });
  if (!reply?.createMessageComponentCollector) return;

  const collector = reply.createMessageComponentCollector({ time: CONTROL_LIFETIME_MS });
  const ownerId = ctx.message.author.id;

  async function handleJump(interaction) {
    const pages = Math.ceil(matches.length / PAGE_SIZE);
    const modalId = `char:jump:${interaction.id}`;
    await interaction.showModal(jumpModal(pages, modalId));
    let submission;
    try {
      submission = await interaction.awaitModalSubmit({
        time: 60_000,
        filter: (item) => item.customId === modalId && item.user.id === ownerId,
      });
    } catch {
      return;
    }
    const input = submission.fields.getTextInputValue(PAGE_INPUT_ID).trim();
    const target = Number(input);
    if (!/^\d+$/.test(input) || target < 1 || target > pages) {
      await submission.reply({ content: `Enter a page from 1 to ${pages}.`, flags: MessageFlags.Ephemeral });
      return;
    }
    await submission.deferUpdate();
    if (expired || selected || busy) return;
    busy = true;
    try {
      await reply.edit({ components: chooserComponents(matches, target - 1) });
      page = target - 1;
      if (expired) await reply.edit({ components: chooserComponents(matches, page, true) });
    } finally {
      busy = false;
    }
  }

  collector.on('collect', async (interaction) => {
    try {
      const id = interaction.customId;
      if (id === 'char:report' && selected && !expired) {
        const created = reportCharacterTag(ctx.yoshiko.catalogDb, selected.id, interaction.user.id);
        await interaction.reply({
          content: created ? 'Tag report saved for review.' : 'You already reported this character, or it is no longer in the catalog.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (!id.startsWith('char:image:') && interaction.user.id !== ownerId) {
        await interaction.deferUpdate();
        return;
      }
      if (id === 'char:page:jump' && !selected && !expired && !busy) {
        await handleJump(interaction);
        return;
      }
      await interaction.deferUpdate();
      if (expired || busy) return;
      busy = true;
      try {
        if (id === 'char:choose' && !selected) {
          const character = matches.find((match) => String(match.id) === interaction.values?.[0]);
          if (!character || !matches.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).includes(character)) return;
          const card = await loadCard(character);
          if (expired) return;
          await reply.edit({ components: cardComponents(character, card.image, 0,
            card.image.poolSize > 1, true) });
          selected = character;
          decision = card.approved;
          history = [card.image];
          position = 0;
          collector.resetTimer({ time: CONTROL_LIFETIME_MS });
        } else if (id === 'char:back' && selected && matches.length > 1) {
          await reply.edit({ components: chooserComponents(matches, page) });
          selected = null;
          decision = null;
          history = [];
          position = 0;
          collector.resetTimer({ time: CONTROL_LIFETIME_MS });
        } else if (id === 'char:page:prev' && !selected && page > 0) {
          await reply.edit({ components: chooserComponents(matches, page - 1) });
          page--;
        } else if (id === 'char:page:next' && !selected && (page + 1) * PAGE_SIZE < matches.length) {
          await reply.edit({ components: chooserComponents(matches, page + 1) });
          page++;
        } else if (id === 'char:image:prev' && selected && position > 0) {
          await reply.edit({ components: cardComponents(selected, history[position - 1], position - 1,
            history[0].poolSize > 1, matches.length > 1) });
          position--;
        } else if (id === 'char:image:next' && selected && history[0].poolSize > 1) {
          let nextPosition = position;
          if (position < history.length - 1) {
            nextPosition++;
          } else {
            let nextImage;
            for (let attempt = 0; attempt < history[0].poolSize; attempt++) {
              nextImage = await ctx.yoshiko.imagePicker.pick(
                ctx.message.guildId, selected.id, decision?.tag_name, selected.image_url,
              );
              if (nextImage.source !== 'danbooru' || nextImage.postId !== history[position].postId) break;
            }
            if (nextImage?.source === 'danbooru' && nextImage.postId !== history[position].postId) {
              history.push(nextImage);
              nextPosition++;
            }
          }
          await reply.edit({ components: cardComponents(selected, history[nextPosition], nextPosition,
            history[0].poolSize > 1, matches.length > 1) });
          position = nextPosition;
        }
        if (expired) {
          await reply.edit({ components: selected ? renderCard(true) : chooserComponents(matches, page, true) });
        }
      } finally {
        busy = false;
      }
    } catch (error) {
      console.error('Character interaction failed:', error);
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: 'Character lookup failed. Please try again later.', flags: MessageFlags.Ephemeral })
          .catch(console.error);
      }
    }
  });
  collector.on('end', () => {
    expired = true;
    reply.edit({ components: selected ? renderCard(true) : chooserComponents(matches, page, true) })
      .catch(console.error);
  });
}
