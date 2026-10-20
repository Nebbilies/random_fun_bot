import { getClaimStatus } from '../lib/characterRolls.js';
import { resolveUserTarget } from '../lib/userTarget.js';

export async function run(ctx) {
  const token = ctx.args?.[1];
  const { targetId, isSelf, valid } = resolveUserTarget(token, ctx.message.author.id, ctx.message);
  if ((ctx.args && ctx.args.length > 2) || (token && !valid)) {
    const prefix = ctx.prefix ?? '!';
    const commandName = ctx.args?.[0] ?? 'mu';
    await ctx.message.reply(`Usage: ${prefix}${commandName} [@user]`);
    return;
  }
  const now = Date.now();
  const { canClaim, resetAt } = getClaimStatus(ctx.yoshiko.catalogDb,
    ctx.message.guildId, targetId, now);
  const minutes = Math.ceil((resetAt - now) / 60_000);
  const duration = `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')} min`;
  const subject = isSelf ? 'You' : `<@${targetId}>`;
  const status = canClaim ? 'can claim right now!' : "can't claim right now.";
  await ctx.message.reply(`${subject} ${status} The next claim reset is in **${duration}**.`);
}
