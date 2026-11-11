import { getClaimStatus } from '../features/rolls/rollAllowanceService.js';
import { getActiveBuffs } from '../lib/itemStorage.js';
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
  const extraClaims = getActiveBuffs(ctx.yoshiko.catalogDb, ctx.message.guildId, targetId, now)
    .filter(buff => ['pinata_claim_token', 'crown_of_the_sovereign'].includes(buff.buff_id))
    .reduce((total, buff) => total + Math.max(0, buff.remaining_rolls ?? 0), 0);
  const status = canClaim ? 'can claim right now!' : extraClaims > 0
    ? (isSelf ? 'have a normal claim on cooldown.' : 'has a normal claim on cooldown.')
    : "can't claim right now.";
  const tokens = extraClaims > 0 ? `\nExtra claim tokens: **${extraClaims}** — usable during the normal cooldown.` : '';
  await ctx.message.reply(`${subject} ${status} The next claim reset is in **${duration}**.${tokens}`);
}
