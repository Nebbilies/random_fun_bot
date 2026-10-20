import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
} from 'discord.js';
import { fileURLToPath } from 'node:url';
import { rollVaultOutcome, getItemDefinition } from './itemRoster.js';
import {
  addItemToInventory,
  getInventory,
  removeItemFromInventory,
  getInventoryCapacity,
} from './itemStorage.js';

const VAULT_IMAGE = fileURLToPath(new URL('../assets/mystery_vault.png', import.meta.url));
const BLURPLE = 0x5865f2;
const VAULT_TIMEOUT_MS = 60_000;

// In-memory active vaults
const activeVaults = new Map();

export function vaultCard(remaining, vaultId, disabled = false) {
  const container = new ContainerBuilder()
    .setAccentColor(BLURPLE)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent('# A mystery vault appears!'),
      new TextDisplayBuilder().setContent('*Choose one item, wisely...*')
    )
    .addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(
        new MediaGalleryItemBuilder()
          .setURL('attachment://mystery_vault.png')
          .setDescription('Mystery Vault')
      )
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`-# ${remaining} roll${remaining === 1 ? '' : 's'} left`)
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        ['A', 'B', 'C'].map((label) =>
          new ButtonBuilder()
            .setCustomId(`vault:${vaultId}:${label}`)
            .setLabel(label)
            .setStyle(ButtonStyle.Primary)
            .setDisabled(disabled)
        )
      )
    );

  const payload = {
    flags: MessageFlags.IsComponentsV2,
    components: [container],
    allowedMentions: { parse: [], repliedUser: false },
  };

  // Only upload the image attachment on initial send, not on disabled edits
  if (!disabled) {
    payload.files = [new AttachmentBuilder(VAULT_IMAGE, { name: 'mystery_vault.png' })];
  }

  return payload;
}

export function vaultRewardCard(outcome, actionRow = null) {
  const emoji = outcome.tierData.emoji ? `${outcome.tierData.emoji} ` : '';
  const container = new ContainerBuilder()
    .setAccentColor(outcome.tierData.color)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`# ${emoji}${outcome.tierData.name}`),
      new TextDisplayBuilder().setContent(`**${outcome.item.name}** — ${outcome.item.description}`)
    );
  if (actionRow) {
    container.addActionRowComponents(actionRow);
  }
  return container;
}

export const vaultRewardEmbed = vaultRewardCard;

export async function startVaultRoll({
  db,
  channel,
  guildId,
  rollerId,
  remaining,
  rollOutcome = rollVaultOutcome,
  timeoutMs = VAULT_TIMEOUT_MS,
}) {
  const vaultId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const cardPayload = vaultCard(remaining, vaultId, false);
  const message = await channel.send(cardPayload);

  const session = {
    vaultId,
    message,
    guildId,
    rollerId,
    remaining,
    rollOutcome,
    handled: false,
    timer: setTimeout(async () => {
      if (!session.handled) {
        session.handled = true;
        try {
          await message.edit(vaultCard(remaining, vaultId, true));
        } catch {
          // Message might be deleted
        }
      }
      activeVaults.delete(vaultId);
    }, timeoutMs),
  };
  session.timer.unref?.();

  activeVaults.set(vaultId, session);
  return { vaultId, message };
}

export async function onVaultInteraction(db, interaction) {
  if (!interaction.isButton() && !interaction.isStringSelectMenu()) return false;

  const parts = interaction.customId.split(':');
  if (parts[0] !== 'vault') return false;

  const [, vaultId, action] = parts;
  const session = activeVaults.get(vaultId);

  // If discarding an item for inventory overflow replacement
  if (action === 'replace') {
    if (!interaction.isStringSelectMenu()) return false;
    const invId = Number(interaction.values[0]);
    const pendingItemId = parts[3];

    if (invId === -1) {
      await interaction.reply({
        content: 'You chose not to take the new item.',
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    removeItemFromInventory(db, invId);
    const itemDef = getItemDefinition(pendingItemId);
    addItemToInventory(db, interaction.guildId, interaction.user.id, pendingItemId, itemDef?.maxCharges ?? 1);

    await interaction.reply({
      content: `Discarded old item and added **${itemDef?.name}** to your inventory! Use \`!inv\` to check.`,
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (!session) {
    await interaction.reply({
      content: 'This mystery vault has already expired or been claimed.',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (interaction.user.id !== session.rollerId) {
    await interaction.reply({
      content: 'Only the roller who summoned the vault may choose an item.',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (session.handled) {
    await interaction.reply({
      content: 'An item from this vault has already been selected.',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  session.handled = true;
  clearTimeout(session.timer);
  activeVaults.delete(vaultId);

  // Roll outcome for the chosen button
  const outcome = session.rollOutcome();

  // Check inventory space
  const addResult = addItemToInventory(
    db,
    session.guildId,
    session.rollerId,
    outcome.item.id,
    outcome.item.maxCharges ?? 1
  );

  // Acknowledge the interaction first to satisfy Discord's 3-second deadline
  if (addResult.status === 'full') {
    // Inventory is full: present replace options
    const inv = getInventory(db, session.guildId, session.rollerId);
    const selectOptions = inv.map((invItem) => {
      const def = getItemDefinition(invItem.item_id);
      return {
        label: `${def?.name || invItem.item_id} (${invItem.charges} charge${invItem.charges === 1 ? '' : 's'})`,
        value: String(invItem.id),
      };
    });
    selectOptions.push({
      label: 'Decline new item (keep current inventory)',
      value: '-1',
    });

    const selectRow = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`vault:${vaultId}:replace:${outcome.item.id}`)
        .setPlaceholder('Your inventory is full. Choose an item to discard:')
        .addOptions(selectOptions)
    );

    const rewardCard = vaultRewardCard(outcome, selectRow);

    await interaction.reply({
      flags: MessageFlags.IsComponentsV2,
      content: `⚠️ <@${session.rollerId}>'s inventory is full! Choose an existing item to discard in exchange for **${outcome.item.name}**, or decline:`,
      components: [rewardCard],
    });
  } else {
    const rewardCard = vaultRewardCard(outcome);
    await interaction.reply({
      flags: MessageFlags.IsComponentsV2,
      content: `🎉 <@${session.rollerId}> received **${outcome.item.name}**! Added to your inventory. (Type \`!inv\` to view)`,
      components: [rewardCard],
    });
  }

  // Disable buttons on the original card after replying (without re-uploading the image file)
  try {
    await session.message.edit(vaultCard(session.remaining, vaultId, true));
  } catch {
    // Ignore edit errors
  }

  return true;
}
