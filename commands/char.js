import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, EmbedBuilder } from 'discord.js';
import { findCharacters } from '../lib/gameCharacterLookup.js';

const IMAGE_BUTTON_LIFETIME_MS = 60 * 60 * 1000;

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

function imageButtons(canGoBack, canGoNext) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('char:prev').setLabel('Previous image')
      .setStyle(ButtonStyle.Secondary).setDisabled(!canGoBack),
    new ButtonBuilder().setCustomId('char:next').setLabel('Next image')
      .setStyle(ButtonStyle.Primary).setDisabled(!canGoNext),
  )];
}

function characterEmbed(character, image) {
  const titles = jsonArray(character.anime_titles);
  const names = [character.name_native, ...jsonArray(character.name_alternatives)]
    .filter((name, index, all) => name && name !== character.name_full && all.indexOf(name) === index)
    .slice(0, 3);
  const anime = titles.length ? `${short(titles[0])}${titles.length > 1 ? ` (+${titles.length - 1} more)` : ''}` : 'Unknown';
  const lines = [
    `**Anime:** ${anime}`,
    ...(names.length ? ['**Other names:**', ...names.map((name) => `• ${short(name)}`)] : []),
    `**Rank:** #${character.rank}`,
    `**Favorites:** ${character.favourites.toLocaleString('en-US')}`,
    ...(image.source === 'danbooru' ? [`[Image source](https://safebooru.donmai.us/posts/${image.postId})`] : []),
  ];
  const embed = new EmbedBuilder()
    .setTitle(short(character.name_full, 250))
    .setDescription(lines.join('\n'));
  if (character.site_url?.startsWith('https://')) embed.setURL(character.site_url);
  if (image.url) embed.setImage(image.url);
  return embed;
}

export async function run(ctx) {
  const query = ctx.args.slice(1).join(' ').trim();
  if (!query) {
    await ctx.message.reply(`Usage: ${ctx.prefix}char <name or #rank>`);
    return;
  }

  const matches = findCharacters(ctx.yoshiko.characterIndex, query);
  if (!matches.length) {
    await ctx.message.reply('No character found. Try a fuller name or a rank such as #625.');
    return;
  }
  if (matches.length > 1) {
    const lines = matches.slice(0, 5).map((character) => {
      const anime = jsonArray(character.anime_titles)[0] || 'Unknown anime';
      return `#${character.rank} ${character.name_full} — ${short(anime, 70)}`;
    });
    const extra = matches.length > 5 ? `\n${matches.length - 5} more matches. Refine the name.` : '';
    await ctx.message.reply({ content: `Multiple characters match:\n${lines.join('\n')}${extra}\nUse ${ctx.prefix}char #rank to choose one.`, allowedMentions: { parse: [], repliedUser: false } });
    return;
  }

  const character = matches[0];
  const decision = ctx.yoshiko.catalogDb.prepare('SELECT tag_name FROM tag_decisions WHERE character_id = ? AND status = ?')
    .get(character.id, 'approve');
  const image = await ctx.yoshiko.imagePicker.pick(ctx.message.guildId, character.id, decision?.tag_name, character.image_url);
  const reply = await ctx.message.reply({
    embeds: [characterEmbed(character, image)],
    components: imageButtons(false, image.poolSize > 1),
    allowedMentions: { parse: [], repliedUser: false },
  });
  if (!reply?.createMessageComponentCollector || image.poolSize < 2) return;

  const history = [image];
  let position = 0;
  let busy = false;
  let expired = false;
  const collector = reply.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: IMAGE_BUTTON_LIFETIME_MS,
    filter: (interaction) => interaction.customId === 'char:prev' || interaction.customId === 'char:next',
  });
  collector.on('collect', async (interaction) => {
    try {
      await interaction.deferUpdate();
    } catch (error) {
      console.error('Character image button acknowledgement failed:', error);
      return;
    }
    if (busy) return;
    busy = true;
    try {
      if (interaction.customId === 'char:prev') {
        if (position > 0) position--;
      } else if (position < history.length - 1) {
        position++;
      } else {
        let nextImage;
        for (let attempt = 0; attempt < image.poolSize; attempt++) {
          nextImage = await ctx.yoshiko.imagePicker.pick(ctx.message.guildId, character.id, decision.tag_name, character.image_url);
          if (nextImage.source !== 'danbooru' || nextImage.postId !== history[position].postId) break;
        }
        if (nextImage?.source === 'danbooru' && nextImage.postId !== history[position].postId) {
          history.push(nextImage);
          position++;
        }
      }
      if (!expired) {
        await reply.edit({
          embeds: [characterEmbed(character, history[position])],
          components: imageButtons(position > 0, image.poolSize > 1),
        });
      }
    } catch (error) {
      console.error('Character image navigation failed:', error);
    } finally {
      busy = false;
    }
  });
  collector.on('end', () => {
    expired = true;
    reply.edit({ components: imageButtons(false, false) }).catch(console.error);
  });
}
