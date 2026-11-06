import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, EmbedBuilder, escapeMarkdown,
  StringSelectMenuBuilder } from 'discord.js';
import { SOULMATE_CHECKPOINTS } from './affectionRules.js';

export const AFFECTION_PINK = 0xE91E63;
export const SOULMATE_GOLD = 0xF2C66D;
const mentions = { parse: [], repliedUser: false };
// Discord budgets count UTF-16 units. Never cut between surrogate pairs.
export function truncate(value, limit) {
  let text = String(value ?? '');
  if (text.length <= limit) return text;
  text = text.slice(0, Math.max(0, limit - 1));
  if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
  return `${text}…`;
}
const safe = (value, limit = 200) => truncate(escapeMarkdown(truncate(value, limit)).replace(/@/g, '@\u200b'), limit);
const number = (value) => Number(value ?? 0).toLocaleString('en-US');
export const WINDFALL_NOTICE = 'Windfall · no roll spent';
export const CONSERVATION_NOTICE = 'Item Conservation · no item charge spent';
export function itemUseFeedback(message, result) {
  return `${message}${result?.conserved ? `\n${CONSERVATION_NOTICE}` : ''}`;
}
export function appendCardNotice(payload, text) {
  if (!text) return payload;
  if (payload.embeds?.[0]) payload.embeds[0].addFields({name:'Perks',value:text});
  else payload.components?.find(c=>c instanceof ContainerBuilder)?.addTextDisplayComponents(t=>t.setContent(text));
  return payload;
}
/** Concise feedback; the surrounding card already identifies the rolled character. */
export function affectionFeedback(awards, displayedCharacterId, { showPlayer = false } = {}) {
  const groups = new Map();
  for (const award of awards.filter(a => a.amount > 0)) {
    const key=JSON.stringify([award.userId,award.characterId]);
    if (!groups.has(key)) groups.set(key,{userId:award.userId,characterId:award.characterId,name:award.name,
      amount:0,bond:false,milestones:new Map(),checkpoints:new Map()});
    const group=groups.get(key);
    group.amount+=award.amount;
    group.bond ||= award.amount>award.base;
    group.name ??= award.name;
    for (const m of award.milestones ?? []) group.milestones.set(m.key??JSON.stringify(m),m);
    for (const m of award.checkpoints ?? []) group.checkpoints.set(m.key??JSON.stringify(m),m);
  }
  return [...groups.values()].map(group => {
    const award={...group,milestones:[...group.milestones.values()],checkpoints:[...group.checkpoints.values()]};
    const label = award.characterId === displayedCharacterId ? '' : `**${safe(award.name || 'Soulmate')}**`;
    const heading=showPlayer ? `<@${award.userId}>${label?` · ${label}`:''}` : label;
    const lines = [...(heading?[heading]:[]),`❤️ **+${number(award.amount)}** affection${award.bond ? ' · Unbroken Bond' : ''}`];
    const items = award.milestones.filter(m=>m.itemId || m.tier).length;
    if (items) lines.push(`🔓 **${number(items)} item reward${items===1?'':'s'}** unlocked`);
    for (const m of award.milestones) {
      if (m.rollBonus) lines.push(`🔓 **+${number(m.rollBonus)} hourly roll** unlocked`);
      if (m.claimReductionMs) lines.push(`🔓 **${number(m.claimReductionMs/60000)}-minute claim cooldown reduction** unlocked`);
    }
    for (const checkpoint of award.checkpoints ?? []) {
      const upgraded = SOULMATE_CHECKPOINTS.some(m=>m.effect===checkpoint.effect && m.threshold<checkpoint.threshold);
      lines.push(`🔓 **${rewardLabel(checkpoint).replace(/ (\d+%)$/, ' · $1')}** ${upgraded?'upgraded':'unlocked'}`);
    }
    return lines.join('\n');
  }).join('\n\n');
}
const perks = [
  ['windfall', 'Windfall', 'spend no roll on a qualifying roll.'],
  ['itemConservation', 'Item Conservation', 'save an item charge.'],
  ['unbrokenBond', 'Unbroken Bond', 'double affection earned.'],
  ['claimConservation', 'Claim Conservation', 'save a marriage claim.'],
  ['fortunesFavor', "Fortune's Favor", 'upgrade an eligible reward one tier.'],
  ['negation', 'Negation', 'block an eligible attack.'],
  ['echo', 'Echo', 'duplicate an eligible item reward.'],
];
export function perkDescription(rates = {}) {
  return perks.map(([key, label, description]) => {
    const canonical = key.replace(/[A-Z]/g, char => `_${char.toLowerCase()}`);
    const rate = rates[canonical] ?? rates[key] ?? 0;
    const percent = rate <= 1 ? Math.round(rate * 100) : rate;
    return percent > 0 ? `${label} · ${number(percent)}% — ${description}` : '';
  }).filter(Boolean).join('\n') || 'No soulmate perks unlocked yet.';
}
export function meter(interval) {
  if (interval?.next == null || !interval.required) return 'All current rewards unlocked';
  const filled = Math.max(0, Math.min(10, Math.floor(interval.progress / interval.required * 10)));
  return `${'▰'.repeat(filled)}${'▱'.repeat(10 - filled)}  ${number(interval.progress)} / ${number(interval.required)}`;
}
function rewardLabel(reward) {
  if (typeof reward === 'string') return reward;
  if (reward.label || reward.name) return reward.label ?? reward.name;
  if (reward.effect) {
    const perk = perks.find(([key]) => key.replace(/[A-Z]/g, char => `_${char.toLowerCase()}`) === reward.effect);
    return `${perk?.[1] ?? reward.effect} ${Math.round(reward.chance * 100)}%`;
  }
  if (reward.rollBonus) return '+1 hourly roll contribution';
  if (reward.claimReductionMs) return 'six-minute claim-wait contribution';
  if (reward.tier) return `Random ${reward.tier[0].toUpperCase()}${reward.tier.slice(1)}`;
  const items = { four_leaf_clover: 'Four-Leaf Clover', hourglass_of_haste: 'Hourglass of Haste',
    love_letter: 'Love Letter', golden_whistle: 'Golden Whistle', franchise_passport: 'Franchise Passport' };
  return items[reward.itemId] ?? reward.key ?? 'Reward';
}
const nextLabels = (interval) => safe([...(interval?.rewards ?? [])]
  .sort((a, b) => Number(Boolean(b.effect)) - Number(Boolean(a.effect)))
  .map(rewardLabel).join(' + '), 700);
function contribution(value = {}) {
  const rolls = value.rollBonus ?? 0;
  const minutes = (value.claimReductionMs ?? 0) / 60000;
  return [rolls > 0 ? `+${number(rolls)} hourly ${rolls === 1 ? 'roll' : 'rolls'}` : '',
    minutes > 0 ? `${number(minutes)} min less claim waiting` : ''].filter(Boolean).join(' · ');
}
function pendingRewards(pending, prefix = '!') {
  return [pending.owed ? `${number(pending.owed)} waiting for an eligible item` : '',
    pending.pending ? `${number(pending.pending)} awaiting delivery or an inventory choice — use ${prefix}rewards` : ''].filter(Boolean).join('\n');
}
function payload(embed, components = []) {
  return { embeds: [embed], components, allowedMentions: mentions };
}
/** @param {any} detail @param {{ownerName?: string, prefix?: string, isSelf?: boolean, state?: any}} options */
export function detailPayload(detail, { ownerName, prefix, isSelf = false, state = null } = {}) {
  const active = Boolean(detail.isSoulmate && detail.isOwned);
  const embed = new EmbedBuilder().setColor(active ? SOULMATE_GOLD : AFFECTION_PINK)
    .setAuthor({ name: truncate(`♡ ${safe(ownerName)}'s ${active ? 'soulmate' : 'affection'}`, 256) })
    .setTitle(safe(detail.name || 'Unknown character', 256));
  const franchises = (detail.franchises ?? []).map(value => typeof value === 'string' ? value : value.name).filter(Boolean);
  const description = [safe(franchises.join(' · '), 700), !detail.isOwned
    ? detail.isFormer ? 'Former ownership · saved progress' : 'Not in your harem' : ''].filter(Boolean).join('\n');
  if (description) embed.setDescription(description);
  if (typeof detail.image === 'string' && detail.image.length <= 2048 && /^https?:\/\//.test(detail.image)) embed.setThumbnail(detail.image);
  const interval = detail.interval;
  const capped = interval?.next == null;
  embed.addFields({ name: 'Affection', value: truncate(`♥ ${number(detail.total)}\n${capped
    ? 'All current rewards unlocked.' : meter(interval)}`, 1024) });
  if (!capped) embed.addFields({ name: `Next at ${number(interval.next)}`, value: nextLabels(interval) || 'Reward' });
  if (active) embed.addFields({ name: 'Active soulmate perks', value: perkDescription(detail.benefits?.perks) });
  const bonuses = detail.isOwned ? contribution(detail.normalContribution) : 'Inactive — requires current ownership.';
  if (bonuses) embed.addFields({ name: active ? 'Normal contribution' : 'Normal bonuses', value: bonuses });
  if (detail.pending?.owed || detail.pending?.pending) embed.addFields({ name: 'Pending item rewards',
    value: pendingRewards(detail.pending, prefix) });
  const deadline = state?.switchAvailableAt;
  if (active && deadline) embed.addFields({ name: 'Soulmate switching', value: deadline > (detail.now ?? Date.now())
    ? `Available <t:${Math.floor(deadline / 1000)}:R>` : 'Available now' });
  const hint = active ? `${prefix}aff for all affection`
    : `${isSelf && detail.isOwned ? `${prefix}sm ${truncate(detail.name, 80)} to select · ` : ''}${prefix}aff for all affection`;
  embed.setFooter({ text: safe(hint, 500) });
  return payload(embed);
}

function button(id, label, disabled = false, style = ButtonStyle.Secondary) {
  return new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(disabled);
}
/** @param {any} view @param {{ownerName?: string, prefix?: string, disabled?: boolean}} options */
export function overviewPayload(view, { ownerName, prefix, disabled = false } = {}) {
  const benefits = view.benefits ?? {};
  const soulmate = benefits.soulmate;
  const embed = new EmbedBuilder().setColor(AFFECTION_PINK)
    .setTitle(truncate(`♡ ${safe(ownerName)}'s affection`, 256))
    .setDescription(soulmate ? `Soulmate: ♡ ${safe(soulmate.name ?? soulmate.characterId, 180)} · ♥ ${number(soulmate.total)}` : 'No soulmate selected.');
  const bonuses = contribution(benefits);
  if (bonuses) embed.addFields({ name: 'Normal harem bonuses', value: bonuses });
  embed.addFields({ name: view.former ? 'Former characters' : 'Owned characters', value: view.former
        ? 'Saved progress · inactive for benefits' : (view.rows?.length ? '\u200b' : 'No characters in your harem.') });
  if (!view.rows?.length && view.former) embed.addFields({ name: '\u200b', value: 'No saved affection from former ownership.' });
  for (const row of (view.rows ?? []).slice(0, 5)) {
    const interval = row.interval;
    embed.addFields({ name: truncate(`${row.isSoulmate ? '♡ ' : ''}${safe(row.name, 160)} · ♥ ${number(row.total)}`, 256),
      value: interval?.next == null ? 'All current rewards unlocked' : truncate(`${meter(interval)}\nNext at ${number(interval.next)}: ${nextLabels(interval)}`, 650) });
  }
  if (view.pending?.owed || view.pending?.pending) embed.addFields({ name: 'Pending item rewards',
    value: pendingRewards(view.pending, prefix) });
  const page = view.page ?? 0;
  const pages = Math.max(1, view.pages ?? 1);
  embed.setFooter({ text: safe(`Page ${page + 1} of ${pages} · ${number(view.total)} ${view.former ? 'former' : 'owned'} · ${prefix}aff <name or #rank> for details`, 500) });
  const controls = [button('affection:prev', 'Previous', disabled || page <= 0),
    button('affection:next', 'Next', disabled || page >= pages - 1)];
  if (view.former || view.hasFormer) controls.push(button('affection:filter', view.former ? 'Owned characters' : 'Former characters', disabled));
  return payload(embed, [new ActionRowBuilder().addComponents(controls)]);
}
/** @param {{ownerName?: string, prefix?: string, isSelf?: boolean}} options */
export function noSoulmatePayload({ ownerName, prefix, isSelf = false } = {}) {
  const embed = new EmbedBuilder().setColor(AFFECTION_PINK).setTitle(truncate(`♡ ${safe(ownerName)}'s soulmate`, 256))
    .setDescription('No soulmate selected.');
  if (isSelf) embed.addFields({ name: 'Choose a soulmate', value: safe(`Choose a character you own with ${prefix}soulmate <name or #rank>.`, 600) });
  return payload(embed);
}
export function confirmationPayload(detail, { disabled = false, reason = '', currentName = '' } = {}) {
  const embed = new EmbedBuilder().setColor(SOULMATE_GOLD).setTitle(truncate(`Choose ${safe(detail.name, 200)} as your soulmate?`, 256))
    .setDescription(`♥ ${number(detail.total)}\n${reason || 'Selection starts a 12-hour switching cooldown.'}${currentName?`\nReplaces **${safe(currentName,160)}** and their active soulmate perks.`:''}`)
    .addFields({ name: 'Checkpoint perks', value: perkDescription(detail.benefits?.perks) });
  return payload(embed, [new ActionRowBuilder().addComponents(
    button('soulmate:confirm', 'Confirm soulmate', disabled || Boolean(reason), ButtonStyle.Primary),
    button('soulmate:cancel', 'Cancel', disabled))]);
}
export function pickerPayload(matches, { namespace = 'affection', page = 0, disabled = false } = {}) {
  const pages = Math.ceil(matches.length / 25);
  const menu = new StringSelectMenuBuilder().setCustomId(`${namespace}:choose`).setPlaceholder('Choose a character')
    .setDisabled(disabled).addOptions(matches.slice(page * 25, (page + 1) * 25).map(row => ({
      label: truncate(`#${row.rank ?? '?'} · ${row.name_full}`, 100), value: String(row.id),
    })));
  const rows = [new ActionRowBuilder().addComponents(menu)];
  if (pages > 1) rows.push(new ActionRowBuilder().addComponents(button(`${namespace}:pickprev`, 'Previous', disabled || page === 0),
    button(`${namespace}:picknext`, 'Next', disabled || page >= pages - 1)));
  return payload(new EmbedBuilder().setColor(AFFECTION_PINK).setTitle('Choose a character')
    .setFooter({ text: `Page ${page + 1} of ${pages}` }), rows);
}
