import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
} from 'discord.js';
import {
  getInventory,
  getInventoryCapacity,
  getActiveBuffs,
} from '../lib/itemStorage.js';
import { getItemDefinition, ITEM_TIERS } from '../lib/itemRoster.js';
import { executeItemUseById } from './use.js';

export function renderInventoryEmbed(db, guildId, userId, username, now = Date.now()) {
  const inv = getInventory(db, guildId, userId);
  const capacity = getInventoryCapacity(db, guildId, userId);
  const buffs = getActiveBuffs(db, guildId, userId, now);

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`🎒 ${username}'s Inventory [${inv.length}/${capacity}]`);

  if (!inv.length) {
    embed.setDescription('Your inventory is empty. Roll characters (`!w` / `!h`) for a chance to find a **Mystery Vault**!');
  } else {
    for (const item of inv) {
      const def = getItemDefinition(item.item_id);
      const tier = def ? ITEM_TIERS[def.tier] : { emoji: '⚪' };
      const chargeText = item.charges > 1 ? ` (${item.charges} charges)` : '';
      embed.addFields({
        name: `${tier?.emoji ?? '⚪'} ${def?.name || item.item_id}${chargeText}`,
        value: def?.description || 'No description available.',
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

  embed.setFooter({
    text: '💡 Click buttons below or type !use <item> [args] • Type !inv help for item guide',
  });

  return embed;
}

export function renderInventoryComponents(db, guildId, userId) {
  const inv = getInventory(db, guildId, userId);
  const usableItems = inv.filter((item) => {
    const def = getItemDefinition(item.item_id);
    return def && def.type === 'active';
  });

  if (!usableItems.length) return [];

  // Up to 5 buttons per ActionRow
  const buttons = usableItems.slice(0, 5).map((item) => {
    const def = getItemDefinition(item.item_id);
    return new ButtonBuilder()
      .setCustomId(`inv:use:${userId}:${item.id}`)
      .setLabel(`Use ${def?.name.slice(0, 20) || item.item_id}`)
      .setStyle(ButtonStyle.Success);
  });

  return [new ActionRowBuilder().addComponents(buttons)];
}

export function getItemHelpBullet(def) {
  if (!def) return null;
  const tier = ITEM_TIERS[def.tier] || { emoji: '⚪', name: def.tier };

  switch (def.id) {
    case 'franchise_passport':
      return `• **${tier.emoji} Franchise Passport**: Type \`!use passport <franchise name>\` (e.g. \`!use passport Jujutsu Kaisen\`) to guarantee your next 5 rolls from that series.`;
    case 'hourglass_of_haste':
      return `• **${tier.emoji} Hourglass of Haste**: Click the button on \`!inv\` or type \`!use hourglass\` to instantly reset your hourly roll limit.`;
    case 'four_leaf_clover':
      return `• **${tier.emoji} Four-Leaf Clover**: Click the button on \`!inv\` or type \`!use clover\` to boost high-favorite character rates for 5 rolls.`;
    case 'binoculars':
      return `• **${tier.emoji} Binoculars**: Click the button on \`!inv\` or type \`!use binoculars\` to peek at your next 3 character rolls.`;
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
      return `• **${tier.emoji} Piñata**: Click the button on \`!inv\` or type \`!use pinata\` to shower chat with luck and reset your claim cooldown.`;
    case 'engagement_ring':
      return `• **${tier.emoji} Engagement Ring**: Click the button on \`!inv\` or type \`!use ring\` to halve your next marriage claim cooldown (1.5h instead of 3h).`;
    case 'pickpockets_hook':
      return `• **${tier.emoji} Pickpocket's Hook**: Type \`!use hook @user\` to steal a randomly chosen married character from them.`;
    case 'mirror_shield':
      return `• **${tier.emoji} Mirror Shield**: Passive item. Automatically shatters to block an incoming steal attempt targeting you.`;
    case 'bag_of_holding':
      return `• **${tier.emoji} Bag of Holding**: Click the button on \`!inv\` or type \`!use bag\` to permanently expand your inventory capacity by +1 slot.`;
    case 'double_date':
      return `• **${tier.emoji} Double Date**: Click the button on \`!inv\` or type \`!use date\` to suspend your claim cooldown for 10 minutes upon marrying.`;
    case 'golden_hour':
      return `• **${tier.emoji} Golden Hour**: Click the button on \`!inv\` or type \`!use golden\` to start a 5-minute Happy Hour with unlimited rolls for the channel.`;
    case 'blood_pact':
      return `• **${tier.emoji} Blood Pact**: Type \`!use blood <char1>, <char2>, <char3>\` to sacrifice 3 characters for a higher-ranked one.`;
    case 'master_key':
      return `• **${tier.emoji} Master Key**: Type \`!use masterkey @user <character name>\` to steal a specific married character from them.`;
    case 'wish_upon_a_star':
      return `• **${tier.emoji} Wish Upon A Star**: Type \`!use wish <franchise name>\` (e.g. \`!use wish Frieren\`) to marry one of its top 3 characters.`;
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

export function renderInventoryHelpEmbed(db, guildId, userId, username) {
  const inv = getInventory(db, guildId, userId);

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`🎒 ${username}'s Item Help Guide`);

  if (!inv.length) {
    embed.setDescription('Your inventory is empty! Roll characters (`!w` / `!h`) for a chance to find a **Mystery Vault** and get items.');
    return embed;
  }

  const uniqueItemIds = [...new Set(inv.map((item) => item.item_id))];
  const bullets = uniqueItemIds
    .map((id) => getItemHelpBullet(getItemDefinition(id)))
    .filter(Boolean);

  embed.setDescription(
    `Here is how to use the items currently in your inventory:\n\n${bullets.join('\n\n')}`
  );
  embed.setFooter({
    text: '💡 Type !inv to view your inventory, or !use <item> [args] to activate items',
  });

  return embed;
}

export async function run(ctx) {
  const { message, args, yoshiko } = ctx;
  const db = yoshiko.catalogDb;
  const guildId = message.guildId;
  const userId = message.author.id;
  const username = message.author.username;

  const subCommand = (args?.[1] || '').trim().toLowerCase();
  if (subCommand === 'help') {
    const embed = renderInventoryHelpEmbed(db, guildId, userId, username);
    await message.reply({ embeds: [embed] });
    return;
  }

  const embed = renderInventoryEmbed(db, guildId, userId, username);
  const components = renderInventoryComponents(db, guildId, userId);

  await message.reply({ embeds: [embed], components });
}

export async function onInventoryButton(db, interaction) {
  if (!interaction.isButton() || !interaction.customId.startsWith('inv:use:')) return false;

  const [, , expectedUserId, invIdStr] = interaction.customId.split(':');
  if (interaction.user.id !== expectedUserId) {
    await interaction.reply({
      content: 'You can only use items from your own inventory!',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  const invId = Number(invIdStr);
  const result = executeItemUseById(db, interaction.guildId, interaction.user.id, invId);

  if (!result.success) {
    await interaction.reply({
      content: `❌ ${result.message}`,
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  // Refresh inventory message
  const updatedEmbed = renderInventoryEmbed(db, interaction.guildId, interaction.user.id, interaction.user.username);
  const updatedComponents = renderInventoryComponents(db, interaction.guildId, interaction.user.id);

  try {
    await interaction.update({ embeds: [updatedEmbed], components: updatedComponents });
  } catch {
    // If update fails, fallback to reply
  }

  await interaction.followUp({
    content: `✅ ${result.message}`,
    flags: MessageFlags.Ephemeral,
  });
  return true;
}
