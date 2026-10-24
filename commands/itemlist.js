import { MessageFlags } from 'discord.js';
import { getGameConfig } from '../lib/gameConfig.js';
import { guildItemList, ITEM_LIST_FILTERS, itemListComponents, itemListPages } from '../lib/itemList.js';

export async function run(ctx) {
  const db = ctx.yoshiko.catalogDb;
  const guildId = ctx.message.guildId;
  let filter = 'all';
  let page = 0;
  const render = (disabled = false) => {
    const pages = itemListPages(guildItemList(db, guildId, filter));
    page = Math.min(page, pages.length - 1);
    return itemListComponents(pages, page, filter, disabled);
  };
  const reply = await ctx.message.reply({
    flags: MessageFlags.IsComponentsV2, components: render(),
    allowedMentions: { parse: [], repliedUser: false },
  });
  if (!reply?.createMessageComponentCollector) return;
  const collector = reply.createMessageComponentCollector({
    time: getGameConfig(db, guildId).controls.lifetimeMs,
    filter: interaction => ['itemlist:tier', 'itemlist:prev', 'itemlist:next'].includes(interaction.customId),
  });
  let busy = false;
  let expired = false;
  collector.on('collect', async interaction => {
    try {
      await interaction.deferUpdate();
      if (expired || busy) return;
      busy = true;
      try {
        if (interaction.customId === 'itemlist:tier') {
          const selected = interaction.values?.[0];
          if (!ITEM_LIST_FILTERS.includes(selected)) return;
          filter = selected;
          page = 0;
        } else if (interaction.customId === 'itemlist:prev') {
          page = Math.max(0, page - 1);
        } else if (interaction.customId === 'itemlist:next') {
          page += 1;
        }
        await reply.edit({ components: render() });
        if (expired) await reply.edit({ components: render(true) });
      } finally {
        busy = false;
      }
    } catch (error) {
      console.error('Item list interaction failed:', error);
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: 'The item list could not be updated. Please try again later.',
          flags: MessageFlags.Ephemeral }).catch(console.error);
      }
    }
  });
  collector.on('end', () => {
    expired = true;
    reply.edit({ components: render(true) }).catch(console.error);
  });
}
