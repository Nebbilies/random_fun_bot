import { getGameConfig } from "../lib/gameConfig.js";
import { claimDailyRolls } from "../features/rolls/rollAllowanceService.js";

export async function run(ctx) {
  const schedules = getGameConfig(
    ctx.yoshiko.catalogDb,
    ctx.message.guildId,
  ).schedules;
  const standard =
    schedules.dailyIntervalMs === 86400000 &&
    schedules.timezoneOffsetMinutes === 420;
  const result = claimDailyRolls(
    ctx.yoshiko.catalogDb,
    ctx.message.guildId,
    ctx.message.author.id,
  );
  if (result.status === "refilled") {
    await ctx.message.reply(
      `Daily claimed! Your rolls are refilled to ${result.remaining} for this ${schedules.rollIntervalMs === 3600000 ? "hour" : "allowance cycle"}.`,
    );
    return;
  }
  await ctx.message.reply(
    `You already claimed your daily. Available again <t:${Math.floor(result.resetAt / 1000)}:R>${standard ? " (00:00 UTC+7)" : ""}.`,
  );
}
