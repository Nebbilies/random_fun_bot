import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, MessageFlags,
  StringSelectMenuBuilder, TextDisplayBuilder } from 'discord.js';
import { listRecipientPendingItemRewards, getVaultReward, getItemRewardSource } from '../lib/vaultRewards.js';
import { settleInboxReward, vaultRewardCard } from '../lib/vaultRuntime.js';
import { getInventory, getInventoryCapacity, getUsableInventory } from '../lib/itemStorage.js';
import { getItemDefinition, ITEM_TIERS } from '../lib/itemRoster.js';
import { getVaultItemPresentation } from '../lib/itemDiscovery.js';
import { controlsLifetime, noMentions, rejectControl } from './affection.js';

const button = (id, label, disabled = false, style = ButtonStyle.Secondary) =>
  new ButtonBuilder().setCustomId(id).setLabel(label).setDisabled(disabled).setStyle(style);
const row = () => /** @type {ActionRowBuilder<import('discord.js').MessageActionRowComponentBuilder>} */ (new ActionRowBuilder());
const payload = container => ({ flags: MessageFlags.IsComponentsV2, components: [container], allowedMentions: noMentions });
const matches = (i, scope) => i.user?.id === scope.userId && i.guildId === scope.guildId &&
  i.channelId === scope.channelId && i.message?.id === scope.messageId;
const scopeFor = (ctx, messageId) => ({ userId: ctx.message.author.id, guildId: ctx.message.guildId,
  channelId: ctx.message.channelId, messageId });

export function inboxPayload(db, rewards, page = 0, disabled = false) {
  page = Math.max(0, Math.min(page, rewards.length - 1));
  const reward = rewards[page];
  if (!reward) return payload(new ContainerBuilder().setAccentColor(0x5865f2)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent('# Pending item rewards\nYour reward inbox is empty.')));
  const stored = reward.reward ?? reward.original;
  const outcome = { ...stored, tierData: ITEM_TIERS[stored.tier] ?? stored.tierData,
    item: getVaultItemPresentation(db, reward.guildId, stored.item) };
  const ready = reward.state === 'overflow' && !!reward.messageId;
  const full = getInventory(db, reward.guildId, reward.userId).length >= getInventoryCapacity(db, reward.guildId, reward.userId);
  const source = getItemRewardSource(db, reward.vaultId);
  const sourceLabel = source?.kind === 'affection_milestone' ? 'Affection milestone'
    : source?.kind === 'affection_echo' ? 'Affection Echo'
      : source?.kind === 'mystery_consolation' ? 'Mystery consolation' : source ? 'Item reward' : 'Mystery vault';
  const age = Number.isSafeInteger(reward.createdAt) ? ` · Pending since <t:${Math.floor(reward.createdAt / 1000)}:R>` : '';
  const notice = `# Pending item rewards · ${page + 1} / ${rewards.length}\nSource: ${sourceLabel}${age}\n` + (ready
    ? (full ? 'Inventory full. Manage to replace an item, or explicitly Decline this reward.' : 'Space available. Accept this saved reward, or explicitly Decline it.')
    : reward.state === 'decision' ? 'Keep/Gamble decision pending. Resume the original controls; this inbox does not choose or gamble for you.'
      : reward.state === 'recast' ? 'Private Recast choice pending. Resume from the original reward card.'
        : 'Reward publication pending. Original controls will become available after recovery.');
  const container = vaultRewardCard(outcome, null, notice);
  container.addActionRowComponents(row().addComponents(
    button('rewards:prev', 'Prev', disabled || page === 0),
    button('rewards:next', 'Next', disabled || page >= rewards.length - 1)));
  if (ready) container.addActionRowComponents(row().addComponents(
    button(`rewards:${full ? 'manage' : 'accept'}:${reward.vaultId}`, full ? 'Manage' : 'Accept', disabled, ButtonStyle.Success),
    button(`rewards:decline:${reward.vaultId}`, 'Decline', disabled, ButtonStyle.Danger)));
  else if (reward.messageId) container.addActionRowComponents(row().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Resume original reward')
      .setURL(`https://discord.com/channels/${reward.guildId}/${reward.channelId}/${reward.messageId}`)));
  return payload(container);
}

function replacementPayload(db, reward, page, disabled = false) {
  const inventory = getUsableInventory(db, reward.guildId, reward.userId);
  const pages = Math.max(1, Math.ceil(inventory.length / 25));
  page = Math.max(0, Math.min(page, pages - 1));
  const container = new ContainerBuilder().setAccentColor(ITEM_TIERS[(reward.reward ?? reward.original).tier]?.color ?? 0x5865f2)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`# Replace an inventory item\nFor **${(reward.reward ?? reward.original).item.name}**. Selecting an item discards it and accepts this saved reward.\nPage ${page + 1} / ${pages}`));
  const entries = inventory.slice(page * 25, (page + 1) * 25);
  if (entries.length) container.addActionRowComponents(row().addComponents(new StringSelectMenuBuilder()
    .setCustomId('rewardreplace:choose').setPlaceholder('Choose an item to discard').setDisabled(disabled)
    .addOptions(entries.map(entry => ({ value: String(entry.id),
      label: `${getItemDefinition(entry.item_id)?.name ?? entry.item_id} (${entry.charges} charges)`.slice(0, 100) })))));
  else container.addTextDisplayComponents(new TextDisplayBuilder().setContent('No replaceable items. Reserved items cannot be discarded.'));
  container.addActionRowComponents(row().addComponents(
    button('rewardreplace:prev', 'Prev', disabled || page === 0), button('rewardreplace:next', 'Next', disabled || page >= pages - 1),
    button('rewardreplace:accept', 'Accept if space', disabled, ButtonStyle.Success),
    button('rewardreplace:decline', 'Decline reward', disabled, ButtonStyle.Danger)));
  return payload(container);
}

export async function run(ctx) {
  const db = ctx.yoshiko.catalogDb;
  let page = 0, busy = false, expired = false;
  let rewards = listRecipientPendingItemRewards(db, ctx.message.guildId, ctx.message.author.id);
  const render = (disabled = false) => {
    rewards = listRecipientPendingItemRewards(db, ctx.message.guildId, ctx.message.author.id);
    page = Math.max(0, Math.min(page, rewards.length - 1));
    return inboxPayload(db, rewards, page, disabled);
  };
  const reply = await ctx.message.reply(render());
  if (!rewards.length || !reply?.createMessageComponentCollector) return;
  const inboxScope = scopeFor(ctx, reply.id);
  const collector = reply.createMessageComponentCollector({ time: controlsLifetime(ctx) });
  const refresh = () => reply.edit(render(expired));
  collector.on('collect', async interaction => {
    if (!interaction.customId?.startsWith('rewards:')) return;
    if (!matches(interaction, inboxScope)) return rejectControl(interaction);
    if (busy || expired) return interaction.deferUpdate().catch(() => {});
    busy = true;
    try {
      const [, action, id] = interaction.customId.split(':');
      const displayed = rewards[page];
      if (action === 'manage' && id === displayed?.vaultId && displayed.state === 'overflow') {
        const current = getVaultReward(db, id);
        if (current?.state !== 'overflow' || current.messageId !== displayed.messageId || current.channelId !== displayed.channelId) {
          await interaction.deferUpdate(); await refresh(); return;
        }
        await interaction.reply({ ...replacementPayload(db, displayed, 0), flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });
        const privateReply = await interaction.fetchReply();
        const privateScope = scopeFor(ctx, privateReply.id);
        const chooser = privateReply.createMessageComponentCollector({ time: controlsLifetime(ctx) });
        let inventoryPage = 0, choosing = false, closed = false;
        chooser.on('collect', async choice => {
          if (!choice.customId?.startsWith('rewardreplace:')) return;
          if (!matches(choice, privateScope)) return rejectControl(choice);
          if (choosing || closed || expired) return choice.deferUpdate().catch(() => {});
          choosing = true;
          try {
            await choice.deferUpdate();
            const operation = choice.customId.split(':')[1];
            if (operation === 'prev' || operation === 'next') {
              const pages = Math.max(1, Math.ceil(getUsableInventory(db, displayed.guildId, displayed.userId).length / 25));
              inventoryPage = Math.max(0, Math.min(pages - 1, inventoryPage + (operation === 'next' ? 1 : -1)));
              await interaction.editReply(replacementPayload(db, displayed, inventoryPage)); return;
            }
            const value = choice.values?.[0];
            if (operation === 'choose' && !/^\d+$/.test(value ?? '')) return;
            const result = await settleInboxReward(db, choice, { inboxScope: privateScope, reward: displayed,
              action: operation === 'choose' ? 'replace' : operation, inventoryId: value ? Number(value) : undefined });
            if (result.reward?.state !== 'overflow' && result.reward) { closed = true; chooser.stop('settled'); }
            // Settlement is already committed. Presentation failures must not
            // report it as unsaved or prevent the public inbox from catching up.
            await Promise.all([
              interaction.editReply(closed ? payload(new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder()
                .setContent('This reward is no longer pending. Check your inbox for remaining rewards.')))
                : replacementPayload(db, displayed, inventoryPage))
                .catch(error => console.error('Reward replacement presentation failed:', error)),
              refresh().catch(error => console.error('Reward inbox refresh failed:', error)),
            ]);
          } catch (error) {
            console.error('Reward replacement failed:', error);
            await choice.followUp({ content: 'Could not save this choice. Reopen !rewards to check its current state.', flags: MessageFlags.Ephemeral, allowedMentions: noMentions }).catch(() => {});
          } finally { choosing = false; }
        });
        chooser.on('end', () => {
          if (!closed) { closed = true; interaction.editReply(replacementPayload(db, displayed, inventoryPage, true)).catch(() => {}); }
        });
        return;
      }
      await interaction.deferUpdate();
      if (action === 'prev') page--;
      else if (action === 'next') page++;
      else if (['accept', 'decline'].includes(action) && id === displayed?.vaultId) {
        await settleInboxReward(db, interaction, { inboxScope, reward: displayed, action });
      }
      await refresh();
    } catch (error) {
      console.error('Reward inbox failed:', error);
      await interaction.followUp({ content: 'Could not refresh rewards. Please try !rewards again.', flags: MessageFlags.Ephemeral, allowedMentions: noMentions }).catch(() => {});
    } finally { busy = false; }
  });
  collector.on('end', () => { expired = true; refresh().catch(() => {}); });
}
