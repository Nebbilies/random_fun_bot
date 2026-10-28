import {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder,
  MediaGalleryBuilder, MediaGalleryItemBuilder, MessageFlags, StringSelectMenuBuilder, TextDisplayBuilder,
} from 'discord.js';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { getGameConfig } from './gameConfig.js';
import { rollVaultOutcome, getResolvedItemDefinitions, getItemDefinition } from './itemRoster.js';
import { getLens, activateLens, acknowledgeLens, refundUnpresentedLens, getRecast, presentRecast } from './vaultFortune.js';
import { getUsableInventory } from './itemStorage.js';
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

/** @param {number} remaining @param {string} vaultId @param {boolean} disabled @param {boolean} canUseLens @param {any} lens */
export function vaultCard(remaining, vaultId, disabled = false, canUseLens = false, lens = null) {
  const container = new ContainerBuilder().setAccentColor(0x5865f2)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent('# A mystery vault appears!'),
      new TextDisplayBuilder().setContent('*Choose one item, wisely...*'))
    .addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder()
      .setURL('attachment://mystery_vault.png').setDescription('Mystery Vault')))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${remaining} roll${remaining === 1 ? '' : 's'} left`))
    .addActionRowComponents(/** @type {ActionRowBuilder<ButtonBuilder>} */ (new ActionRowBuilder()).addComponents(['A', 'B', 'C'].map(label =>
      new ButtonBuilder().setCustomId(`vault:${vaultId}:${label}`).setLabel(label).setStyle(ButtonStyle.Primary).setDisabled(disabled))));
  if (lens && lens.state !== 'refunded') container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
    `-# Fortune Lens v1 · ${vaultId}\n` + lens.candidates.map((outcome, index) => `**${['A', 'B', 'C'][index]}: ${outcome.item.name}** (${outcome.tierData.name}) — ${outcome.item.description}`).join('\n')));
  if (canUseLens && !lens && !disabled) container.addActionRowComponents(/** @type {ActionRowBuilder<ButtonBuilder>} */ (new ActionRowBuilder()).addComponents(
    new ButtonBuilder().setCustomId(`vault:${vaultId}:lens`).setLabel('Use Fortune’s Lens').setStyle(ButtonStyle.Secondary)));
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
// Every canonical-card writer uses this queue, including interactions and timers.
// Helpers called inside a queued operation must not acquire it again.
const vaultWrites = new WeakMap();
async function withVaultWrite(db, vaultId, operation) {
  let writes = vaultWrites.get(db);
  if (!writes) { writes = new Map(); vaultWrites.set(db, writes); }
  const previous = writes.get(vaultId) ?? Promise.resolve();
  const work = previous.catch(() => {}).then(operation);
  writes.set(vaultId, work);
  try { return await work; }
  finally { if (writes.get(vaultId) === work) writes.delete(vaultId); }
}
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
        // Fetch/reconcile the canonical reveal before disabling or refunding it.
        await publishVaultSession(db, current, message.channel ?? { messages: { fetch: async () => message } }, now);
      } else if (current.state === 'unopened') scheduleVaultSession(db, current, message, now);
    } catch { /* Periodic recovery retries without moving the original deadline. */ }
  }, Math.max(1, session.deadline - now()));
  timer.unref?.();
  timers.set(session.vaultId, timer);
}

async function publishVaultSession(db, session, channel, now) {
  return withVaultWrite(db, session.vaultId, () => deliverVaultSession(db, session, channel, now));
}

async function deliverVaultSession(db, session, channel, now) {
  inspectVaultSessions(db, { now: now() });
  session = getVaultSession(db, session.vaultId);
  if (session.state === 'revealed') return { vaultId: session.vaultId, message: null };
  let message;
  if (session.messageId) {
    try { message = await channel.messages.fetch({ message: session.messageId, force: true }); }
    catch (error) { if (error.code !== 10008) throw error; }
  }
  const disabled = session.state !== 'unopened';
  let lens = getLens(db, session.vaultId);
  if (lens?.state === 'pending') {
    // Inspect before overwriting: an edit can have succeeded before its DB acknowledgement.
    const shown = message && JSON.stringify(message.components ?? message.payload?.components ?? []).includes(`Fortune Lens v1 · ${session.vaultId}`);
    if (shown) acknowledgeLens(db, session.vaultId, now());
    else if (disabled) refundUnpresentedLens(db, session.vaultId, { absent: true, now: now() });
    lens = getLens(db, session.vaultId);
  }
  // Fortune-compatible terms alone do not entitle the roller to a Lens control.
  // Recheck live inventory on publication/recovery; another vault may have spent it.
  const canUseLens = !disabled && !lens && session.captured.fortuneVersion === 1
    && getUsableInventory(db, session.guildId, session.rollerId).some(item => item.item_id === 'fortunes_lens');
  const cardForSession = () => vaultCard(session.remaining, session.vaultId, disabled, canUseLens, presentedLens(db, session.guildId, lens));
  if (message) {
    await message.edit(cardForSession());
  } else {
    const card = cardForSession();
    // A replacement still needs the attachment referenced by the disabled card.
    if (disabled) card.files = [new AttachmentBuilder(VAULT_IMAGE, { name: 'mystery_vault.png' })];
    message = await channel.send({ ...card, nonce: session.vaultId.replaceAll('-', '').slice(0, 24), enforceNonce: true,
      ...(session.commandMessageId && /^\d+$/.test(session.commandMessageId)
        ? { reply: { messageReference: session.commandMessageId, failIfNotExists: false } } : {}) });
  }
  if (!disabled && lens?.state === 'pending') acknowledgeLens(db, session.vaultId, now());
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

function presentedLens(db, guildId, lens) {
  return lens && { ...lens, candidates: lens.candidates.map(outcome => ({ ...outcome,
    item: getVaultItemPresentation(db, guildId, outcome.item) })) };
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
  } else if (reward.state === 'recast') {
    notice = `<@${reward.userId}>, a private Recast choice is waiting. Open it below; alternatives are never posted publicly.`;
    row = /** @type {ActionRowBuilder<ButtonBuilder>} */ (new ActionRowBuilder()).addComponents(new ButtonBuilder().setCustomId(`vault:${reward.vaultId}:recastopen`).setLabel('Open Recast choice').setStyle(ButtonStyle.Primary));
  } else if (reward.state === 'overflow') {
    const inv = getUsableInventory(db, reward.guildId, reward.userId);
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

// DB-only reconciliation can advance another vault while a transport write awaits.
// Do not acknowledge a stale publication: catch up before releasing this vault's queue.
async function writeLatestReward(db, vaultId, write, page = 0) {
  let reward = getVaultReward(db, vaultId);
  while (reward) {
    const payload = payloadForReward(db, reward, page);
    await write(payload);
    reward = getVaultReward(db, vaultId);
    if (JSON.stringify(payload) === JSON.stringify(payloadForReward(db, reward, page))) return reward;
  }
  return reward;
}

function updateRewardInteraction(db, vaultId, interaction, page = 0) {
  let acknowledged = false;
  return writeLatestReward(db, vaultId, async payload => {
    if (acknowledged) return interaction.message.edit(payload);
    acknowledged = true;
    return interaction.update(payload);
  }, page);
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
  const recast = reward.state === 'recast' ? getRecast(db, reward.vaultId) : null;
  const deadline = recast?.deadline ?? reward.deadline;
  if (reward.state !== 'decision' && !(recast?.state === 'presented')) return;
  const timer = setTimeout(async () => {
    timers.delete(reward.vaultId);
    try {
      await withVaultWrite(db, reward.vaultId, async () => {
        reconcileVaultRewards(db, { now: now() });
        const updated = getVaultReward(db, reward.vaultId);
        if (!updated) return;
        await writeLatestReward(db, reward.vaultId, payload => message.edit(payload));
        markVaultRewardDelivered(db, reward.vaultId, now());
        if (['decision', 'recast'].includes(updated.state)) scheduleReward(db, updated, message, now);
      });
    } catch { /* Periodic recovery retries failures; game state is durable. */ }
  }, Math.max(1, deadline - now()));
  timer.unref?.();
  timers.set(reward.vaultId, timer);
}

// Called inside the vault write queue by both selection and recovery.
async function deliverRewardMessage(db, reward, channel, now) {
  const session = hasVaultSessions(db) ? getVaultSession(db, reward.vaultId) : null;
  // Historical rewards bound to the source remain valid same-message cards.
  if (session && reward.sourceMessageId && reward.messageId !== reward.sourceMessageId) {
    let source;
    try { source = await channel.messages.fetch({ message: reward.sourceMessageId, force: true }); }
    catch (error) { if (error.code !== 10008) throw error; }
    if (source) {
      // A delivered reward may be retried after a crash; never leave the old
      // A/B/C controls active, but avoid an unnecessary edit on every scan.
      const serialized = JSON.stringify(source.components ?? source.payload?.components ?? []);
      if (!serialized.includes('"disabled":true')) await source.edit(vaultCard(session.remaining, session.vaultId, true, false,
        presentedLens(db, session.guildId, getLens(db, session.vaultId))));
    }
  }
  let message;
  if (reward.messageId) {
    try { message = await channel.messages.fetch(reward.messageId); }
    catch (error) { if (error.code !== 10008) throw error; }
  }
  if (!message) {
    // Stable across send-success/response-loss retries, distinct from the source
    // nonce and from replacements of definitively deleted reward messages.
    const nonce = createHash('sha256').update(`reward:${reward.vaultId}:${reward.messageId ?? ''}`).digest('hex').slice(0, 24);
    message = await channel.send({ ...payloadForReward(db, reward), nonce, enforceNonce: true });
    reward = bindVaultRewardMessage(db, reward.vaultId, reward.channelId, message.id, reward.messageId);
  }
  await writeLatestReward(db, reward.vaultId, payload => message.edit(payload));
  if (getLens(db, reward.vaultId)?.state === 'pending') acknowledgeLens(db, reward.vaultId, now());
  markVaultRewardDelivered(db, reward.vaultId, now());
  scheduleReward(db, getVaultReward(db, reward.vaultId), message, now);
  return message;
}

/** Call after ready and periodically. One inaccessible channel cannot stop recovery. */
export async function recoverVaultRewards(db, client, { now = Date.now } = {}) {
  const pending = reconcileVaultRewards(db, { now: now() });
  for (let reward of pending) {
    try {
      await withVaultWrite(db, reward.vaultId, async () => {
        const channel = await client.channels.fetch(reward.channelId);
        // The scan may have queued behind an interaction. Never publish its stale snapshot.
        reward = getVaultReward(db, reward.vaultId);
        await deliverRewardMessage(db, reward, channel, now);
      });
    } catch { /* Never replay a committed reward because an announcement failed. */ }
  }
  return pending;
}

function privateRecastPayload(decision, publicMessageId) {
  const options = [{ label: `Keep ${decision.original.item.name}`.slice(0, 100), value: '-1' },
    ...decision.alternatives.map((item, index) => ({ label: item.name.slice(0, 100), description: item.description.slice(0, 100), value: String(index) }))];
  const container = new ContainerBuilder().setAccentColor(decision.original.tierData.color)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`# Fortune's Recast\nKeep **${decision.original.item.name}** or select a same-tier alternative.\n${decision.deadline ? `Keep is automatic <t:${Math.floor(decision.deadline / 1000)}:R>.` : 'The decision window starts when this private choice is presented.'}`))
    .addActionRowComponents(/** @type {ActionRowBuilder<StringSelectMenuBuilder>} */ (new ActionRowBuilder()).addComponents(new StringSelectMenuBuilder()
      .setCustomId(`vault:${decision.vault_id}:recastchoice:${publicMessageId}`).setPlaceholder('Keep or Recast').addOptions(options)));
  return { flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral, components: [container], allowedMentions: { parse: [] } };
}
function followUpRecastAdapter(interaction, message = interaction.message) {
  const followUp = interaction.followUp.bind(interaction);
  let privateMessage;
  return {
    message,
    reply: async payload => { privateMessage = await followUp(payload); },
    editReply: async payload => { await interaction.webhook.editMessage(privateMessage.id, payload); },
  };
}

async function openPrivateRecast(db, interaction, reward, now) {
  const decision = getRecast(db, reward.vaultId);
  if (!decision || decision.state === 'chosen') return;
  // Persisted candidates precede publication; charge and deadline follow confirmed send.
  await interaction.reply(privateRecastPayload(decision, reward.messageId));
  const presented = presentRecast(db, { vaultId: reward.vaultId, guildId: reward.guildId, userId: reward.userId,
    channelId: reward.channelId, messageId: reward.messageId, now: now() });
  if (presented.decision) {
    try { await interaction.editReply?.(privateRecastPayload(presented.decision, reward.messageId)); } catch { /* Same durable choice remains resumable. */ }
  }
  scheduleReward(db, reward, interaction.message, now);
}
export async function onVaultInteraction(db, interaction, options = {}) {
  if (!interaction.isButton() && !interaction.isStringSelectMenu()) return false;
  const [prefix, vaultId] = interaction.customId.split(':');
  if (prefix !== 'vault') return false;
  return withVaultWrite(db, vaultId, () => handleVaultInteraction(db, interaction, options));
}

async function handleVaultInteraction(db, interaction, { now = Date.now, random = Math.random } = {}) {
  if (!interaction.isButton() && !interaction.isStringSelectMenu()) return false;
  const parts = interaction.customId.split(':');
  if (parts[0] !== 'vault') return false;
  const [, vaultId, action] = parts;
  const reject = async content => {
    await interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    return true;
  };
  const scope = scopeFrom(interaction);
  if (action === 'recastopen' && parts.length === 3 && interaction.isButton()) {
    reconcileVaultRewards(db, { now: now() });
    const reward = getVaultReward(db, vaultId);
    if (!reward || !authorized(reward, scope) || reward.state !== 'recast') return reject('This private choice is stale or belongs to another roller or message.');
    await openPrivateRecast(db, interaction, reward, now);
    return true;
  }
  if (action === 'recastchoice' && parts.length === 4 && interaction.isStringSelectMenu()) {
    const reward = getVaultReward(db, vaultId);
    const canonicalScope = { ...scope, messageId: parts[3] };
    if (!reward || !authorized(reward, canonicalScope) || reward.state !== 'recast') return reject('This private choice is stale or belongs to another roller.');
    // Private messages have different IDs. Verify the live canonical public binding, not the ephemeral ID.
    let publicMessage;
    try { publicMessage = await interaction.channel.messages.fetch(reward.messageId); }
    catch { return reject('The public reward could not be verified. Reopen the choice from its current card.'); }
    const value = interaction.values?.[0];
    if (!/^-1$|^[0-2]$/.test(value ?? '')) return reject('Invalid Recast choice.');
    const result = decideVaultReward(db, { vaultId, ...canonicalScope, action: 'recast', choice: Number(value), now: now() });
    if (result.status !== 'resolved') return reject('This Recast choice is no longer available.');
    await interaction.update({ flags: MessageFlags.IsComponentsV2, components: [new ContainerBuilder()
      .addTextDisplayComponents(new TextDisplayBuilder().setContent('Recast choice saved. Your public reward card shows delivery status.'))] });
    try {
      await writeLatestReward(db, vaultId, payload => publicMessage.edit(payload));
      markVaultRewardDelivered(db, vaultId, now());
    } catch { /* Delivery publication is recovered independently. */ }
    return true;
  }
  if (['keep', 'gamble', 'replace'].includes(action)) {
    const reward = getVaultReward(db, vaultId);
    if (!reward || parts.length !== 3 || !authorized(reward, scope)) return reject('This reward control is stale or belongs to another roller, server, or message.');
    if ((action === 'replace') !== interaction.isStringSelectMenu()) return reject('Invalid reward control.');
    const value = interaction.values?.[0];
    if (action === 'replace' && /^page_\d+$/.test(value ?? '') && reward.state === 'overflow') {
      await updateRewardInteraction(db, vaultId, interaction, Number(value.slice(5)));
      return true;
    }
    const operation = action === 'replace' ? (value === '-1' ? 'decline' : value === 'accept' ? 'accept' : 'replace') : action;
    const result = decideVaultReward(db, { vaultId, ...scope, action: operation,
      inventoryId: value && /^\d+$/.test(value) ? Number(value) : undefined, now: now(), random });
    if (['stale', 'invalid', 'forbidden', 'invalid_inventory', 'missing_item'].includes(result.status)) {
      return reject(result.status === 'missing_item' ? 'Double or Nothing is no longer available. You may still Keep before the original deadline.' : 'This choice is stale or the selected inventory entry is unavailable.');
    }
    await updateRewardInteraction(db, vaultId, interaction);
    markVaultRewardDelivered(db, vaultId, now());
    scheduleReward(db, result.reward, interaction.message, now);
    if (result.reward.state === 'recast' && interaction.followUp) {
      try { await openPrivateRecast(db, followUpRecastAdapter(interaction), result.reward, now); }
      catch { /* Public resume control retains the pending, unspent choice. */ }
    }
    return true;
  }
  if (action === 'lens' && parts.length === 3 && interaction.isButton()) {
    const result = activateLens(db, { vaultId, ...scope, now: now(), random });
    if (!['revealed', 'existing'].includes(result.status)) return reject('Lens is unavailable on this vault, or this control is stale. No charge was spent.');
    const session = getVaultSession(db, vaultId);
    if (!session) return reject('This vault is no longer available.');
    await interaction.update(vaultCard(session.remaining, vaultId, false, true, presentedLens(db, session.guildId, result.lens)));
    acknowledgeLens(db, vaultId, now());
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
        channelId: durable.channelId, sourceMessageId: durable.messageId,
        outcome: getLens(db, vaultId)?.candidates[['A', 'B', 'C'].indexOf(action)] ?? drawVaultSessionOutcome(durable, random), now: now() });
    }
    if (getLens(db, vaultId)) acknowledgeLens(db, vaultId, now());
    if (reward.deliveredAt !== null) return reject('This vault has already been selected. Use its reward controls.');
    await interaction.deferUpdate();
    const message = await deliverRewardMessage(db, reward, interaction.channel, now);
    reward = getVaultReward(db, vaultId);
    if (reward.state === 'recast' && interaction.followUp) {
      try { await openPrivateRecast(db, followUpRecastAdapter(interaction, message), reward, now); }
      catch { /* Resume from the canonical reward card. */ }
    }
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
