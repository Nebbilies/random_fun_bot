import { markCharacterOwnership } from '../lib/characterOwnershipDisplay.js';
import { getGameConfig } from '../lib/gameConfig.js';
import { MessageFlags } from 'discord.js';
import { topCharacters, topListComponents, topPageCount } from '../lib/topCharacters.js';



/**
 * `!top` lists the highest ranked characters of the catalog, 15 per page.
 * `!top <page>` opens a specific page of the list.
 */
export async function run(ctx) {
  const rows = topCharacters(ctx.yoshiko.catalogDb);
  const render = (disabled = false) => topListComponents(
    markCharacterOwnership(ctx.yoshiko.catalogDb, ctx.message.guildId, rows), page, { disabled });
  const pages = topPageCount(rows);
  const requested = Number.parseInt(ctx.args[1] ?? '', 10);
  let page = Number.isInteger(requested) && requested > 0 ? Math.min(requested, pages) - 1 : 0;

  const reply = await ctx.message.reply({
    flags: MessageFlags.IsComponentsV2,
    components: render(),
    allowedMentions: { parse: [], repliedUser: false },
  });
  if (!reply?.createMessageComponentCollector) return;

  const controlLifetime = getGameConfig(ctx.yoshiko.catalogDb, ctx.message.guildId).controls.lifetimeMs;
  const collector = reply.createMessageComponentCollector({ time: controlLifetime });
  let busy = false;
  let expired = false;

  collector.on('collect', async (interaction) => {
    try {
      await interaction.deferUpdate();
      if (expired || busy) return;
      busy = true;
      try {
        if (interaction.customId === 'top:prev' && page > 0) {
          page -= 1;
          await reply.edit({ components: render() });
        } else if (interaction.customId === 'top:next' && page + 1 < pages) {
          page += 1;
          await reply.edit({ components: render() });
        }
        if (expired) await reply.edit({ components: render(true) });
      } finally {
        busy = false;
      }
    } catch (error) {
      console.error('Top list interaction failed:', error);
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({
          content: 'The top list could not be updated. Please try again later.',
          flags: MessageFlags.Ephemeral,
        }).catch(console.error);
      }
    }
  });

  collector.on('end', () => {
    expired = true;
    reply.edit({ components: render(true) }).catch(console.error);
  });
}
