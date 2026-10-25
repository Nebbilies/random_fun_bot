import {
  ButtonBuilder, ButtonStyle, ContainerBuilder, escapeMarkdown,
  MediaGalleryBuilder, MediaGalleryItemBuilder, MessageFlags, TextDisplayBuilder,
} from 'discord.js';
import { getGameConfig } from './gameConfig.js';
import { reportCharacterTag } from './catalogDb.js';
import { formatNumber } from './formatNumber.js';
import { formatCharacterLikes } from "./characterLikes.js";
import { characterLikesProjection } from './characterLikesProjection.js';
import { divorceCharacter, getMarriage, marryCharacter } from './characterMarriage.js';
import {
  claimRoll, cleanupRolls, failRoll, getReportableRoll, getRoll, getRollStatus,
  markClaimNotice, publishRoll, recoverRolls, refreshEscapeRoll,
} from './characterRolls.js';
import { reserveMysteryAwareRoll } from './mysteryCoordinator.js';
import { startMysteryRoll, updateMysteryPrizeStatus } from './mysteryRuntime.js';
import { startVaultRoll } from './vaultRuntime.js';
import { getInventory, decrementItemCharge, isCharacterLocked } from './itemStorage.js';
import { findWishMatchers } from './characterWishlist.js';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { isCharacterBusy } from './characterAvailability.js';

const HEART = '❤️';
const escapeUpdates = new WeakMap();

/** @typedef {{phase: 'protected' | 'public', ownerId: string, protectedUntil?: number | null,
 *   ping?: boolean, outcome?: string | null, winnerId?: string | null}} EscapeCard */
/** @typedef {{userIds: string[], ping?: boolean}} WishMark */
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

/**
 * @param {EscapeCard | null} [escape]
 * @param {WishMark | null} [wishes] matching wishlist players, rendered as one line above the card
 */
export function rollCard(character, image, remaining, escape = null, wishes = null) {
  const wishedBy = wishes?.userIds ?? [];
  const container = new ContainerBuilder().setAccentColor(escape?.outcome === 'married'
    ? 0x8b4513 : wishedBy.length ? 0x57f287 : escape?.phase === 'protected' ? 0x9b59b6 : 0xe91e63)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`# ${escapeMarkdown(character.name_full)}`),
      new TextDisplayBuilder().setContent(escapeMarkdown(firstAnimeName(character.anime_titles))),
      new TextDisplayBuilder().setContent(`**Rank:** #${formatNumber(character.rank)}\n**Likes:** ${formatCharacterLikes(character)}`),
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
  const components = [
    ...(escape ? [new TextDisplayBuilder().setContent(escapeText(character, escape))] : []),
    ...(wishedBy.length ? [new TextDisplayBuilder().setContent(wishText(wishedBy))] : []),
    container,
  ];
  return { flags: MessageFlags.IsComponentsV2, components,
    allowedMentions: { parse: [], repliedUser: false,
      users: [...(escape?.ping ? [escape.ownerId] : []),
        ...(wishes?.ping === false ? [] : wishedBy)] } };
}

function wishText(userIds) {
  return `⭐ ${userIds.map((userId) => `<@${userId}>`).join(', ')}'s Wish`;
}

/** Wish mark for a card that is being sent, which pings every matching player. */
function wishMark(userIds, ping = true) {
  return userIds.length ? { userIds, ping } : null;
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
 *   guildId?: string, channelId?: string, wishUserIds?: string[]}} options */
export function startEscapeUpdates({ db, message, character, image, remaining,
  guildId = message.guildId, channelId = message.channelId, wishUserIds = [],
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
          outcome: roll.escapeOutcome, winnerId: roll.escapeWinnerId },
        wishUserIds.length ? { userIds: wishUserIds, ping: false } : null));
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

/** The Golden Whistle is passive: it seals an escape as soon as its card goes live. */
async function sealWithWhistle({ db, guildId, channelId, messageId, channel, ownerId, character,
  now = Date.now }) {
  const whistle = getInventory(db, guildId, ownerId).find((item) => item.item_id === 'golden_whistle');
  if (!whistle) return false;
  decrementItemCharge(db, whistle.id);
  claimRoll(db, { guildId, channelId, messageId, userId: ownerId, now: now() });
  const left = whistle.charges - 1;
  await channel.send(`🔔 <@${ownerId}>'s **Golden Whistle** blew! **${character.name_full}** was automatically prevented from escaping. (${left} charge${left === 1 ? '' : 's'} remaining)`)
    .catch((error) => console.error('Golden whistle announcement failed:', error));
  return true;
}

/** Opens a real escape attempt for an item such as Siren's Call. */
export async function recoverForcedEscapes(db, client) {
  const rows = db.prepare(`SELECT id,guild_id,channel_id,character_id,escape_owner_id,escape_marriage_id
    FROM character_rolls WHERE state='pending' AND command_message_id LIKE 'siren:%'`).all();
  for (const row of rows) {
    try {
      const channel = await client.channels.fetch(row.channel_id);
      await startForcedEscape({ db, channel, guildId: row.guild_id, channelId: row.channel_id,
        characterId: row.character_id, ownerId: row.escape_owner_id,
        marriageId: row.escape_marriage_id, pendingRollId: row.id });
    } catch { /* Durable effective target and spent costs are reused on the next recovery. */ }
  }
}

const forcedDeliveries = new WeakMap();
export async function startForcedEscape(options) {
  const { db, pendingRollId } = options;
  let busy = forcedDeliveries.get(db);
  if (!busy) { busy = new Set(); forcedDeliveries.set(db, busy); }
  const key = pendingRollId ?? options.commandMessageId ?? randomUUID();
  if (busy.has(key)) return { status: 'busy' };
  busy.add(key);
  try { return await deliverForcedEscape(options); }
  finally { busy.delete(key); }
}

async function deliverForcedEscape({ db, channel, guildId, channelId, commandMessageId,
  ownerId, characterId, marriageId = null, pendingRollId = null, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  cleanupRolls(db, now());
  const character = db.prepare(`SELECT id, name_full, rank, favourites, ${characterLikesProjection(db)}, gender, anime_titles, image_url,
    (SELECT tag_name FROM tag_decisions WHERE character_id = characters.id AND status = 'approve') AS tag_name
    FROM characters WHERE id = ?`).get(characterId);
  const marriage = character ? getMarriage(db, guildId, characterId) : null;
  if (!character || !marriage || marriage.ownerId !== ownerId
    || (marriageId != null && marriage.id !== marriageId)) return { status: 'unknown' };
  const pending = pendingRollId == null ? null : db.prepare(`SELECT id, rules_json FROM character_rolls WHERE id=? AND guild_id=?
    AND character_id=? AND escape_owner_id=? AND escape_marriage_id=? AND state='pending'`).get(pendingRollId, guildId, characterId, ownerId, marriage.id);
  if (pendingRollId != null && !pending) return { status: 'unknown' };
  if (!pending && isCharacterBusy(db, guildId, characterId, now())) return { status: 'busy' };
  if (isCharacterLocked(db, guildId, characterId, now()).locked) return { status: 'locked' };
  const invocation = commandMessageId ?? `item:${randomUUID()}`;
  if (db.prepare('SELECT 1 FROM character_rolls WHERE command_message_id = ?').get(invocation)) {
    return { status: 'duplicate' };
  }

  const remaining = getRollStatus(db, guildId, ownerId, now()).remaining;
  const windows = pending?.rules_json ? JSON.parse(pending.rules_json) : getGameConfig(db, guildId).windows;
  const side = windows.escapeProtectionMs;
  if (pending) db.prepare('UPDATE character_rolls SET channel_id=? WHERE id=?').run(channelId, pending.id);
  const rollId = pending?.id ?? Number(db.prepare(`INSERT INTO character_rolls
    (guild_id, channel_id, command_message_id, character_id, character_name, state,
      escape_marriage_id, escape_owner_id)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`)
    .run(guildId, channelId, invocation, character.id, character.name_full, marriage.id, ownerId).lastInsertRowid);

  if (!pending) db.prepare('UPDATE character_rolls SET rules_json=? WHERE id=?').run(JSON.stringify(windows), rollId);
  const wishUserIds = findWishMatchers(db, { guildId, characterId });
  let card;
  try {
    card = await channel.send(rollCard(character, { url: character.image_url }, remaining, {
      ownerId, protectedUntil: now() + side, phase: 'protected', ping: true,
    }, wishMark(wishUserIds)));
  } catch (error) {
    if (!pending) failRoll(db, rollId);
    throw error;
  }
  if (!publishRoll(db, rollId, card.id, now())) return { status: 'unknown' };
  if (await sealWithWhistle({ db, guildId, channelId, messageId: card.id, channel, ownerId,
    character, now })) return { status: 'sealed', character };
  startEscapeUpdates({ db, message: card, character, image: { url: character.image_url }, remaining,
    guildId, channelId, wishUserIds, now, setTimer, clearTimer });
  return { status: 'started', character };
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
      rollerId: message.author.id, remaining: reservation.remaining, commandMessageId: message.id });
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
  const wishUserIds = findWishMatchers(db, { guildId: message.guildId, characterId: character.id });
  let image = { url: character.image_url };
  try {
    image = await yoshiko.imagePicker.pick(message.guildId, character.id, character.tag_name, character.image_url);
  } catch (error) {
    console.error('Roll image lookup failed:', error);
  }
  let card;
  try {
    card = await message.reply(rollCard(character, image, remaining, reservation.escapeOwnerId ? {
      ownerId: reservation.escapeOwnerId, protectedUntil: now() + (reservation.windows?.escapeProtectionMs ?? 60_000), phase: 'protected', ping: true,
    } : null, wishMark(wishUserIds)));
  } catch (error) {
    failRoll(db, rollId);
    throw error;
  }
  let updates = null;
  if (reservation.escapeOwnerId) {
    // Publish first: the whistle (and any claim) resolves the card by message id.
    if (!publishRoll(db, rollId, card.id, now())) return;
    updates = startEscapeUpdates({ db, message: card, character, image, remaining,
      guildId: message.guildId, channelId: message.channelId, wishUserIds,
      now, setTimer, clearTimer });
    const sealed = await sealWithWhistle({ db, guildId: message.guildId,
      channelId: message.channelId, messageId: card.id, channel: message.channel,
      ownerId: reservation.escapeOwnerId, character, now })
      .catch((err) => { console.error('Golden whistle check failed:', err); return false; });
    if (sealed) await updates.refresh();
  } else if (!publishRoll(db, rollId, card.id, now())) return;
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
