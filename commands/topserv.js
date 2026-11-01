import { MessageFlags } from 'discord.js';
import { getGameConfig } from '../lib/gameConfig.js';
import { resolveServerLeaderboard, serverLeaderboard } from '../lib/serverLeaderboard.js';
import { serverLeaderboardComponents, serverTopPageCount } from '../lib/serverLeaderboardView.js';

/** Server-local user leaderboard; scores and membership are captured when opened. */
export async function run(ctx) {
  const rows = await resolveServerLeaderboard(ctx.message.guild,
    serverLeaderboard(ctx.yoshiko.catalogDb, ctx.message.guildId));
  const pages = serverTopPageCount(rows);
  const requested = Number(ctx.args[1]);
  let page = Number.isSafeInteger(requested) && requested > 0 ? Math.min(requested, pages) - 1 : 0;
  const render = (disabled = false) => serverLeaderboardComponents(rows, page, disabled);
  const reply = await ctx.message.reply({
    flags: MessageFlags.IsComponentsV2, components: render(),
    allowedMentions: { parse: [], repliedUser: false },
  });
  if (pages === 1 || !reply?.createMessageComponentCollector) return;
  const collector = reply.createMessageComponentCollector({
    time: getGameConfig(ctx.yoshiko.catalogDb, ctx.message.guildId).controls.lifetimeMs,
  });
  let busy = false;
  let expired = false;
  collector.on('collect', async (interaction) => {
    if (!['topserv:prev', 'topserv:next'].includes(interaction.customId)) return;
    try {
      if (interaction.user.id !== ctx.message.author.id) {
        await interaction.reply({ content: 'Only the command author can change pages.', flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.deferUpdate();
      if (busy || expired) return;
      busy = true;
      try {
        page = Math.max(0, Math.min(pages - 1, page + (interaction.customId === 'topserv:next' ? 1 : -1)));
        await reply.edit({ components: render() });
        if (expired) await reply.edit({ components: render(true) });
      } finally {
        busy = false;
      }
    } catch (error) {
      console.error('Server leaderboard interaction failed:', error);
    }
  });
  collector.on('end', () => {
    expired = true;
    reply.edit({ components: render(true) }).catch(console.error);
  });
}
