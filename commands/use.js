import {
  getInventory,
  removeItemFromInventory,
  decrementItemCharge,
} from '../lib/itemStorage.js';
import { getItemDefinition } from '../lib/itemRoster.js';
import {
  useHourglassOfHaste,
  useLoveLetter,
  useBagOfHolding,
  useFourLeafClover,
  useRollingFever,
  useAdrenalineRush,
  useDoubleDate,
  useEngagementRing,
  usePinata,
  useGoldenHour,
  useCrownOfTheSovereign,
  usePickpocketsHook,
  useMasterKey,
  useAegisOfFidelity,
  useWishUponAStar,
  useFranchisePassport,
} from '../lib/itemEffects.js';

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

  let result;
  switch (inventoryItem.item_id) {
    case 'hourglass_of_haste':
      result = useHourglassOfHaste(db, guildId, userId);
      break;
    case 'love_letter':
      result = useLoveLetter(db, guildId, userId);
      break;
    case 'bag_of_holding':
      result = useBagOfHolding(db, guildId, userId);
      break;
    case 'four_leaf_clover':
      result = useFourLeafClover(db, guildId, userId);
      break;
    case 'rolling_fever':
      result = useRollingFever(db, guildId, userId);
      break;
    case 'adrenaline_rush':
      result = useAdrenalineRush(db, guildId, userId);
      break;
    case 'double_date':
      result = useDoubleDate(db, guildId, userId);
      break;
    case 'engagement_ring':
      result = useEngagementRing(db, guildId, userId);
      break;
    case 'pinata':
      result = usePinata(db, guildId, userId);
      break;
    case 'golden_hour':
      result = useGoldenHour(db, guildId, userId);
      break;
    case 'crown_of_the_sovereign':
      result = useCrownOfTheSovereign(db, guildId, userId);
      break;

    // Targeted items
    case 'pickpockets_hook': {
      const targetMention = args[0];
      const targetId = targetMention ? targetMention.replace(/[^0-9]/g, '') : null;
      if (!targetId) {
        return { success: false, message: 'Please specify a target user to pickpocket! Example: `!use pickpocket @user`' };
      }
      result = usePickpocketsHook(db, guildId, userId, targetId);
      break;
    }

    case 'master_key': {
      const targetMention = args[0];
      const targetId = targetMention ? targetMention.replace(/[^0-9]/g, '') : null;
      const charName = args.slice(1).join(' ').replace(/^["']|["']$/g, '');
      if (!targetId || !charName) {
        return { success: false, message: 'Please specify a target user and character name! Example: `!use masterkey @user "Rem"`' };
      }
      result = useMasterKey(db, guildId, userId, targetId, charName);
      break;
    }

    case 'aegis_of_fidelity': {
      const charName = args.join(' ').replace(/^["']|["']$/g, '');
      if (!charName) {
        return { success: false, message: 'Please specify which character you want to soulbind! Example: `!use aegis "Megumin"`' };
      }
      result = useAegisOfFidelity(db, guildId, userId, charName);
      break;
    }

    case 'wish_upon_a_star': {
      const franchiseQuery = args.join(' ').replace(/^["']|["']$/g, '');
      if (!franchiseQuery) {
        return { success: false, message: 'Please name the anime franchise you wish for! Example: `!use wish "Frieren"`' };
      }
      result = useWishUponAStar(db, guildId, userId, franchiseQuery);
      break;
    }

    case 'franchise_passport': {
      const franchiseQuery = args.join(' ').replace(/^["']|["']$/g, '');
      if (!franchiseQuery) {
        return { success: false, message: 'Please name the anime franchise for your passport! Example: `!use passport "Jujutsu Kaisen"`' };
      }
      result = useFranchisePassport(db, guildId, userId, franchiseQuery);
      break;
    }

    case 'mirror_shield':
    case 'golden_whistle':
    case 'binoculars':
      return { success: false, message: `**${def.name}** is a passive item and activates automatically from your inventory!` };

    default:
      return { success: false, message: `Item ${inventoryItem.item_id} cannot be activated directly.` };
  }

  // If item was blocked (e.g. by mirror shield), the attacker's item is consumed
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
