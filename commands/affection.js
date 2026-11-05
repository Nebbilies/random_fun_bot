import { MessageFlags } from 'discord.js';
import { hasAffection, getAffectionOverview, getAffectionDetail, getSoulmateState } from '../lib/characterAffection.js';
import { retryOwedAffectionRewards } from '../lib/affectionRewards.js';
import { findCharacters } from '../lib/gameCharacterLookup.js';
import { resolveUserTarget, resolveTargetUsername } from '../lib/userTarget.js';
import { getGameConfig } from '../lib/gameConfig.js';
import { detailPayload, overviewPayload, pickerPayload } from '../lib/affectionPresentation.js';

export const noMentions = { parse: [], repliedUser: false };
export function normalizedDetail(detail) {
  if (!detail) throw new Error('Character no longer available');
  const rows = Array.isArray(detail.pending) ? detail.pending : null;
  return { ...detail, pending: rows ? { owed: rows.filter(row => row.state === 'owed').length,
    pending: rows.filter(row => row.state === 'selected').length } : detail.pending };
}
export function overviewProjection(db, args) {
  const view = getAffectionOverview(db, args);
  const other = getAffectionOverview(db, { ...args, former: true, page: 0, pageSize: 1 });
  const soulmate = view.benefits?.soulmate;
  const name = soulmate ? getAffectionDetail(db, { ...args, characterId: soulmate.characterId })?.name : null;
  return { ...view, ...normalizedDetail(view), former: Boolean(args.former),
    pages: Math.max(1, Math.ceil(view.total / (args.pageSize ?? 5))), hasFormer: other.total > 0,
    benefits: { ...view.benefits, soulmate: soulmate ? { ...soulmate, name } : null } };
}
export function scopeMatches(interaction, ctx, reply) {
  return interaction.user?.id === ctx.message.author.id && interaction.guildId === ctx.message.guildId
    && interaction.channelId === ctx.message.channelId && interaction.message?.id === reply.id;
}
export async function rejectControl(interaction) {
  await interaction.reply({ content: 'Only the command author can use these controls here.',
    flags: MessageFlags.Ephemeral, allowedMentions: noMentions }).catch(() => {});
}
export function controlsLifetime(ctx) {
  return getGameConfig(ctx.yoshiko.catalogDb, ctx.message.guildId).controls.lifetimeMs;
}
export async function retryOwnRewards(ctx, userId) {
  if (userId !== ctx.message.author.id) return;
  await retryOwedAffectionRewards(ctx.yoshiko.catalogDb, { guildId: ctx.message.guildId, userId,
    channelId: ctx.message.channelId, now: Date.now(), random: Math.random });
  // Presentation of selected overflow rewards belongs to the existing runtime recovery queue.
}
export async function run(ctx) {
  const db = ctx.yoshiko.catalogDb;
  if (!hasAffection(db)) {
    await ctx.message.reply({ content: 'Affection is not available in this catalog yet.', allowedMentions: noMentions });
    return;
  }
  const words = ctx.args.slice(1);
  const trailing = /^<@!?\d+>$/.test(words.at(-1) ?? '') ? words.pop() : undefined;
  const { targetId } = resolveUserTarget(trailing, ctx.message.author.id, ctx.message);
  const query = words.join(' ').trim();
  const matches = query ? findCharacters(ctx.yoshiko.characterIndex ?? [], query) : [];
  if (query && !matches.length) {
    await ctx.message.reply({ content: 'No character found. Try a fuller name or #rank.', allowedMentions: noMentions });
    return;
  }
  await retryOwnRewards(ctx, targetId);
  const options = { ownerName: await resolveTargetUsername(ctx.message, targetId), prefix: ctx.prefix,
    isSelf: targetId === ctx.message.author.id };
  const base = { guildId: ctx.message.guildId, userId: targetId };
  let page = 0;
  let former = false;
  let pickerPage = 0;
  let selected = matches.length === 1 ? matches[0].id : null;
  let picking = matches.length > 1;
  let expired = false;
  let busy = false;
  const render = (disabled = false) => {
    if (picking) return pickerPayload(matches, { page: pickerPage, disabled });
    if (selected != null) return detailPayload(normalizedDetail(getAffectionDetail(db, { ...base, characterId: selected, now: Date.now() })),
      { ...options, state: getSoulmateState(db, base.guildId, targetId) });
    return overviewPayload(overviewProjection(db, { ...base, page, former, pageSize: 5, now: Date.now() }), { ...options, disabled });
  };
  const reply = await ctx.message.reply(render());
  if (selected != null || !reply?.createMessageComponentCollector) return;
  const collector = reply.createMessageComponentCollector({ time: controlsLifetime(ctx) });
  collector.on('collect', async interaction => {
    if (!interaction.customId?.startsWith('affection:')) return;
    if (!scopeMatches(interaction, ctx, reply)) { await rejectControl(interaction); return; }
    if (busy || expired) { await interaction.deferUpdate().catch(() => {}); return; }
    busy = true;
    try {
      await interaction.deferUpdate();
      const id = interaction.customId;
      if (picking) {
        if (id === 'affection:choose') {
          const choice = matches.slice(pickerPage * 25, (pickerPage + 1) * 25)
            .find(row => String(row.id) === interaction.values?.[0]);
          if (!choice) return;
          selected = choice.id; picking = false;
        } else if (id === 'affection:picknext') pickerPage = Math.min(Math.ceil(matches.length / 25) - 1, pickerPage + 1);
        else if (id === 'affection:pickprev') pickerPage = Math.max(0, pickerPage - 1);
        else return;
      } else {
        const view = overviewProjection(db, { ...base, former, page, pageSize: 5 });
        if (id === 'affection:next') page = Math.min(Math.max(0, view.pages - 1), page + 1);
        else if (id === 'affection:prev') page = Math.max(0, page - 1);
        else if (id === 'affection:filter' && (former || view.hasFormer)) { former = !former; page = 0; }
        else return;
      }
      await reply.edit(render());
      if (selected != null) collector.stop('selected');
    } catch (error) {
      console.error('Affection view failed:', error);
      await interaction.followUp({ content: 'Could not refresh this affection view. Please try again.',
        flags: MessageFlags.Ephemeral, allowedMentions: noMentions }).catch(() => {});
    } finally { busy = false; }
  });
  collector.on('end', () => {
    expired = true;
    if (selected == null) reply.edit(render(true)).catch(() => {});
  });
}
