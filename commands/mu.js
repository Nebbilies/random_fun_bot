import { getClaimStatus } from '../lib/characterRolls.js';

export async function run(ctx) {
  const now = Date.now();
  const { canClaim, resetAt } = getClaimStatus(ctx.yoshiko.catalogDb,
    ctx.message.guildId, ctx.message.author.id, now);
  const minutes = Math.ceil((resetAt - now) / 60_000);
  const duration = `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')} min`;
  await ctx.message.reply(`${canClaim ? 'You can claim right now!' : "You can't claim right now."} The next claim reset is in **${duration}**.`);
}
