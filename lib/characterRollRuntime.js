import {
  ButtonBuilder, ButtonStyle, ContainerBuilder, escapeMarkdown,
  MediaGalleryBuilder, MediaGalleryItemBuilder, MessageFlags, TextDisplayBuilder,
} from 'discord.js';
import { reportCharacterTag } from './catalogDb.js';
import { formatNumber } from './formatNumber.js';
import {
  claimRoll, cleanupRolls, failRoll, getReportableRoll, getRoll, markClaimNotice,
  publishRoll, recoverRolls, refreshEscapeRoll,
} from './characterRolls.js';
import { reserveMysteryAwareRoll } from './mysteryCoordinator.js';
import { startMysteryRoll, updateMysteryPrizeStatus } from './mysteryRuntime.js';
import { startVaultRoll } from './vaultRuntime.js';
import { getInventory, decrementItemCharge } from './itemStorage.js';
import { fileURLToPath } from 'node:url';

const HEART = '❤️';
const escapeUpdates = new WeakMap();

/** @typedef {{phase: 'protected' | 'public', ownerId: string, protectedUntil?: number | null,
 *   ping?: boolean, outcome?: string | null, winnerId?: string | null}} EscapeCard */
/** @typedef {{now?: () => number, setTimer?: (callback: () => void, delay: number) => any,
 *   clearTimer?: (timer: any) => void}} RollClock */

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

/** @param {EscapeCard | null} [escape] */
export function rollCard(character, image, remaining, escape = null) {
  const container = new ContainerBuilder().setAccentColor(escape?.outcome === 'married'
    ? 0x8b4513 : escape?.phase === 'protected' ? 0x9b59b6 : 0xe91e63)
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
  const components = [...(escape ? [new TextDisplayBuilder().setContent(escapeText(character, escape))] : []), container];
  return { flags: MessageFlags.IsComponentsV2, components,
    allowedMentions: { parse: [], users: escape?.ping ? [escape.ownerId] : [], repliedUser: false } };
}

function escapeText(character, escape) {
  const name = `**${escapeMarkdown(character.name_full)}**`;
  const gender = String(character.gender ?? '').trim().toLowerCase();
  const pronoun = gender === 'female' ? 'her' : gender === 'male' ? 'him' : 'them';
  if (escape.outcome === 'reclaimed') return `**Reclaimed** — <@${escape.ownerId}> reclaimed ${name}!`;
  if (escape.outcome === 'married') return `**Married** — <@${escape.winnerId}> has married ${name}!`;
  if (escape.outcome === 'expired') return `**Expired** — ${name}'s ownership is unchanged.`;
  if (escape.outcome) return `**Canceled** — ${name}'s escape attempt has ended.`;
  if (escape.phase === 'public') return `${name} has left the harem! Anyone can now marry ${pronoun}!`;
  return `<@${escape.ownerId}> ${name} tries to leave your harem! You have 60 seconds to reclaim ${pronoun} before anyone else can marry ${pronoun}!\n`
    + `-# Reclaim before <t:${Math.floor(escape.protectedUntil / 1000)}:R>.`;
}

/** @param {RollClock & {db: any, message: any, character: any, image: any, remaining: number,
 *   guildId?: string, channelId?: string}} options */
export function startEscapeUpdates({ db, message, character, image, remaining,
  guildId = message.guildId, channelId = message.channelId,
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let updates = escapeUpdates.get(db);
  if (!updates) { updates = new Map(); escapeUpdates.set(db, updates); }
  let queued = Promise.resolve();
  let timer;
  let stopped = false;
  function stop() {
    stopped = true;
    if (timer) clearTimer(timer);
    updates.delete(message.id);
  }
  function refresh() {
    queued = queued.then(async () => {
      if (stopped) return;
      const time = now();
      const roll = refreshEscapeRoll(db, guildId, channelId, message.id, time);
      if (!roll?.escapeMarriageId) { stop(); return; }
      const terminal = roll.state !== 'open';
      const phase = roll.protectedUntil != null
        && (roll.escapeResolvedAt ?? time) >= roll.protectedUntil ? 'public' : 'protected';
      try {
        await message.edit(rollCard(character, image, remaining, { phase,
          ownerId: roll.escapeOwnerId, protectedUntil: roll.protectedUntil,
          outcome: roll.escapeOutcome, winnerId: roll.escapeWinnerId }));
      } finally {
        if (terminal) stop();
      }
    }).catch((error) => console.error('Escape card update failed:', error));
    return queued;
  }
  function schedule() {
    const roll = getRoll(db, guildId, channelId, message.id);
    if (!roll || roll.state !== 'open') return;
    const next = now() < roll.protectedUntil ? roll.protectedUntil : roll.expiresAt;
    timer = setTimer(async () => {
      await refresh();
      if (!stopped) schedule();
    }, Math.max(0, next - now()));
    timer?.unref?.();
  }
  updates.set(message.id, refresh);
  const roll = getRoll(db, guildId, channelId, message.id);
  if (roll?.state === 'open') schedule();
  return { refresh, stop };
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

/** @param {RollClock} [clock] */
export async function runRoll(ctx, pool, random = Math.random,
  clock = {}) {
  const { now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = clock;
  const { message, yoshiko } = ctx;
  const db = yoshiko.catalogDb;
  cleanupRolls(db, now());
  const reservation = reserveMysteryAwareRoll(db, { guildId: message.guildId, channelId: message.channelId,
    commandMessageId: message.id, userId: message.author.id, pool,
    mysteryEnabled: yoshiko.mysteryEnabled, prankEnabled: true,
    vaultEnabled: Boolean(yoshiko.vaultEnabled),
    random, now: now() });
  if (reservation.status === 'vault') {
    await startVaultRoll({ db, channel: message.channel, guildId: message.guildId,
      rollerId: message.author.id, remaining: reservation.remaining });
    return;
  }
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
    await message.reply('No characters are available for this roll.');
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
    card = await message.reply(rollCard(character, image, remaining, reservation.escapeOwnerId ? {
      ownerId: reservation.escapeOwnerId, protectedUntil: now() + 60_000, phase: 'protected', ping: true,
    } : null));
  } catch (error) {
    failRoll(db, rollId);
    throw error;
  }
  if (reservation.escapeOwnerId) {
    try {
      const ownerInv = getInventory(db, message.guildId, reservation.escapeOwnerId);
      const whistle = ownerInv.find((i) => i.item_id === 'golden_whistle');
      if (whistle) {
        decrementItemCharge(db, whistle.id);
        claimRoll(db, { guildId: message.guildId, channelId: message.channelId, messageId: card.id, userId: reservation.escapeOwnerId });
        await message.channel.send(`🔔 <@${reservation.escapeOwnerId}>'s **Golden Whistle** blew! **${character.name_full}** was automatically prevented from escaping. (${whistle.charges - 1} charge${whistle.charges - 1 === 1 ? '' : 's'} remaining)`);
      }
    } catch (err) {
      console.error('Golden whistle check failed:', err);
    }
  }
  const published = publishRoll(db, rollId, card.id, now());
  const updates = reservation.escapeOwnerId ? startEscapeUpdates({ db, message: card, character,
    image, remaining, guildId: message.guildId, channelId: message.channelId, now, setTimer, clearTimer }) : null;
  if (!published) { await updates?.refresh(); return; }
  try {
    await card.react(HEART);
  } catch (error) {
    failRoll(db, rollId);
    await updates?.refresh();
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
  if (['married', 'reclaimed', 'closed', 'expired'].includes(result.status)) {
    await escapeUpdates.get(db)?.get(message.id)?.();
  }
  if (result.status === 'married') {
      try {
        const card = message.embeds?.length || !message.fetch ? message : await message.fetch();
        if ((card.embeds?.[0] || card.components?.[0]) && card.edit) {
          if (getRoll(db, guildId, channelId, message.id)?.mysterySessionId) {
            await updateMysteryPrizeStatus(card, 'Claimed');
          } else if (!getRoll(db, guildId, channelId, message.id)?.escapeMarriageId) {
            await card.edit({ components: card.components.map((component) => {
              const data = component.toJSON();
              return data.type === 17 ? new ContainerBuilder(data).setAccentColor(0x8b4513) : component;
            }), allowedMentions: { parse: [], repliedUser: false } });
          }
        }
      } catch (error) {
        console.error('Claim card update failed:', error);
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
