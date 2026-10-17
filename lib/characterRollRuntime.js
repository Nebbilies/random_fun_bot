import {
  ButtonBuilder, ButtonStyle, ContainerBuilder, EmbedBuilder, escapeMarkdown,
  MediaGalleryBuilder, MediaGalleryItemBuilder, MessageFlags, TextDisplayBuilder,
} from 'discord.js';
import { reportCharacterTag } from './catalogDb.js';
import { formatNumber } from './formatNumber.js';
import {
  claimRoll, cleanupRolls, failRoll, getReportableRoll, getRoll, markClaimNotice,
  publishRoll, recoverRolls,
} from './characterRolls.js';
import { reserveMysteryAwareRoll } from './mysteryCoordinator.js';
import { startMysteryRoll } from './mysteryRuntime.js';
import { fileURLToPath } from 'node:url';

const HEART = '❤️';

function firstAnimeName(titles) {
  try {
    const names = JSON.parse(titles || '[]');
    return Array.isArray(names)
      ? names.find((name) => typeof name === 'string' && name.trim()) || 'Unknown anime'
      : 'Unknown anime';
  } catch {
    return 'Unknown anime';
  }
}

export function rollCard(character, image, remaining) {
  const container = new ContainerBuilder().setAccentColor(0xe91e63)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`# ${escapeMarkdown(character.name_full)}`),
      new TextDisplayBuilder().setContent(escapeMarkdown(firstAnimeName(character.anime_titles))),
      new TextDisplayBuilder().setContent(`**Rank:** #${formatNumber(character.rank)}\n**Likes:** ${formatNumber(character.favourites)}`),
    );
  if (image?.url) container.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(
    new MediaGalleryItemBuilder().setURL(image.url).setDescription(character.name_full),
  ));
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`-# ${remaining} roll${remaining === 1 ? '' : 's'} left`),
  );
  container.addActionRowComponents((row) => row.addComponents(
    new ButtonBuilder().setCustomId('roll:report').setLabel('Report tag').setStyle(ButtonStyle.Secondary),
  ));
  return { flags: MessageFlags.IsComponentsV2, components: [container],
    allowedMentions: { parse: [], repliedUser: false } };
}

function prankCard(prank, remaining) {
  const title = prank === 'dog_clap' ? 'ur roll gone' : 'john ate ur roll';
  const filename = `${prank}.gif`;
  const container = new ContainerBuilder().setAccentColor(0xe91e63)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`# ${title}`),
      new TextDisplayBuilder().setContent('- '),
      new TextDisplayBuilder().setContent('**Rank:** ?\n**Likes:** ?'),
    )
    .addMediaGalleryComponents(new MediaGalleryBuilder().addItems(
      new MediaGalleryItemBuilder().setURL(`attachment://${filename}`).setDescription(title),
    ))
    .addTextDisplayComponents(new TextDisplayBuilder()
      .setContent(`-# ${remaining} roll${remaining === 1 ? '' : 's'} left`));
  return { flags: MessageFlags.IsComponentsV2, components: [container],
    files: [{ attachment: fileURLToPath(new URL(`../assets/${filename}`, import.meta.url)), name: filename }],
    allowedMentions: { parse: [], repliedUser: false } };
}

export async function runRoll(ctx, pool, random = Math.random) {
  const { message, yoshiko } = ctx;
  const db = yoshiko.catalogDb;
  cleanupRolls(db);
  const reservation = reserveMysteryAwareRoll(db, { guildId: message.guildId, channelId: message.channelId,
    commandMessageId: message.id, userId: message.author.id, pool,
    mysteryEnabled: yoshiko.mysteryEnabled, prankEnabled: true, random });
  if (reservation.status === 'duplicate') return;
  if (reservation.status === 'prank') {
    await message.reply(prankCard(reservation.prank, reservation.remaining));
    return;
  }
  if (reservation.status === 'exhausted') {
    await message.reply(`No rolls left. Next reset: <t:${Math.floor(reservation.resetAt / 1000)}:F>.`);
    return;
  }
  if (reservation.status === 'empty') {
    await message.reply('No unowned characters are available for this roll.');
    return;
  }
  if (reservation.status === 'paused') {
    await message.reply('Rolls are paused while a mystery event is active in this server.');
    return;
  }
  if (reservation.status === 'unavailable') {
    await message.reply('No mystery event is available for this roll. Your roll was not spent.');
    return;
  }
  if (reservation.status === 'mystery') {
    let intro;
    try {
      intro = await startMysteryRoll({ db, client: yoshiko.client, message, reservation,
        imagePicker: yoshiko.imagePicker });
    } catch (error) {
      failRoll(db, reservation.rollId);
      throw error;
    }
    const url = intro.url ?? `https://discord.com/channels/${message.guildId}/${intro.channelId}/${intro.id}`;
    await message.reply(`A mystery event has started: ${url}`).catch((error) =>
      console.error('Mystery event link reply failed:', error));
    return;
  }
  const { character, rollId, remaining } = reservation;
  let image = { url: character.image_url };
  try {
    image = await yoshiko.imagePicker.pick(message.guildId, character.id, character.tag_name, character.image_url);
  } catch (error) {
    console.error('Roll image lookup failed:', error);
  }
  let card;
  try {
    card = await message.reply(rollCard(character, image, remaining));
  } catch (error) {
    failRoll(db, rollId);
    throw error;
  }
  if (!publishRoll(db, rollId, card.id)) return;
  try {
    await card.react(HEART);
  } catch (error) {
    failRoll(db, rollId);
    console.error('Roll heart reaction failed:', error);
  }
}

export async function onRollReaction(yoshiko, reaction, user) {
  if (user.bot || reaction.emoji?.name !== HEART) return;
  const message = reaction.message;
  const guildId = message.guildId;
  const channelId = message.channelId;
  if (!guildId || !channelId || !message.id) return;
  const db = yoshiko.catalogDb;
  const result = claimRoll(db, { guildId, channelId, messageId: message.id, userId: user.id });
  if (result.status === 'married') {
    if (getRoll(db, guildId, channelId, message.id)?.mysterySessionId) {
      try {
        const card = message.embeds?.length || !message.fetch ? message : await message.fetch();
        if (card.embeds?.[0] && card.edit) {
          await card.edit({ embeds: [new EmbedBuilder(card.embeds[0].toJSON())
            .setFooter({ text: 'Claimed' })], allowedMentions: { parse: [], repliedUser: false } });
        }
      } catch (error) {
        console.error('Mystery claim card update failed:', error);
      }
    }
    try {
      await message.channel.send({
        content: `<@${user.id}> has married **${escapeMarkdown(result.characterName)}** 🎉`,
        allowedMentions: { users: [user.id], roles: [], repliedUser: false },
      });
    } catch (error) {
      console.error('Marriage announcement failed:', error);
    }
  } else if (result.status === 'exhausted' && markClaimNotice(db, result.rollId, user.id)) {
    await message.channel.send({
      content: `<@${user.id}> has no claim left. Next reset: <t:${Math.floor(result.resetAt / 1000)}:F>.`,
      allowedMentions: { users: [user.id], roles: [], repliedUser: false },
    }).catch((error) => console.error('Claim notice failed:', error));
  }
}

export async function onRollReport(db, interaction) {
  if (!interaction.isButton() || interaction.customId !== 'roll:report') return false;
  const roll = getReportableRoll(db, interaction.guildId, interaction.channelId, interaction.message.id);
  const created = roll && reportCharacterTag(db, roll.characterId, interaction.user.id);
  await interaction.reply({
    content: !roll ? 'This report button has expired.'
      : created ? 'Tag report saved for review.' : 'You already reported this character, or it is no longer in the catalog.',
    flags: MessageFlags.Ephemeral,
  });
  return true;
}

export function recoverRollRuntime(db) {
  return recoverRolls(db).length;
}
