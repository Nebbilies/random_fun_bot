import { randomUUID } from 'node:crypto';
import { armRecast, getArmedRecast } from './vaultFortune.js';
import {
  getUsableInventory,
  decrementItemCharge,
} from './itemStorage.js';
import { getItemDefinition } from './itemRoster.js';
import { withOwnershipOperationClock } from './characterOwnershipHistory.js';
import { ACTION_ITEMS } from './itemActions.js';
import { startItemAction, deliverItemResult } from './itemActionRuntime.js';
import { startForcedEscape } from './characterRollRuntime.js';
import { startVaultRoll } from './vaultRuntime.js';
import { hasVaultSessions, reservePaidVaultSession, getVaultSessionByCommand } from './vaultSessions.js';
import { getRollStatus } from './characterRolls.js';

export function executeItemUseById(db, guildId, userId, invId, args = [], options = {}) {
  options = { ...options, now: options.now ?? Date.now() };
  const inv = getUsableInventory(db, guildId, userId, options.now);
  const item = inv.find((i) => i.id === invId);
  if (!item) {
    return { success: false, message: 'Item not found in your inventory.' };
  }
  return dispatchItemUse(db, guildId, userId, item, args, options);
}

export function executeItemUse(db, guildId, userId, itemQuery, args = [], options = {}) {
  options = { ...options, now: options.now ?? Date.now() };
  const inv = getUsableInventory(db, guildId, userId, options.now);
  const normalized = itemQuery.toLowerCase().replace(/[^a-z0-9]/g, '');

  if (normalized === 'fortune' || normalized === 'fortunes') return { success: false, message: 'Choose fortunes_lens or fortunes_recast (recast).' };
  if (['recast', 'fortunesrecast'].includes(normalized) && getArmedRecast(db, guildId, userId))
    return { success: true, message: "Fortune's Recast is already armed. No additional charge was spent." };
  const exact = inv.find((i) => [i.item_id, getItemDefinition(i.item_id)?.name].some((name) => name?.toLowerCase().replace(/[^a-z0-9]/g, '') === normalized));
  const item = exact ?? inv.find((i) => {
    const def = getItemDefinition(i.item_id);
    const idNorm = i.item_id.toLowerCase().replace(/[^a-z0-9]/g, '');
    const nameNorm = def?.name.toLowerCase().replace(/[^a-z0-9]/g, '') || '';
    return idNorm.includes(normalized) || nameNorm.includes(normalized);
  });

  if (!item) {
    return { success: false, message: `You do not have any item matching "${itemQuery}" in your inventory.` };
  }

  return dispatchItemUse(db, guildId, userId, item, args, options);
}

function dispatchItemUse(db, guildId, userId, inventoryItem, args, options = {}) {
  const def = getItemDefinition(inventoryItem.item_id);
  if (!def) {
    return { success: false, message: 'Unknown item definition.' };
  }
  if (def.id === 'consolation_chit') return { success: false, message: 'Consolation Chit is passive: it automatically grants an item when you win a mystery event without an available claim. No charge was spent.' };
  if (def.id === 'fortunes_lens') return { success: false, message: "Use the Use Fortune’s Lens button on your live unopened vault. No charge was spent." };
  if (def.id === 'fortunes_recast') {
    const armed = armRecast(db, { guildId, userId, inventoryId: inventoryItem.id, now: options.now ?? Date.now() });
    return { success: ['armed', 'already_armed'].includes(armed.status), message: armed.status === 'armed'
      ? "Fortune's Recast is armed for your next eligible vault reward. Its charge is reserved until your private choice is presented."
      : armed.status === 'already_armed' ? "Fortune's Recast is already armed. No additional charge was spent."
      : 'Recast cannot be armed while another choice is pending or on an unsupported catalog. No charge was spent.' };
  }
  if (ACTION_ITEMS.has(def.id)) return { success: false, pendingAction: true, inventoryId: inventoryItem.id };
  if (typeof def.execute !== 'function') {
    return { success: false, message: `Item **${def.name}** cannot be activated directly.` };
  }

  const execute = () => {
    if (def.id === 'golden_hour' && options.commandMessageId && hasVaultSessions(db)) {
      const existing = getVaultSessionByCommand(db, options.commandMessageId);
      if (existing) {
        if (existing.guildId !== guildId || existing.rollerId !== userId || existing.channelId !== options.channelId)
          throw new Error('Vault command scope mismatch');
        return { success: true, startVault: true, vaultCommandMessageId: existing.commandMessageId,
          message: 'This Golden Hour invocation has already committed. Its original vault is preserved.' };
      }
    }
    // Synchronous effect and cost share the same eligibility snapshot and transaction.
    const source = getUsableInventory(db, guildId, userId, options.now).find(row => row.id === inventoryItem.id && row.item_id === def.id);
    if (!source) return { success: false, message: 'This item has expired or is no longer available.' };
    const result = def.execute({ db, guildId, userId, args,
      channelId: options.channelId, now: options.now ?? Date.now(), random: options.random ?? Math.random });
    // The legacy dispatcher owns costs; transactional item actions own theirs.
    if (result.blocked || result.success) decrementItemCharge(db, inventoryItem.id);
    if (result.success && result.startVault && hasVaultSessions(db)) {
      if (!options.channelId) throw new Error('Durable vault use requires its original channel');
      const session = reservePaidVaultSession(db, { guildId, userId, channelId: options.channelId,
        commandMessageId: options.commandMessageId ?? `golden-hour:${inventoryItem.id}:${inventoryItem.charges}`,
        remaining: getRollStatus(db, guildId, userId, options.now ?? Date.now()).remaining,
        now: options.now ?? Date.now() });
      result.vaultCommandMessageId = session.commandMessageId;
    }
    if (result.success && ['master_key', 'pickpockets_hook', 'wish_upon_a_star'].includes(def.id) && options.channelId) {
      const id = randomUUID();
      const character = result.character;
      const outcome = { status: 'resolved', character: { id: character.characterId ?? character.character_id ?? character.id,
        name: character.name_full, rank: character.rank ?? 0 }, message: result.message };
      const now = options.now ?? Date.now();
      db.prepare(`INSERT INTO item_actions(id,kind,guild_id,actor_id,channel_id,inventory_id,state,selections_json,result_json,created_at,expires_at,delivery_pending)
        VALUES(?,?,?,?,?,?,'resolved','{}',?,?,?,1)`)
        .run(id, def.id, guildId, userId, options.channelId, inventoryItem.id, JSON.stringify(outcome), now, now);
      result.deliveryActionId = id;
    }
    return result;
  };
  return withOwnershipOperationClock(db, options.now, execute);
}

/** Execute once, then complete the required follow-up before notifying the caller.
 * Delivery failure never refunds or replays a committed item effect.
 * The caller owns Discord acknowledgement and supplies its reply presentation.
 */
export async function activateItem({ db, message, itemQuery, inventoryId, args = [], options = {}, notify = (result) => message.reply(result.message) }) {
  const guildId = message.guildId;
  const userId = message.author.id;
  const executionOptions = { ...options, channelId: message.channelId, commandMessageId: message.activationId ?? message.id };
  const result = inventoryId == null
    ? executeItemUse(db, guildId, userId, itemQuery, args, executionOptions)
    : executeItemUseById(db, guildId, userId, inventoryId, args, executionOptions);
  let notification = result;
  try {
    // Interactive callers can acknowledge after synchronous commitment. A
    // pending confirmation creates its reservation before its reply awaits.
    if (!result.pendingAction) await options.beforeDelivery?.();
    if (result.pendingAction) {
      await startItemAction({ db, message, inventoryId: result.inventoryId, options });
      return result;
    }
    if (result.deliveryActionId) {
      await deliverItemResult({ db, message, actionId: result.deliveryActionId, options });
      notification = { ...result, message: 'Item activated. The character result is shown in this channel.' };
      await notify(notification);
      return notification;
    }
    if (result.success && result.escapeAttempt) {
      const started = await startForcedEscape({ db, channel: message.channel, guildId,
        channelId: message.channelId, commandMessageId: message.activationId ?? message.id, ...result.escapeAttempt });
      if (['started', 'sealed'].includes(started?.status)) return result;
      notification = { ...result, deliveryFailed: true,
        message: 'The escape follow-up could not be confirmed. Any committed effect and cost remain unchanged; activation was not retried.' };
    }
    if (result.success && result.startVault) {
      await startVaultRoll({ db, channel: message.channel, guildId, rollerId: userId,
        remaining: getRollStatus(db, guildId, userId).remaining, commandMessageId: result.vaultCommandMessageId ?? message.id });
    }
  } catch (error) {
    console.error('Item follow-up delivery failed:', error);
    const failed = { ...result, deliveryFailed: true,
      message: 'The item follow-up could not be delivered. Any committed effect and cost remain unchanged; activation was not retried.' };
    await notify(failed);
    return failed;
  }
  await notify(notification);
  return notification;
}
