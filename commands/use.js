import {
  getInventory,
  decrementItemCharge,
} from '../lib/itemStorage.js';
import { getItemDefinition } from '../lib/itemRoster.js';
import { startForcedEscape } from '../lib/characterRollRuntime.js';
import { startVaultRoll } from '../lib/vaultRuntime.js';
import { getRollStatus } from '../lib/characterRolls.js';

export function executeItemUseById(db, guildId, userId, invId, args = [], options = {}) {
  const inv = getInventory(db, guildId, userId);
  const item = inv.find((i) => i.id === invId);
  if (!item) {
    return { success: false, message: 'Item not found in your inventory.' };
  }
  return dispatchItemUse(db, guildId, userId, item, args, options);
}

export function executeItemUse(db, guildId, userId, itemQuery, args = [], options = {}) {
  const inv = getInventory(db, guildId, userId);
  const normalized = itemQuery.toLowerCase().replace(/[^a-z0-9]/g, '');

  const item = inv.find((i) => {
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
  if (typeof def.execute !== 'function') {
    return { success: false, message: `Item **${def.name}** cannot be activated directly.` };
  }

  const result = def.execute({
    db,
    guildId,
    userId,
    args,
    now: options.now ?? Date.now(),
    random: options.random ?? Math.random,
  });

  // If item was blocked (e.g. by mirror shield) or successfully used, decrement charge
  if (result.blocked || result.success) {
    decrementItemCharge(db, inventoryItem.id);
  }

  return result;
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

  const result = executeItemUse(db, guildId, userId, itemQuery, itemArgs, ctx.options ?? {});

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
      remaining: getRollStatus(db, guildId, userId).remaining });
  }

  await message.reply(result.message);
}
