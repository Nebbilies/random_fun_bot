import {
  getInventory,
  decrementItemCharge,
} from '../lib/itemStorage.js';
import { getItemDefinition } from '../lib/itemRoster.js';

export function executeItemUseById(db, guildId, userId, invId, args = []) {
  const inv = getInventory(db, guildId, userId);
  const item = inv.find((i) => i.id === invId);
  if (!item) {
    return { success: false, message: 'Item not found in your inventory.' };
  }
  return dispatchItemUse(db, guildId, userId, item, args);
}

export function executeItemUse(db, guildId, userId, itemQuery, args = []) {
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

  return dispatchItemUse(db, guildId, userId, item, args);
}

function dispatchItemUse(db, guildId, userId, inventoryItem, args) {
  const def = getItemDefinition(inventoryItem.item_id);
  if (!def) {
    return { success: false, message: 'Unknown item definition.' };
  }
  if (typeof def.execute !== 'function') {
    return { success: false, message: `Item **${def.name}** cannot be activated directly.` };
  }

  const result = def.execute({ db, guildId, userId, args });

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

  const result = executeItemUse(db, guildId, userId, itemQuery, itemArgs);
  await message.reply(result.message);
}
