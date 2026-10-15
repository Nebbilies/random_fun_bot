import { getRollStatus } from '../lib/characterRolls.js';

export async function run(ctx) {
  const now = Date.now();
  const { remaining, resetAt } = getRollStatus(ctx.yoshiko.catalogDb,
    ctx.message.guildId, ctx.message.author.id, now);
  const minutes = Math.ceil((resetAt - now) / 60_000);
  await ctx.message.reply(`You have ${remaining} rolls left. Next rolls reset in **${minutes} min**.`);
}
