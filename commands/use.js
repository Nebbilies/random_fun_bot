import {
  getUsableInventory,
  decrementItemCharge,
} from '../lib/itemStorage.js';
import { getItemDefinition } from '../lib/itemRoster.js';
import { transaction } from '../lib/catalogDb.js';
import { ACTION_ITEMS } from '../lib/itemActions.js';
import { startItemAction } from '../lib/itemActionRuntime.js';
import { startForcedEscape } from '../lib/characterRollRuntime.js';
import { startVaultRoll } from '../lib/vaultRuntime.js';
import { getRollStatus } from '../lib/characterRolls.js';

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

export async function run(ctx) {
  const { message, args, yoshiko } = ctx;
  const db = yoshiko.catalogDb;
  const guildId = message.guildId;
  const userId = message.author.id;

  if (args.length < 2) {
    await message.reply('Please specify an item to use! Type `!inv` to see your items, or `!use <item> [args]`.');
    return;
  }

  const itemQuery = args[1];
  const itemArgs = args.slice(2);

  const result = executeItemUse(db, guildId, userId, itemQuery, itemArgs, { ...ctx.options, channelId: message.channelId });

  if (result.pendingAction) {
    await startItemAction({ db, message, inventoryId: result.inventoryId, options: ctx.options ?? {} });
    return;
  }

  // Items may open a follow-up minigame card instead of just replying.
  if (result.success && result.escapeAttempt) {
    const started = await startForcedEscape({ db, channel: message.channel, guildId,
      channelId: message.channelId, commandMessageId: message.id, yoshiko, ...result.escapeAttempt });
    if (started?.status === 'unknown') {
      await message.reply(result.message);
      return;
    }
    return;
  }
  if (result.success && result.startVault) {
    await startVaultRoll({ db, channel: message.channel, guildId, rollerId: userId,
      remaining: getRollStatus(db, guildId, userId).remaining, commandMessageId: message.id });
  }

  await message.reply(result.message);
}
