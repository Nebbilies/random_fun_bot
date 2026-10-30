import { isCatalogDraining } from '../lib/catalogMaintenance.js';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
} from 'discord.js';
import {
  getInventory,
  isInventoryEscrowed,
  getInventoryCapacity,
  getUsableInventory,
  getActiveBuffs,
} from '../lib/itemStorage.js';
import { getItemDefinition, getResolvedItemDefinition, ITEM_TIERS } from '../lib/itemRoster.js';
import { resolveUserTarget, resolveTargetUsername } from '../lib/userTarget.js';
import { activateItem } from '../lib/itemActivation.js';
import { formatItemLifetime } from '../lib/itemDuration.js';

export function renderInventoryEmbed(db, guildId, userId, username, now = Date.now(), isSelf = true) {
  const inv = getInventory(db, guildId, userId, now);
  const capacity = getInventoryCapacity(db, guildId, userId);
  const buffs = getActiveBuffs(db, guildId, userId, now);

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`🎒 ${username}'s Inventory [${inv.length}/${capacity}]`);

  if (!inv.length) {
    if (isSelf) {
      embed.setDescription('Your inventory is empty. Roll characters (`!w` / `!h`) for a chance to find a **Mystery Vault**!');
    } else {
      embed.setDescription(`<@${userId}>'s inventory is empty.`);
    }
  } else {
    for (const item of inv) {
      const def = getResolvedItemDefinition(db, guildId, item.item_id);
      const tier = def ? ITEM_TIERS[def.tier] : { emoji: '⚪' };
      const chargeText = item.charges > 1 ? ` (${item.charges} charges)` : '';
      const lifetime = formatItemLifetime(item.expires_at - now);
      embed.addFields({
        name: `${tier?.emoji ?? '⚪'} ${def?.name || item.item_id}${chargeText}${lifetime ? ` ${lifetime}` : ''}`,
        value: `${isInventoryEscrowed(db, item.id) ? '🔒 Reserved / temporarily held — unavailable for use or replacement.\n' : ''}${def?.description || 'No description available.'}`,
        inline: false,
      });
    }
  }

  if (buffs.length > 0) {
    const buffLines = buffs.map((b) => {
      const def = getItemDefinition(b.buff_id);
      const name = def?.name || b.buff_id;
      if (b.remaining_rolls !== null) {
        return `• **${name}**: ${b.remaining_rolls} roll${b.remaining_rolls === 1 ? '' : 's'} remaining`;
      }
      if (b.expires_at !== null) {
        return `• **${name}**: expires <t:${Math.floor(b.expires_at / 1000)}:R>`;
      }
      return `• **${name}**: active`;
    });

    embed.addFields({
      name: '✨ Active Buffs',
      value: buffLines.join('\n'),
      inline: false,
    });
  }

  if (isSelf) {
    embed.setFooter({
      text: '💡 Click buttons below or type !use <item> [args] • Type !inv help for item guide',
    });
  } else {
    embed.setFooter({
      text: "💡 Viewing another user's inventory",
    });
  }

  return embed;
}

export function renderInventoryComponents(db, guildId, userId, now = Date.now()) {
  const usableItems = getUsableInventory(db, guildId, userId, now).filter((item) => {
    const def = getItemDefinition(item.item_id);
    return def && (def.type === 'active' || def.type === 'item_action');
  });

  if (!usableItems.length) return [];

  // Up to 5 buttons per ActionRow
  const buttons = usableItems.slice(0, 5).map((item) => {
    const def = getItemDefinition(item.item_id);
    return new ButtonBuilder()
      .setCustomId(`inv:use:${userId}:${item.id}${db.prepare('PRAGMA user_version').get().user_version === 12 ? ':v12' : ''}`)
      .setLabel(`Use ${def?.name.slice(0, 20) || item.item_id}`)
      .setStyle(ButtonStyle.Success);
  });

  return [new ActionRowBuilder().addComponents(buttons)];
}

export function getItemHelpBullet(def) {
  if (!def) return null;
  if (def.rules) {
    const tier = ITEM_TIERS[def.tier] || { emoji: '⚪' };
    const examples = {
      franchise_passport: 'passport <franchise name>', pickpockets_hook: 'hook @user',
      sirens_call: 'siren @user', master_key: 'masterkey @user <character name>',
      wish_upon_a_star: 'wish <franchise name>', aegis_of_fidelity: 'aegis <character name>',
    };
    const usage = def.type === 'passive' ? 'Passive item: activates automatically.'
      : def.id === 'double_or_nothing' ? 'Choose Keep or Gamble on a qualifying vault reward.'
      : `Use \`!use ${examples[def.id] ?? def.id}\` (follow prompts for costs or targets).`;
    return `• **${tier.emoji} ${def.name}**: ${usage} ${def.description}`;
  }
  const tier = ITEM_TIERS[def.tier] || { emoji: '⚪', name: def.tier };

  switch (def.id) {
    case 'kaimetsu':
      return `• **${tier.emoji} ${def.name}**: Type \`!use kaimetsu\` and confirm the guild-wide divorce. Includes your own harem; only soulbound characters are immune. ${def.description}`;
    case 'double_or_nothing':
      return `• **${tier.emoji} Double or Nothing**: Choose Keep or Gamble when a qualifying vault reward is revealed.`;
    case 'alchemist': case 'chaos_exchange': case 'counterfeit_crown': case 'heart_for_a_heart':
    case 'hostage_note': case 'severed_fate': case 'grand_masquerade':
      return `• **${tier.emoji} ${def.name}**: Type \`!use ${def.id}\` to select costs/targets and confirm. ${def.description}`;
    case 'franchise_passport':
      return `• **${tier.emoji} Franchise Passport**: Type \`!use passport <franchise name>\` (e.g. \`!use passport Jujutsu Kaisen\`) to activate it. ${def.description}`;
    case 'hourglass_of_haste':
      return `• **${tier.emoji} Hourglass of Haste**: Click the button on \`!inv\` or type \`!use hourglass\` to instantly reset your hourly roll limit.`;
    case 'four_leaf_clover':
      return `• **${tier.emoji} Four-Leaf Clover**: Click the button on \`!inv\` or type \`!use clover\` to boost high-favorite character rates for 5 rolls.`;
    case 'binoculars':
      return `• **${tier.emoji} Binoculars**: Click **Use Binoculars** during an eligible mystery minigame to receive the answer in DMs. Optional; spent only after successful delivery. (1 charge)`;
    case 'love_letter':
      return `• **${tier.emoji} Love Letter**: Click the button on \`!inv\` or type \`!use letter\` to reset your 3-hour claim cooldown immediately.`;
    case 'golden_whistle':
      return `• **${tier.emoji} Golden Whistle**: Passive item. Automatically reclaims your married character if they attempt an escape.`;
    case 'sirens_call':
      return `• **${tier.emoji} Siren's Call**: Type \`!use siren @user\` to lure a married character owned by target user into attempting an escape.`;
    case 'rolling_fever':
      return `• **${tier.emoji} Rolling Fever**: Click the button on \`!inv\` or type \`!use fever\` to gain +2 rolls every time you roll a 1,000+ favorite character.`;
    case 'adrenaline_rush':
      return `• **${tier.emoji} Adrenaline Rush**: Click the button on \`!inv\` or type \`!use adrenaline\` to double your hourly roll allowance for 1 hour.`;
    case 'pinata':
      return `• **${tier.emoji} Piñata**: Click the button on \`!inv\` or type \`!use pinata\` to activate it. ${def.description}`;
    case 'engagement_ring':
      return `• **${tier.emoji} Engagement Ring**: Click the button on \`!inv\` or type \`!use ring\` to halve your next marriage claim cooldown (1.5h instead of 3h).`;
    case 'pickpockets_hook':
      return `• **${tier.emoji} Pickpocket's Hook**: Type \`!use hook @user\` to steal a randomly chosen married character from them.`;
    case 'mirror_shield':
      return `• **${tier.emoji} Mirror Shield**: Passive item. Automatically shatters to block an incoming steal attempt targeting you.`;
    case 'bag_of_holding':
      return `• **${tier.emoji} Bag of Holding**: Click the button on \`!inv\` or type \`!use bag\` to permanently expand your inventory capacity by +1 slot.`;
    case 'double_date':
      return `• **${tier.emoji} Double Date**: Click the button on \`!inv\` or type \`!use date\` to activate it. ${def.description}`;
    case 'golden_hour':
      return `• **${tier.emoji} Golden Hour**: Click the button on \`!inv\` or type \`!use golden\` to reset everyone's hourly rolls in this server and open a mystery vault for yourself.`;
    case 'blood_pact':
      return `• **${tier.emoji} Blood Pact**: Type \`!use blood\` to choose sacrifices from the select menu, then confirm. ${def.description}`;
    case 'master_key':
      return `• **${tier.emoji} Master Key**: Type \`!use masterkey @user <character name>\` to steal a specific married character from them.`;
    case 'wish_upon_a_star':
      return `• **${tier.emoji} Wish Upon A Star**: Type \`!use wish <franchise name>\` (e.g. \`!use wish Frieren\`) to activate it. ${def.description}`;
    case 'aegis_of_fidelity':
      return `• **${tier.emoji} Aegis of Fidelity**: Type \`!use aegis <character name>\` to permanently soulbind a character you own so they can never be stolen or escape.`;
    case 'crown_of_the_sovereign':
      return `• **${tier.emoji} Crown of the Sovereign**: Click the button on \`!inv\` or type \`!use crown\` to equip 3 instant claim tokens that bypass cooldowns.`;
    default:
      if (def.type === 'passive') {
        return `• **${tier.emoji} ${def.name}**: Passive item. Activates automatically when triggered.`;
      }
      return `• **${tier.emoji} ${def.name}**: Click the button on \`!inv\` or type \`!use ${def.id.split('_')[0]}\`.`;
  }
}

export function renderInventoryHelpEmbed(db, guildId, userId, username, isSelf = true, now = Date.now()) {
  const inv = getInventory(db, guildId, userId, now);

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`🎒 ${username}'s Item Help Guide`);

  if (!inv.length) {
    if (isSelf) {
      embed.setDescription('Your inventory is empty! Roll characters (`!w` / `!h`) for a chance to find a **Mystery Vault** and get items.');
    } else {
      embed.setDescription(`<@${userId}>'s inventory is empty.`);
    }
    return embed;
  }

  const uniqueItemIds = [...new Set(inv.map((item) => item.item_id))];
  const bullets = uniqueItemIds
    .map((id) => getItemHelpBullet(getResolvedItemDefinition(db, guildId, id)))
    .filter(Boolean);

  const prefix = isSelf
    ? 'Here is how to use the items currently in your inventory:'
    : `Here is how to use the items currently in <@${userId}>'s inventory:`;

  embed.setDescription(`${prefix}\n\n${bullets.join('\n\n')}\n\nItems have fixed lifetimes from acquisition, shown as remaining time (for example, \`(2d 16h)\`). Charges share that deadline. A valid use started before expiry may finish afterward; unused charges still expire. See \`!itemlist\` for current rarity lifetimes.`);
  embed.setFooter({
    text: '💡 Type !inv to view your inventory, or !use <item> [args] to activate items',
  });

  return embed;
}

export async function run(ctx) {
  const { message, args, yoshiko } = ctx;
  const prefix = ctx.prefix ?? '!';
  const db = yoshiko.catalogDb;
  const guildId = message.guildId;

  const firstArg = (args?.[1] || '').trim().toLowerCase();
  const isHelp = firstArg === 'help';
  const targetToken = isHelp ? args?.[2] : args?.[1];

  if ((isHelp && (args?.length ?? 0) > 3) || (!isHelp && (args?.length ?? 0) > 2)) {
    await message.reply(`Usage: ${prefix}inv [@user] or ${prefix}inv help [@user]`);
    return;
  }

  const { targetId, isSelf, valid } = resolveUserTarget(targetToken, message.author.id, message);
  if (targetToken && !valid) {
    await message.reply(`Usage: ${prefix}inv [@user] or ${prefix}inv help [@user]`);
    return;
  }

  const username = await resolveTargetUsername(message, targetId, isSelf ? message.author.username : null);

  const now = Date.now();
  if (isHelp) {
    const embed = renderInventoryHelpEmbed(db, guildId, targetId, username, isSelf, now);
    await message.reply({ embeds: [embed] });
    return;
  }

  const embed = renderInventoryEmbed(db, guildId, targetId, username, now, isSelf);
  // Only provide use buttons when inspecting one's own inventory
  const components = isSelf ? renderInventoryComponents(db, guildId, targetId, now) : [];

  await message.reply({ embeds: [embed], components });
}

export async function onInventoryButton(db, interaction, now = Date.now()) {
  if (!interaction.isButton() || !interaction.customId.startsWith('inv:use:')) return false;

  const parts = interaction.customId.split(':');
  if (db.prepare('PRAGMA user_version').get().user_version === 12 && (parts.length !== 5 || parts[4] !== 'v12')) {
    await interaction.reply({ content: 'This inventory control expired during the catalog upgrade. Run the inventory command again.', flags: MessageFlags.Ephemeral });
    return true;
  }
  const [, , expectedUserId, invIdStr] = parts;
  if (interaction.user.id !== expectedUserId) {
    await interaction.reply({
      content: 'You can only use items from your own inventory!',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (isCatalogDraining(db)) {
    await interaction.reply({ content: 'Character game is draining for maintenance. No item was consumed.', flags: MessageFlags.Ephemeral });
    return true;
  }
  // Check the exact live entry, never substitute another copy by name. A purged
  // row cannot prove expiry, so keep stale feedback deliberately non-specific.
  const inventoryId = Number(invIdStr);
  const entry = Number.isSafeInteger(inventoryId) && getInventory(db, interaction.guildId, expectedUserId, now)
    .find(item => item.id === inventoryId);
  if (!entry) {
    await interaction.reply({ content: 'This item has expired or is no longer available. Run the inventory command again.', flags: MessageFlags.Ephemeral });
    return true;
  }
  // Start synchronously before the acknowledgement await. activateItem commits
  // immediate uses or creates the confirmation reservation before its first await.
  // Follow-up Discord delivery still waits for the interaction acknowledgement.
  let acknowledge;
  let rejectAcknowledgement;
  const acknowledged = new Promise((resolve, reject) => { acknowledge = resolve; rejectAcknowledgement = reject; });
  // Attach immediately: acknowledgement may fail before a delivery continuation
  // reaches its await, and must never surface as an unhandled rejection.
  void acknowledged.catch(() => {});
  const activation = activateItem({ db, inventoryId, options: { now, beforeDelivery: () => acknowledged }, message: {
    guildId: interaction.guildId, channelId: interaction.channelId, channel: interaction.channel,
    author: interaction.user, activationId: `interaction:${interaction.id}`,
    reply: async (payload) => { await acknowledged; return interaction.followUp(payload); },
  }, notify: async (result) => {
    await acknowledged;
    if (result.success) {
      try {
        const now = Date.now();
        await interaction.editReply({
          embeds: [renderInventoryEmbed(db, interaction.guildId, interaction.user.id, interaction.user.username, now)],
          components: renderInventoryComponents(db, interaction.guildId, interaction.user.id, now),
        });
      } catch (error) {
        // A deleted inventory message must not suppress private status feedback.
        console.error('Inventory refresh failed:', error);
      }
    }
    await interaction.followUp({
      content: `${result.success && !result.deliveryFailed ? '✅' : '❌'} ${result.message}`,
      flags: MessageFlags.Ephemeral,
    });
  } });
  try {
    await interaction.deferUpdate();
    acknowledge();
  } catch (error) {
    rejectAcknowledgement(error);
    await activation.catch(() => {});
    throw error;
  }
  await activation;

  return true;
}
