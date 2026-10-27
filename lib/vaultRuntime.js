import {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder,
  MediaGalleryBuilder, MediaGalleryItemBuilder, MessageFlags, StringSelectMenuBuilder, TextDisplayBuilder,
} from 'discord.js';
import { fileURLToPath } from 'node:url';
import { getGameConfig } from './gameConfig.js';
import { rollVaultOutcome, getResolvedItemDefinitions, getItemDefinition } from './itemRoster.js';
import { getInventory } from './itemStorage.js';
import { getVaultItemPresentation } from './itemDiscovery.js';
import {
  revealVaultReward, decideVaultReward, getVaultReward, bindVaultRewardMessage,
  markVaultRewardDelivered, reconcileVaultRewards,
} from './vaultRewards.js';

import {
  hasVaultSessions, reservePaidVaultSession, getVaultSession, getVaultSessionByCommand,
  drawVaultSessionOutcome, bindVaultSessionMessage, inspectVaultSessions,
} from './vaultSessions.js';

const VAULT_IMAGE = fileURLToPath(new URL('../assets/mystery_vault.png', import.meta.url));
const activeVaults = new Map();
const rewardTimers = new WeakMap();

export function vaultCard(remaining, vaultId, disabled = false) {
  const container = new ContainerBuilder().setAccentColor(0x5865f2)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent('# A mystery vault appears!'),
      new TextDisplayBuilder().setContent('*Choose one item, wisely...*'))
    .addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder()
      .setURL('attachment://mystery_vault.png').setDescription('Mystery Vault')))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${remaining} roll${remaining === 1 ? '' : 's'} left`))
    .addActionRowComponents(/** @type {ActionRowBuilder<ButtonBuilder>} */ (new ActionRowBuilder()).addComponents(['A', 'B', 'C'].map(label =>
      new ButtonBuilder().setCustomId(`vault:${vaultId}:${label}`).setLabel(label).setStyle(ButtonStyle.Primary).setDisabled(disabled))));
  const payload = { flags: MessageFlags.IsComponentsV2, components: [container], allowedMentions: { parse: [], repliedUser: false } };
  if (!disabled) payload.files = [new AttachmentBuilder(VAULT_IMAGE, { name: 'mystery_vault.png' })];
  return payload;
}

/**
 * @param {ActionRowBuilder<import('discord.js').MessageActionRowComponentBuilder> | null} [actionRow]
 * @param {string | null} [noticeText]
 */
export function vaultRewardCard(outcome, actionRow = null, noticeText = null) {
  const emoji = outcome.tierData.emoji ? `${outcome.tierData.emoji} ` : '';
  const container = new ContainerBuilder().setAccentColor(outcome.tierData.color);
  if (noticeText) container.addTextDisplayComponents(new TextDisplayBuilder().setContent(noticeText));
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`# ${emoji}${outcome.tierData.name}`),
    new TextDisplayBuilder().setContent(`**${outcome.item.name}** — ${outcome.item.description}`));
  if (actionRow) container.addActionRowComponents(actionRow);
  return container;
}
export const vaultRewardEmbed = vaultRewardCard;

/**
 * @param {{db: any, channel: any, guildId: string, rollerId: string, remaining: number,
 *   commandMessageId?: string, rollOutcome?: () => ReturnType<typeof rollVaultOutcome>, timeoutMs?: number,
 *   capturedOutcome?: ReturnType<typeof rollVaultOutcome>,
 *   now?: () => number, random?: () => number}} request
 */
export async function startVaultRoll({ db, channel, guildId, rollerId, remaining,
  commandMessageId, rollOutcome, timeoutMs, capturedOutcome,
  now = Date.now, random = Math.random }) {
  const durable = hasVaultSessions(db);
  if (!durable && db.prepare('PRAGMA user_version').get().user_version > 10) {
    throw new Error('Final catalog requires authoritative vault_sessions DDL');
  }
  // Callback fixtures are supported only by the legacy (schema <=10) path.
  if (durable) {
    if (rollOutcome) throw new Error('Durable vaults require capturedOutcome, not a callback');
    const session = (commandMessageId && getVaultSessionByCommand(db, commandMessageId)) ||
      reservePaidVaultSession(db, { guildId, rollerId, channelId: channel.id, remaining,
        commandMessageId, capturedOutcome, timeoutMs, now: now() });
    if (!session || session.guildId !== guildId || session.rollerId !== rollerId || session.channelId !== channel.id) {
      throw new Error('Vault reservation scope mismatch');
    }
    return publishVaultSession(db, session, channel, now);
  }
  const config = getGameConfig(db, guildId);
  // Explicit scripted vaults (Golden Hour) remain usable; enabled gates random drops.
  const roster = getResolvedItemDefinitions(db, guildId);
  const rules = config.itemActions;
  const weights = config.vault.tierWeights;
  const rewardPools = Object.fromEntries(['epic', 'legendary'].map(tier => [tier, roster.filter(item => item.tier === tier && item.rewardEligible)]));
  const drawOutcome = rollOutcome ?? (() => rollVaultOutcome(random, random, weights, roster));
  rollOutcome = () => ({ ...drawOutcome(), _rules: rules, _rewardPools: rewardPools });
  const vaultId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const card = vaultCard(remaining, vaultId);
  const message = await channel.send(commandMessageId
    ? { ...card, reply: { messageReference: commandMessageId, failIfNotExists: false } }
    : card);
  const session = { vaultId, db, message, guildId, rollerId, remaining, rollOutcome, now, random, handled: false,
    timer: setTimeout(async () => {
      if (!session.handled) {
        session.handled = true;
        try { await message.edit(vaultCard(remaining, vaultId, true)); } catch { /* Deleted card. */ }
      }
      activeVaults.delete(vaultId);
    }, timeoutMs ?? config.vault.openTimeoutMs) };
  session.timer.unref?.();
  activeVaults.set(vaultId, session);
  return { vaultId, message };
}

const sessionTimers = new WeakMap();
const sessionDeliveries = new WeakMap();
function scheduleVaultSession(db, session, message, now) {
  let timers = sessionTimers.get(db);
  if (!timers) { timers = new Map(); sessionTimers.set(db, timers); }
  clearTimeout(timers.get(session.vaultId));
  timers.delete(session.vaultId);
  if (session.state !== 'unopened') return;
  const timer = setTimeout(async () => {
    timers.delete(session.vaultId);
    try {
      inspectVaultSessions(db, { now: now() });
      const current = getVaultSession(db, session.vaultId);
      if (!current) return;
      if (current.state === 'expired') {
        await message.edit(vaultCard(current.remaining, current.vaultId, true));
        bindVaultSessionMessage(db, current.vaultId, message.id, message.id, now());
      } else if (current.state === 'unopened') scheduleVaultSession(db, current, message, now);
    } catch { /* Periodic recovery retries without moving the original deadline. */ }
  }, Math.max(1, session.deadline - now()));
  timer.unref?.();
  timers.set(session.vaultId, timer);
}

async function publishVaultSession(db, session, channel, now) {
  let deliveries = sessionDeliveries.get(db);
  if (!deliveries) { deliveries = new Map(); sessionDeliveries.set(db, deliveries); }
  if (deliveries.has(session.vaultId)) return deliveries.get(session.vaultId);
  const work = deliverVaultSession(db, session, channel, now);
  deliveries.set(session.vaultId, work);
  try { return await work; } finally { deliveries.delete(session.vaultId); }
}

async function deliverVaultSession(db, session, channel, now) {
  inspectVaultSessions(db, { now: now() });
  session = getVaultSession(db, session.vaultId);
  if (session.state === 'revealed') return { vaultId: session.vaultId, message: null };
  let message;
  if (session.messageId) {
    try { message = await channel.messages.fetch(session.messageId); }
    catch (error) { if (error.code !== 10008) throw error; }
  }
  const disabled = session.state !== 'unopened';
  if (message) {
    await message.edit(vaultCard(session.remaining, session.vaultId, disabled));
  } else {
    const card = vaultCard(session.remaining, session.vaultId, disabled);
    // A replacement still needs the attachment referenced by the disabled card.
    if (disabled) card.files = [new AttachmentBuilder(VAULT_IMAGE, { name: 'mystery_vault.png' })];
    message = await channel.send({ ...card, nonce: session.vaultId.replaceAll('-', '').slice(0, 24), enforceNonce: true,
      ...(session.commandMessageId && /^\d+$/.test(session.commandMessageId)
        ? { reply: { messageReference: session.commandMessageId, failIfNotExists: false } } : {}) });
  }
  const bound = bindVaultSessionMessage(db, session.vaultId, message.id, session.messageId, now());
  if (bound?.messageId === message.id) scheduleVaultSession(db, bound, message, now);
  return { vaultId: session.vaultId, message };
}

/** Startup/periodic guard entry point. No payment, reroll, or deadline extension. */
export async function recoverVaultSessions(db, client, { now = Date.now } = {}) {
  const pending = inspectVaultSessions(db, { now: now() });
  for (const session of pending) {
    try {
      const channel = await client.channels.fetch(session.channelId);
      await publishVaultSession(db, session, channel, now);
    } catch { /* A transient failure must never authorize a replacement or reset time. */ }
  }
  await recoverVaultRewards(db, client, { now });
  return pending;
}

function payloadForReward(db, reward, page = 0) {
  const storedOutcome = reward.reward ?? reward.original;
  const outcome = { ...storedOutcome,
    item: getVaultItemPresentation(db, reward.guildId, storedOutcome.item) };
  /** @type {ActionRowBuilder<import('discord.js').MessageActionRowComponentBuilder> | null} */
  let row = null;
  let notice;
  if (reward.state === 'decision') {
    notice = `<@${reward.userId}>, keep this revealed reward or spend Double or Nothing to gamble? Only you may decide. Keep is automatic <t:${Math.floor(reward.deadline / 1000)}:R>.`;
    row = /** @type {ActionRowBuilder<ButtonBuilder>} */ (new ActionRowBuilder()).addComponents(
      new ButtonBuilder().setCustomId(`vault:${reward.vaultId}:keep`).setLabel('Keep').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`vault:${reward.vaultId}:gamble`).setLabel('Gamble').setStyle(ButtonStyle.Danger));
  } else if (reward.state === 'overflow') {
    const inv = getInventory(db, reward.guildId, reward.userId);
    const pages = Math.max(1, Math.ceil(inv.length / 22));
    page = Math.max(0, Math.min(pages - 1, page));
    const options = inv.slice(page * 22, (page + 1) * 22).map(entry => ({
      label: `${getItemDefinition(entry.item_id)?.name ?? entry.item_id} (${entry.charges} charges)`.slice(0, 100), value: String(entry.id),
    }));
    options.push({ label: 'Decline new item (keep current inventory)', value: '-1' },
      { label: 'Take reward if space is now available', value: 'accept' });
    if (pages > 1) options.push({ label: 'Next inventory page', value: `page_${(page + 1) % pages}` });
    row = /** @type {ActionRowBuilder<StringSelectMenuBuilder>} */ (new ActionRowBuilder()).addComponents(new StringSelectMenuBuilder()
      .setCustomId(`vault:${reward.vaultId}:replace`).setPlaceholder('Choose an item to discard, or decline').addOptions(options));
    notice = `⚠️ <@${reward.userId}>'s inventory is full! Only the roller may replace an item or decline. This reward remains pending.`;
  } else if (reward.state === 'lost') {
    notice = `<@${reward.userId}> gambled and lost. Double or Nothing and the original reward are gone.`;
  } else if (reward.state === 'declined') {
    notice = `<@${reward.userId}> declined this reward.`;
  } else {
    notice = `🎉 <@${reward.userId}> received **${outcome.item.name}**! Added to your inventory. (Type \`!inv\` to view)`;
  }
  return { flags: MessageFlags.IsComponentsV2, components: [vaultRewardCard(outcome, row, notice)],
    allowedMentions: { parse: [], repliedUser: false } };
}

function scopeFrom(interaction) {
  return { guildId: interaction.guildId, userId: interaction.user.id,
    channelId: interaction.channelId ?? interaction.channel?.id ?? interaction.message?.channelId,
    messageId: interaction.message?.id };
}
function authorized(reward, scope) {
  return reward && reward.guildId === scope.guildId && reward.userId === scope.userId &&
    reward.channelId === scope.channelId && reward.messageId === scope.messageId;
}
function scheduleReward(db, reward, message, now = Date.now) {
  let timers = rewardTimers.get(db);
  if (!timers) { timers = new Map(); rewardTimers.set(db, timers); }
  clearTimeout(timers.get(reward.vaultId));
  timers.delete(reward.vaultId);
  if (reward.state !== 'decision') return;
  const timer = setTimeout(async () => {
    timers.delete(reward.vaultId);
    try {
      reconcileVaultRewards(db, { now: now() });
      const updated = getVaultReward(db, reward.vaultId);
      if (!updated) return;
      await message.edit(payloadForReward(db, updated));
      markVaultRewardDelivered(db, reward.vaultId, now());
      if (updated.state === 'decision') scheduleReward(db, updated, message, now);
    } catch { /* Periodic recovery retries failures; game state is durable. */ }
  }, Math.max(1, reward.deadline - now()));
  timer.unref?.();
  timers.set(reward.vaultId, timer);
}

/** Call after ready and periodically. One inaccessible channel cannot stop recovery. */
export async function recoverVaultRewards(db, client, { now = Date.now } = {}) {
  const pending = reconcileVaultRewards(db, { now: now() });
  for (const reward of pending) {
    try {
      const channel = await client.channels.fetch(reward.channelId);
      let message;
      if (reward.messageId) {
        try {
          message = await channel.messages.fetch(reward.messageId);
          await message.edit(payloadForReward(db, reward));
        } catch (error) {
          // Only a definitive deleted-message response permits prompt replacement.
          if (error.code !== 10008) throw error;
          message = await channel.send(payloadForReward(db, reward));
          bindVaultRewardMessage(db, reward.vaultId, reward.channelId, message.id, reward.messageId);
        }
      } else {
        message = await channel.send(payloadForReward(db, reward));
        bindVaultRewardMessage(db, reward.vaultId, reward.channelId, message.id);
      }
      markVaultRewardDelivered(db, reward.vaultId, now());
      scheduleReward(db, getVaultReward(db, reward.vaultId), message, now);
    } catch { /* Never replay a committed reward because an announcement failed. */ }
  }
  return pending;
}

export async function onVaultInteraction(db, interaction, { now = Date.now, random = Math.random } = {}) {
  if (!interaction.isButton() && !interaction.isStringSelectMenu()) return false;
  const parts = interaction.customId.split(':');
  if (parts[0] !== 'vault') return false;
  const [, vaultId, action] = parts;
  const reject = async content => {
    await interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    return true;
  };
  const scope = scopeFrom(interaction);
  if (['keep', 'gamble', 'replace'].includes(action)) {
    const reward = getVaultReward(db, vaultId);
    if (!reward || parts.length !== 3 || !authorized(reward, scope)) return reject('This reward control is stale or belongs to another roller, server, or message.');
    if ((action === 'replace') !== interaction.isStringSelectMenu()) return reject('Invalid reward control.');
    const value = interaction.values?.[0];
    if (action === 'replace' && /^page_\d+$/.test(value ?? '') && reward.state === 'overflow') {
      await interaction.update(payloadForReward(db, reward, Number(value.slice(5))));
      return true;
    }
    const operation = action === 'replace' ? (value === '-1' ? 'decline' : value === 'accept' ? 'accept' : 'replace') : action;
    const result = decideVaultReward(db, { vaultId, ...scope, action: operation,
      inventoryId: value && /^\d+$/.test(value) ? Number(value) : undefined, now: now(), random });
    if (['stale', 'invalid', 'forbidden', 'invalid_inventory', 'missing_item'].includes(result.status)) {
      return reject(result.status === 'missing_item' ? 'Double or Nothing is no longer available. You may still Keep before the original deadline.' : 'This choice is stale or the selected inventory entry is unavailable.');
    }
    await interaction.update(payloadForReward(db, result.reward));
    markVaultRewardDelivered(db, vaultId, now());
    scheduleReward(db, result.reward, interaction.message, now);
    return true;
  }
  if (!['A', 'B', 'C'].includes(action) || parts.length !== 3 || !interaction.isButton()) return reject('Invalid vault control.');
  const durable = hasVaultSessions(db) ? getVaultSession(db, vaultId) : null;
  if (durable) {
    if (scope.userId !== durable.rollerId || scope.guildId !== durable.guildId ||
        scope.channelId !== durable.channelId || scope.messageId !== durable.messageId) {
      return reject('This vault control belongs to another roller, server, or message.');
    }
    // The insert trigger links vault_rewards in its own reveal transaction. A duplicate
    // click never draws again, even when the first Discord acknowledgement failed.
    let reward = getVaultReward(db, vaultId);
    if (!reward) {
      if (durable.state !== 'unopened' || now() >= durable.deadline) {
        inspectVaultSessions(db, { now: now() });
        return reject('This mystery vault has already expired or been claimed.');
      }
      reward = revealVaultReward(db, { vaultId, guildId: durable.guildId, userId: durable.rollerId,
        channelId: durable.channelId, sourceMessageId: durable.messageId, messageId: durable.messageId,
        outcome: drawVaultSessionOutcome(durable, random), now: now() });
    }
    // Edit the canonical source instead of creating another prompt on each click.
    reward = bindVaultRewardMessage(db, vaultId, durable.channelId, durable.messageId);
    if (!reward || reward.messageId !== durable.messageId) {
      return reject('This vault has already been selected. Use its reward controls.');
    }
    await interaction.update(payloadForReward(db, reward));
    markVaultRewardDelivered(db, vaultId, now());
    scheduleReward(db, reward, interaction.message, now);
    return true;
  }
  const session = activeVaults.get(vaultId);
  if (!session || session.db !== db) return reject('This mystery vault has already expired or been claimed.');
  if (scope.userId !== session.rollerId) return reject('Only the roller who summoned the vault may choose an item.');
  if (scope.guildId !== session.guildId || scope.channelId !== session.message.channelId || scope.messageId !== session.message.id) {
    return reject('This vault control belongs to another server or message.');
  }
  if (session.handled) return reject('An item from this vault has already been selected.');
  const reward = revealVaultReward(db, { vaultId, guildId: session.guildId, userId: session.rollerId,
    channelId: scope.channelId, sourceMessageId: session.message.id, outcome: session.rollOutcome(), now: session.now() });
  session.handled = true;
  clearTimeout(session.timer);
  activeVaults.delete(vaultId);
  await interaction.reply(payloadForReward(db, reward));
  let prompt;
  try { prompt = await interaction.fetchReply?.(); } catch { /* Recovery publishes an unbound reward. */ }
  if (prompt?.id) {
    const bound = bindVaultRewardMessage(db, vaultId, scope.channelId, prompt.id);
    markVaultRewardDelivered(db, vaultId, session.now());
    scheduleReward(db, bound, prompt, session.now);
  } else if (!['decision', 'overflow'].includes(reward.state)) {
    markVaultRewardDelivered(db, vaultId, session.now());
  }
  try { await session.message.edit(vaultCard(session.remaining, vaultId, true)); } catch { /* Deleted card. */ }
  return true;
}
