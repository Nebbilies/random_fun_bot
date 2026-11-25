import { MessageFlags } from "discord.js";
import { getGameConfig } from "../lib/gameConfig.js";
import {
  resolveServerLeaderboard,
  serverLeaderboard,
  totalMarriedLeaderboard,
} from "../lib/serverLeaderboard.js";
import {
  serverLeaderboardComponents,
  serverTopPageCount,
} from "../lib/serverLeaderboardView.js";

/** Server-local user leaderboard; scores and membership are captured when opened. */
export async function run(ctx) {
  const totalMarried = ctx.args[0] === "tsl";
  const leaderboard = totalMarried
    ? totalMarriedLeaderboard
    : serverLeaderboard;
  let rows;
  try {
    rows = await resolveServerLeaderboard(
      ctx.message.guild,
      leaderboard(ctx.yoshiko.catalogDb, ctx.message.guildId),
    );
  } catch (error) {
    if (error.code !== "LEADERBOARD_MEMBERS_UNAVAILABLE") throw error;
    await ctx.message.reply({
      content: error.message,
      allowedMentions: { parse: [], repliedUser: false },
    });
    return;
  }
  const pages = serverTopPageCount(rows);
  const requested = Number(ctx.args[1]);
  let page =
    Number.isSafeInteger(requested) && requested > 0
      ? Math.min(requested, pages) - 1
      : 0;
  const render = (disabled = false) =>
    serverLeaderboardComponents(rows, page, disabled, { totalMarried });
  const reply = await ctx.message.reply({
    flags: MessageFlags.IsComponentsV2,
    components: render(),
    allowedMentions: { parse: [], repliedUser: false },
  });
  if (pages === 1 || !reply?.createMessageComponentCollector) return;
  const collector = reply.createMessageComponentCollector({
    time: getGameConfig(ctx.yoshiko.catalogDb, ctx.message.guildId).controls
      .lifetimeMs,
  });
  let busy = false;
  let expired = false;
  collector.on("collect", async (interaction) => {
    if (!["topserv:prev", "topserv:next"].includes(interaction.customId))
      return;
    try {
      if (interaction.user.id !== ctx.message.author.id) {
        await interaction.reply({
          content: "Only the command author can change pages.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await interaction.deferUpdate();
      if (busy || expired) return;
      busy = true;
      try {
        page = Math.max(
          0,
          Math.min(
            pages - 1,
            page + (interaction.customId === "topserv:next" ? 1 : -1),
          ),
        );
        await reply.edit({ components: render() });
        if (expired) await reply.edit({ components: render(true) });
      } finally {
        busy = false;
      }
    } catch (error) {
      console.error("Server leaderboard interaction failed:", error);
    }
  });
  collector.on("end", () => {
    expired = true;
    reply.edit({ components: render(true) }).catch(console.error);
  });
}
