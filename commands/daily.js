import { claimDailyRolls } from '../lib/characterRolls.js';

export async function run(ctx) {
  const result = claimDailyRolls(ctx.yoshiko.catalogDb, ctx.message.guildId, ctx.message.author.id);
  if (result.status === 'refilled') {
    await ctx.message.reply(`Daily claimed! Your rolls are refilled to ${result.remaining} for this hour.`);
    return;
  }
  await ctx.message.reply(`You already claimed your daily. Available again <t:${Math.floor(result.resetAt / 1000)}:R> (00:00 UTC+7).`);
}
