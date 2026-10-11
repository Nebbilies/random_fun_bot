import { EmbedBuilder } from 'discord.js';
import { findCharacters } from '../lib/gameCharacterLookup.js';

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
  const titles = jsonArray(character.anime_titles);
  const names = [character.name_native, ...jsonArray(character.name_alternatives)]
    .filter((name, index, all) => name && name !== character.name_full && all.indexOf(name) === index)
    .slice(0, 3);
  const anime = titles.length ? `${short(titles[0])}${titles.length > 1 ? ` (+${titles.length - 1} more)` : ''}` : 'Unknown';
  const lines = [
    `**Anime:** ${anime}`,
    ...(names.length ? [`**Other names:** ${short(names.join(' · '))}`] : []),
    `**AniList rank:** #${character.rank}`,
    `**AniList favourites:** ${character.favourites.toLocaleString('en-US')}`,
    ...(image.source === 'danbooru' ? [`[Image source](https://safebooru.donmai.us/posts/${image.postId})`] : []),
  ];
  const embed = new EmbedBuilder()
    .setTitle(short(`#${character.rank} ${character.name_full}`, 250))
    .setDescription(lines.join('\n'));
  if (character.site_url?.startsWith('https://')) embed.setURL(character.site_url);
  if (image.url) embed.setImage(image.url);
  await ctx.message.reply({ embeds: [embed], allowedMentions: { parse: [], repliedUser: false } });
}
