import {
  ButtonBuilder, ButtonStyle, ContainerBuilder, escapeMarkdown,
  MediaGalleryBuilder, MediaGalleryItemBuilder, MessageFlags, TextDisplayBuilder,
} from 'discord.js';
import { characterSeries, hydrateCharacterFranchises } from './characterSeries.js';
import { getGameConfig } from './gameConfig.js';
import { reportCharacterGender } from './characterGenderReviews.js';
import { reportCharacterTag } from './catalogDb.js';
import { formatNumber } from './formatNumber.js';
import { characterLikesProjection } from './characterLikesProjection.js';
import { divorceCharacter, getMarriage, marryCharacter } from './characterMarriage.js';
import {
  claimRoll, claimRollInTransaction, failRoll, getReportableRoll, getRoll,
  markClaimNotice, publishRoll, refreshEscapeRoll,
} from '../features/rolls/rollLifecycleService.js';
import { loadRollCharacterSnapshot } from '../features/rolls/rollSnapshot.js';
import { getRollStatus } from '../features/rolls/rollAllowanceService.js';
import { cleanupRolls, recoverRolls, getRollAffectionFeedback } from './characterRolls.js';
import { reserveMysteryAwareRoll } from './mysteryCoordinator.js';
import { startMysteryRoll, updateMysteryPrizeStatus } from './mysteryRuntime.js';
import { startVaultRoll, publishVaultRewards } from './vaultRuntime.js';
import { getUsableInventory, isCharacterLocked } from './itemStorage.js';
import { findWishMatchers } from './characterWishlist.js';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { isCharacterBusy } from './characterAvailability.js';
import { captureCharacterSnapshot } from './characterSnapshot.js';
import { transaction } from './catalogDb.js';
import { loadRollDelivery, deliverReservedRoll } from './rollDelivery.js';

import { hasAffection, getAffectionBenefits } from './characterAffection.js';
import { spendAffectionItemChargeInTransaction } from './affectionItemUse.js';
import { flushAffectionRewardsInTransaction } from './affectionRewards.js';
import { affectionFeedback, appendCardNotice, WINDFALL_NOTICE } from './affectionPresentation.js';
import { wasWindfallRoll } from './affectionPerks.js';

const HEART = '❤️';
const escapeUpdates = new WeakMap();

/** @typedef {{phase: 'protected' | 'public', ownerId: string, protectedUntil?: number | null,
 *   ping?: boolean, outcome?: string | null, winnerId?: string | null}} EscapeCard */
/** @typedef {{userIds: string[], ping?: boolean}} WishMark */
/** @typedef {{now?: () => number, setTimer?: (callback: () => void, delay: number) => any,
 *   clearTimer?: (timer: any) => void}} RollClock */

/**
 * @param {EscapeCard | null} [escape]
 * @param {WishMark | null} [wishes] matching wishlist players, rendered as one line above the card
 * @param {{version: number, result: string, characterId: string | number, formerOwnerId: string, marriageId: number, ping?: boolean} | null} [cupidsMisfire]
 */
export function rollCard(character, image, remaining, escape = null, wishes = null, cupidsMisfire = null) {
  const wishedBy = wishes?.userIds ?? [];
  const container = new ContainerBuilder().setAccentColor(escape?.outcome === 'married'
    ? 0x8b4513 : wishedBy.length ? 0x57f287 : escape?.phase === 'protected' ? 0x9b59b6 : 0xe91e63)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`# ${escapeMarkdown(character.name_full)}`),
      new TextDisplayBuilder().setContent(escapeMarkdown(characterSeries(character).text)),
      new TextDisplayBuilder().setContent(`**Rank:** #${formatNumber(character.rank)}`),
    );
  if (image?.url) container.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(
    new MediaGalleryItemBuilder().setURL(image.url).setDescription(character.name_full),
  ));
  // Recovery has no durable historical allowance count; do not invent one.
  if (remaining != null) container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`-# ${remaining} roll${remaining === 1 ? '' : 's'} left`),
  );
  container.addActionRowComponents((row) => row.addComponents(
    new ButtonBuilder().setCustomId('roll:report').setLabel('Report tag').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('roll:gender-report').setLabel('Report gender').setStyle(ButtonStyle.Secondary),
  ));
  const components = [
    ...(cupidsMisfire ? [new TextDisplayBuilder().setContent(misfireText(character, cupidsMisfire))] : []),
    ...(escape ? [new TextDisplayBuilder().setContent(escapeText(character, escape))] : []),
    ...(wishedBy.length ? [new TextDisplayBuilder().setContent(wishText(wishedBy))] : []),
    container,
  ];
  return { flags: MessageFlags.IsComponentsV2, components,
    allowedMentions: { parse: [], repliedUser: false,
      users: [...new Set([...(escape?.ping ? [escape.ownerId] : []),
        ...(cupidsMisfire?.ping ? [cupidsMisfire.formerOwnerId] : []),
        ...(wishes?.ping === false ? [] : wishedBy)])] } };
}

function misfireText(character, effect) {
  if (effect.result === 'negated') return `♡ **Cupid's Misfire negated**\nThe owner's soulmate prevented the forced divorce. The armed Misfire was exhausted; the ordinary escape attempt continues.`;
  if (effect.result === 'blocked') return `🛡️ **Cupid's Misfire blocked**\n<@${effect.formerOwnerId}>'s **Mirror Shield** prevented the divorce. One Shield charge and your Cupid's Misfire effect were consumed.`;
  return `💔 **Cupid's Misfire**\n**${escapeMarkdown(character.name_full)}** has been forcibly divorced from <@${effect.formerOwnerId}>.\nAnyone with an available claim can marry them now—including their former owner.`;
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
  updates.get(message.id)?.stop?.();
  let queued = Promise.resolve();
  let timer;
  let stopped = false;
  function stop() {
    stopped = true;
    if (timer != null) clearTimer(timer);
    if (updates.get(message.id) === refresh) updates.delete(message.id);
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
        const payload = rollCard(character, image, remaining, { phase,
          ownerId: roll.escapeOwnerId, protectedUntil: roll.protectedUntil,
          outcome: roll.escapeOutcome, winnerId: roll.escapeWinnerId },
        wishUserIds.length ? { userIds: wishUserIds, ping: false } : null,
        roll.rulesJson ? JSON.parse(roll.rulesJson).cupidsMisfire : null);
        const feedback = affectionFeedback(getRollAffectionFeedback(db, roll.id), character.id, { showPlayer: true });
        if (feedback) payload.components.find(c=>c instanceof ContainerBuilder)
          ?.addTextDisplayComponents(text=>text.setContent(feedback));
        const roller = hasAffection(db) ? db.prepare('SELECT user_id FROM affection_requests WHERE source_key=?')
          .get(`roll:${guildId}:${roll.commandMessageId}`) : null;
        if (roller && wasWindfallRoll(db,guildId,roller.user_id,roll.commandMessageId)) appendCardNotice(payload,WINDFALL_NOTICE);
        await message.edit(payload);
        if (terminal) stop();
      } catch (error) {
        if (Number(error.code) === 10008) {
          failRoll(db, roll.id); // Deleted card: end attempt, preserve marriage/costs.
          stop();
        } else throw error;
      }
    }).catch((error) => console.error('Escape card update failed:', error));
    return queued;
  }
  function schedule() {
    const roll = getRoll(db, guildId, channelId, message.id);
    if (!roll || stopped) return;
    const next = roll.state !== 'open' ? now() + 5_000
      : now() < roll.protectedUntil ? roll.protectedUntil : roll.expiresAt;
    timer = setTimer(async () => {
      await refresh();
      if (!stopped) schedule();
    }, Math.max(0, next - now()));
    timer?.unref?.();
  }
  refresh.stop = stop;
  updates.set(message.id, refresh);
  const roll = getRoll(db, guildId, channelId, message.id);
  if (roll) schedule();
  return { refresh, stop };
}

function prankCard(prank, remaining) {
  const title = prank === 'dog_clap' ? 'ur roll gone' : 'john ate ur roll';
  const filename = `${prank}.gif`;
  const container = new ContainerBuilder().setAccentColor(0xe91e63)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`# ${title}`),
      new TextDisplayBuilder().setContent('- '),
      new TextDisplayBuilder().setContent('**Rank:** ?'),
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

function flushReclaimRewardsInTransaction(db,{guildId,ownerId,affection,now}) {
  const recipients=new Set([ownerId,...(affection?.awards ?? []).map(a=>a.userId)]);
  return [...recipients].flatMap(userId=>flushAffectionRewardsInTransaction(db,{guildId,userId,now}));
}

/** The Golden Whistle is passive: it seals an escape as soon as its card goes live. */
async function sealWithWhistle({ db, guildId, channelId, messageId, channel, ownerId, character,
  now = Date.now }) {
  const applied = transaction(db, () => {
    const roll = getRoll(db, guildId, channelId, messageId);
    if (!roll || roll.state !== 'open' || roll.escapeOwnerId !== ownerId) return null;
    const triggeredAt = now();
    const whistle = getUsableInventory(db, guildId, ownerId, triggeredAt).find((item) => item.item_id === 'golden_whistle');
    if (!whistle) return null;
    const chance = hasAffection(db) ? getAffectionBenefits(db, guildId, ownerId).perks.item_conservation : 0;
    const result = claimRollInTransaction(db, { guildId, channelId, messageId, userId: ownerId, now: triggeredAt });
    if (result.status !== 'reclaimed') return null;
    const paid = spendAffectionItemChargeInTransaction(db, { sourceKey: `whistle:${guildId}:${roll.commandMessageId ?? roll.id}`,
      guildId, userId: ownerId, inventoryId: whistle.id, chance, now: triggeredAt });
    const rewards = hasAffection(db) ? flushReclaimRewardsInTransaction(db, { guildId, ownerId, affection:result.affection, now: triggeredAt }) : [];
    return { left: paid.remainingCharges, conserved: paid.conserved, rewards, rollId:roll.id };
  });
  if (!applied) return false;
  const left = applied.left;
  // Forced escapes may not have a live updater; keep the reclaim gain visible here too.
  const feedback = escapeUpdates.get(db)?.has(messageId) ? '' : affectionFeedback(getRollAffectionFeedback(db,applied.rollId), character.id,{showPlayer:true});
  await channel.send({ content: `🔔 <@${ownerId}>'s **Golden Whistle** blew! **${character.name_full}** was automatically prevented from escaping. (${left} charge${left === 1 ? '' : 's'} remaining)${applied.conserved?'\nItem Conservation · no item charge spent':''}${feedback?`\n${feedback}`:''}`,
    allowedMentions: { users: [ownerId], parse: [], repliedUser: false } })
    .catch((error) => console.error('Golden whistle announcement failed:', error));
  await publishVaultRewards(db, channel.client ?? { channels: { fetch: async id=>{
    if (id!==channel.id) throw new Error('Reward belongs to another channel');
    return channel;
  } } }, applied.rewards, { now });
  return true;
}

const escapeRecoveries = new WeakMap();

/** Rebind existing cards only; never send, reroll, spend items, or replay whistles.
 * Legacy/invalid snapshots cancel without consulting mutable catalog defaults.
 * Transient fetch errors retain the attempt and retry; Discord 10008 fails it.
 * @param {RollClock & {retryMs?: number}} [clock]
 */
export async function recoverOpenEscapes(db, client, clock = {}) {
  const { now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, retryMs = 5_000 } = clock;
  let active = escapeRecoveries.get(db);
  if (!active) { active = new Map(); escapeRecoveries.set(db, active); }
  const results = [];
  for (const row of db.prepare(`SELECT id, guild_id, channel_id, message_id FROM character_rolls
    WHERE state='open' AND escape_marriage_id IS NOT NULL`).all()) {
    const key = row.id;
    if (active.has(key) || escapeUpdates.get(db)?.has(row.message_id)) continue;
    const entry = {};
    active.set(key, entry);
    const attempt = async () => {
      let character;
      try {
        character = loadRollCharacterSnapshot(db, key);
        const terms = getRoll(db, row.guild_id, row.channel_id, row.message_id);
        if (!character || !row.message_id || !terms?.escapeOwnerId
          || ![terms.publishedAt, terms.protectedUntil, terms.expiresAt].every(Number.isSafeInteger)
          || terms.publishedAt > terms.protectedUntil || terms.protectedUntil >= terms.expiresAt) {
          throw new Error('Missing durable escape terms');
        }
      } catch {
        db.prepare(`UPDATE character_rolls SET state='closed',escape_outcome='canceled',escape_resolved_at=?
          WHERE id=? AND state='open'`).run(now(), key);
        active.delete(key);
        return 'canceled';
      }
      // Settle before I/O even when Discord is unavailable. Deadlines never move.
      const roll = refreshEscapeRoll(db, row.guild_id, row.channel_id, row.message_id, now());
      if (!roll) { active.delete(key); return 'gone'; }
      try {
        const channel = await client.channels.fetch(row.channel_id);
        const message = await channel.messages.fetch(row.message_id);
        await sealWithWhistle({ db, guildId: row.guild_id, channelId: row.channel_id,
          messageId: row.message_id, channel, ownerId: roll.escapeOwnerId, character, now });
        const updates = startEscapeUpdates({ db, message, character,
          image: { url: character.image_url }, remaining: 0,
          guildId: row.guild_id, channelId: row.channel_id,
          wishUserIds: findWishMatchers(db, { guildId: row.guild_id, characterId: character.id }),
          now, setTimer, clearTimer });
        await updates.refresh();
        active.delete(key);
        return roll.state === 'open' ? 'recovered' : 'settled';
      } catch (error) {
        if (Number(error.code) === 10008) {
          failRoll(db, key);
          active.delete(key);
          return 'missing';
        }
        entry.timer = setTimer(() => attempt(), retryMs);
        entry.timer?.unref?.();
        return 'retrying';
      }
    };
    results.push({ rollId: key, status: await attempt() });
  }
  return results;
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
  // Validate durable terms before cleanup or any other state mutation.
  const storedCharacter = pendingRollId == null ? null : loadRollCharacterSnapshot(db, pendingRollId);
  const liveCharacter = db.prepare(`SELECT id, name_full, rank, favourites, ${characterLikesProjection(db)}, gender, anime_titles, image_url,
    (SELECT tag_name FROM tag_decisions WHERE character_id = characters.id AND status = 'approve') AS tag_name
    FROM characters WHERE id = ?`).get(characterId);
  const marriage = liveCharacter ? getMarriage(db, guildId, characterId) : null;
  if (!liveCharacter || !marriage || marriage.ownerId !== ownerId
    || (marriageId != null && marriage.id !== marriageId)) return { status: 'unknown' };
  const pending = pendingRollId == null ? null : db.prepare(`SELECT id, rules_json FROM character_rolls WHERE id=? AND guild_id=?
    AND character_id=? AND escape_owner_id=? AND escape_marriage_id=? AND state='pending'`).get(pendingRollId, guildId, characterId, ownerId, marriage.id);
  if (pendingRollId != null && !pending) return { status: 'unknown' };
  // Pending deliveries must have captured rules. Absence is not permission to
  // reprice a spent Siren using today's defaults, even on legacy schemas.
  const windows = pending ? JSON.parse(pending.rules_json ?? 'null') : getGameConfig(db, guildId).windows;
  if (!windows || !['escapeProtectionMs', 'escapeClaimMs'].every((key) =>
    Number.isSafeInteger(windows[key]) && windows[key] > 0)) {
    throw new Error('Invalid captured escape rules');
  }
  if (!storedCharacter) hydrateCharacterFranchises(db, [liveCharacter]);
  const character = storedCharacter ?? captureCharacterSnapshot(liveCharacter);
  cleanupRolls(db, now());
  if (!pending && isCharacterBusy(db, guildId, characterId, now())) return { status: 'busy' };
  if (isCharacterLocked(db, guildId, characterId, now()).locked) return { status: 'locked' };
  const invocation = commandMessageId ?? `item:${randomUUID()}`;
  if (!pending && db.prepare('SELECT 1 FROM character_rolls WHERE command_message_id = ?').get(invocation)) {
    return { status: 'duplicate' };
  }

  const remaining = getRollStatus(db, guildId, ownerId, now()).remaining;
  const side = windows.escapeProtectionMs;
  if (pending) db.prepare('UPDATE character_rolls SET channel_id=? WHERE id=?').run(channelId, pending.id);
  const rollId = pending?.id ?? Number(db.prepare(`INSERT INTO character_rolls
    (guild_id, channel_id, command_message_id, character_id, character_name, state,
      escape_marriage_id, escape_owner_id)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`)
    .run(guildId, channelId, invocation, character.id, character.name_full, marriage.id, ownerId).lastInsertRowid);

  if (!pending) db.prepare('UPDATE character_rolls SET rules_json=? WHERE id=?').run(JSON.stringify(windows), rollId);
  if (!storedCharacter && db.prepare('PRAGMA table_info(character_rolls)').all()
    .some((column) => column.name === 'character_snapshot_json')) {
    db.prepare('UPDATE character_rolls SET character_snapshot_json=?, character_name=? WHERE id=?')
      .run(JSON.stringify(character), character.name_full, rollId);
  }
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
    const payload = prankCard(reservation.prank, reservation.remaining);
    if (wasWindfallRoll(db,message.guildId,message.author.id,message.id)) appendCardNotice(payload,WINDFALL_NOTICE);
    await message.reply(payload);
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
  // Image lookup may yield to another writer. Reject corrupt durable terms
  // before publishing a card, not only later when opening its claim window.
  loadRollCharacterSnapshot(db, rollId);
  let card;
  // Final reservations retain delivery terms before the first asynchronous send.
  // A transport failure must not discard an already-consumed roll or buff.
  if (loadRollDelivery(db, rollId)) {
    db.prepare("UPDATE roll_delivery SET presentation_json=? WHERE roll_id=? AND phase='reserved'")
      .run(JSON.stringify({ image }), rollId);
    const result = await deliverReservedRoll(db, yoshiko.client, { rollId, channel: message.channel, now });
    if (result.status !== 'published') return;
    card = await message.channel.messages.fetch(result.messageId);
    if (reservation.ownAppearance) return;
  } else try {
    card = await message.reply(rollCard(character, image, remaining, reservation.escapeOwnerId ? {
      ownerId: reservation.escapeOwnerId, protectedUntil: now() + (reservation.windows?.escapeProtectionMs ?? 60_000), phase: 'protected', ping: true,
    } : null, wishMark(wishUserIds), reservation.cupidsMisfire
      ? { ...reservation.cupidsMisfire, ping: true } : null));
  } catch (error) {
    failRoll(db, rollId);
    throw error;
  }
  let updates = null;
  if (reservation.escapeOwnerId) {
    // Publish first: the whistle (and any claim) resolves the card by message id.
    if (getRoll(db, message.guildId, message.channelId, card.id)?.state !== 'open'
      && !publishRoll(db, rollId, card.id, now())) return;
    updates = startEscapeUpdates({ db, message: card, character, image, remaining,
      guildId: message.guildId, channelId: message.channelId, wishUserIds,
      now, setTimer, clearTimer });
    const sealed = await sealWithWhistle({ db, guildId: message.guildId,
      channelId: message.channelId, messageId: card.id, channel: message.channel,
      ownerId: reservation.escapeOwnerId, character, now })
      .catch((err) => { console.error('Golden whistle check failed:', err); return false; });
    if (sealed) await updates.refresh();
  } else if (getRoll(db, message.guildId, message.channelId, card.id)?.state !== 'open'
    && !publishRoll(db, rollId, card.id, now())) return;
  try {
    await card.react(HEART);
  } catch (error) {
    if (!loadRollDelivery(db, rollId)) failRoll(db, rollId);
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
  const rewards = result.status === 'reclaimed' && hasAffection(db) ? transaction(db, () =>
    flushReclaimRewardsInTransaction(db, { guildId, ownerId:user.id, affection:result.affection, now: Date.now() })) : [];
  // Ownership is already committed. Start confirmation independently so a
  // slow fetch/card edit (including a queued escape refresh) cannot delay it.
  const marriageNotice = result.status === 'married' ? (async () => {
    try {
      await message.channel.send({
        content: `<@${user.id}> has married **${escapeMarkdown(result.characterName)}** 🎉${result.claimConserved?'\nClaim Conservation · no claim spent':''}`,
        allowedMentions: { users: [user.id], roles: [], repliedUser: false },
      });
    } catch (error) {
      console.error('Marriage announcement failed:', error);
    }
  })() : null;
  const refreshEscape = escapeUpdates.get(db)?.get(message.id);
  if (['married', 'reclaimed', 'closed', 'expired'].includes(result.status)) {
    await refreshEscape?.();
  }
  if (result.status === 'reclaimed') {
    // The channel notice also covers restored/forced cards without a live updater.
    const roll = getRoll(db,guildId,channelId,message.id);
    const feedback = refreshEscape || !roll ? '' : affectionFeedback(getRollAffectionFeedback(db,roll.id), result.characterId,{showPlayer:true});
    if (feedback) await message.channel.send({ content: feedback,
      allowedMentions: { parse: [], repliedUser: false } }).catch(error=>console.error('Reclaim feedback failed:',error));
    await publishVaultRewards(db, yoshiko.client, rewards);
  }
  if (result.status === 'married') {
      try {
        const card = message.embeds?.length || message.components?.length || !message.fetch
          ? message : await message.fetch();
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
    await marriageNotice;
  } else if (result.status === 'exhausted' && markClaimNotice(db, result.rollId, user.id)) {
    await message.channel.send({
      content: `<@${user.id}> has no claim left. Next reset: <t:${Math.floor(result.resetAt / 1000)}:F>.`,
      allowedMentions: { users: [user.id], roles: [], repliedUser: false },
    }).catch((error) => console.error('Claim notice failed:', error));
  }
}

export async function onRollReport(db, interaction) {
  if (!interaction.isButton() || !['roll:report', 'roll:gender-report'].includes(interaction.customId)) return false;
  const roll = getReportableRoll(db, interaction.guildId, interaction.channelId, interaction.message.id);
  const gender = interaction.customId === 'roll:gender-report';
  const created = roll && (gender ? reportCharacterGender : reportCharacterTag)(db, roll.characterId, interaction.user.id);
  await interaction.reply({
    content: !roll ? 'This report button has expired.'
      : created ? `${gender ? 'Gender' : 'Tag'} report saved for review.` : 'You already reported this character, or it is no longer in the catalog.',
    flags: MessageFlags.Ephemeral,
  });
  return true;
}

export function recoverRollRuntime(db) {
  return recoverRolls(db).length;
}
