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

export async function run(ctx) {
  const { message, yoshiko } = ctx;
  const db = yoshiko.catalogDb;
  const guildId = message.guildId;
  const userId = message.author.id;
  const username = message.author.username;

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
