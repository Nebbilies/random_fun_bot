import { getRollStatus } from '../features/rolls/rollAllowanceService.js';
import { resolveUserTarget } from '../lib/userTarget.js';

export async function run(ctx) {
  const token = ctx.args?.[1];
  const { targetId, isSelf, valid } = resolveUserTarget(token, ctx.message.author.id, ctx.message);
  if ((ctx.args && ctx.args.length > 2) || (token && !valid)) {
    const prefix = ctx.prefix ?? '!';
    const commandName = ctx.args?.[0] ?? 'ru';
    await ctx.message.reply(`Usage: ${prefix}${commandName} [@user]`);
    return;
  }
  const now = Date.now();
  const { remaining, resetAt } = getRollStatus(ctx.yoshiko.catalogDb,
    ctx.message.guildId, targetId, now);
  const minutes = Math.ceil((resetAt - now) / 60_000);
  const prefixText = isSelf ? `You have ${remaining} rolls left.` : `<@${targetId}> has ${remaining} rolls left.`;
  await ctx.message.reply(`${prefixText} Next rolls reset in **${minutes} min**.`);
}
