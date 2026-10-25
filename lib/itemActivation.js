import {
  getUsableInventory,
  decrementItemCharge,
} from './itemStorage.js';
import { getItemDefinition } from './itemRoster.js';
import { transaction } from './catalogDb.js';
import { ACTION_ITEMS } from './itemActions.js';
import { startItemAction } from './itemActionRuntime.js';
import { startForcedEscape } from './characterRollRuntime.js';
import { startVaultRoll } from './vaultRuntime.js';
import { getRollStatus } from './characterRolls.js';

export function executeItemUseById(db, guildId, userId, invId, args = [], options = {}) {
  const inv = getUsableInventory(db, guildId, userId);
  const item = inv.find((i) => i.id === invId);
  if (!item) {
    return { success: false, message: 'Item not found in your inventory.' };
  }
  return dispatchItemUse(db, guildId, userId, item, args, options);
}

export function executeItemUse(db, guildId, userId, itemQuery, args = [], options = {}) {
  const inv = getUsableInventory(db, guildId, userId);
  const normalized = itemQuery.toLowerCase().replace(/[^a-z0-9]/g, '');

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
  if (ACTION_ITEMS.has(def.id)) return { success: false, pendingAction: true, inventoryId: inventoryItem.id };
  if (typeof def.execute !== 'function') {
    return { success: false, message: `Item **${def.name}** cannot be activated directly.` };
  }

  const execute = () => {
    const result = def.execute({ db, guildId, userId, args,
      channelId: options.channelId, now: options.now ?? Date.now(), random: options.random ?? Math.random });
    // The legacy dispatcher owns costs; transactional item actions own theirs.
    if (result.blocked || result.success) decrementItemCharge(db, inventoryItem.id);
    return result;
  };
  return ['master_key', 'pickpockets_hook', 'sirens_call'].includes(def.id) ? transaction(db, execute) : execute();
}

/** Execute once, then complete the required follow-up before notifying the caller.
 * Delivery failure never refunds or replays a committed item effect.
 * The caller owns Discord acknowledgement and supplies its reply presentation.
 */
export async function activateItem({ db, message, itemQuery, inventoryId, args = [], options = {}, notify = (result) => message.reply(result.message) }) {
  const guildId = message.guildId;
  const userId = message.author.id;
  const executionOptions = { ...options, channelId: message.channelId };
  const result = inventoryId == null
    ? executeItemUse(db, guildId, userId, itemQuery, args, executionOptions)
    : executeItemUseById(db, guildId, userId, inventoryId, args, executionOptions);
  let notification = result;
  try {
    if (result.pendingAction) {
      await startItemAction({ db, message, inventoryId: result.inventoryId, options });
      return result;
    }
    if (result.success && result.escapeAttempt) {
      const started = await startForcedEscape({ db, channel: message.channel, guildId,
        channelId: message.channelId, commandMessageId: message.id, ...result.escapeAttempt });
      if (['started', 'sealed'].includes(started?.status)) return result;
      notification = { ...result, deliveryFailed: true,
        message: 'The escape follow-up could not be confirmed. Any committed effect and cost remain unchanged; activation was not retried.' };
    }
    if (result.success && result.startVault) {
      await startVaultRoll({ db, channel: message.channel, guildId, rollerId: userId,
        remaining: getRollStatus(db, guildId, userId).remaining, commandMessageId: message.id });
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
