import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, escapeMarkdown, StringSelectMenuBuilder, TextDisplayBuilder } from 'discord.js';
import { formatNumber } from '../../lib/formatNumber.js';
export const PICKER_OPTION_LIMIT = 25;
export function mentions(session) {
    return { parse: [], users: [session.initiatorId, session.recipientId], repliedUser: false };
}
export function characterLabel(row) {
    const name = row.name_full || `Character ${row.characterId ?? row.id}`;
    const label = `#${formatNumber(row.rank)} • ${name}`;
    return label.length > 100 ? `${label.slice(0, 99)}…` : label;
}
/**
 * Builds an action row; the builder generics are wider than discord.js accepts.
 * @param {any[]} components
 * @returns {any}
 */
export function actionRow(components) {
    return /** @type {any} */ (new ActionRowBuilder().addComponents(components));
}
export function confirmationUser(session) {
    return session.kind === 'trade' ? session.initiatorId : session.recipientId;
}
export function pickerComponents(session, responderId, matches) {
    const options = matches.slice(0, PICKER_OPTION_LIMIT).map((row) => ({
        label: characterLabel(row),
        value: String(row.characterId ?? row.id),
    }));
    const container = new ContainerBuilder().setAccentColor(0x5865f2)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ${matches.length === 1 ? 'Did you mean this character?' : 'Several characters match'}\n<@${responderId}>, pick the character you meant.`))
        .addActionRowComponents(actionRow([
        new StringSelectMenuBuilder()
            .setCustomId(`xfer:choose:${session.id}`)
            .setPlaceholder('Select a character')
            .addOptions(options)
    ]));
    return [container];
}
export function confirmationComponents(session) {
    const isTrade = session.kind === 'trade';
    const offer = session.offer;
    if (!offer)
        return null;
    const target = session.target;
    const text = isTrade
        ? `## 🤝 Trade proposal\n<@${session.initiatorId}> trades **${escapeMarkdown(offer.name)}** for **${escapeMarkdown(target?.name ?? '')}**.\n<@${confirmationUser(session)}>, confirm?`
        : `## 🎁 Gift offer\n<@${session.recipientId}>: <@${session.initiatorId}> wants to give you **${escapeMarkdown(offer.name)}**, confirm?`;
    const container = new ContainerBuilder().setAccentColor(isTrade ? 0x5865f2 : 0x57f287)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(text))
        .addActionRowComponents(actionRow([
        new ButtonBuilder().setCustomId('xfer:confirm').setLabel('Confirm').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('xfer:cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
    ]));
    return [container];
}
export function resultPayload(text) {
    return { components: [new ContainerBuilder().setAccentColor(0x5865f2)
                .addTextDisplayComponents(new TextDisplayBuilder().setContent(text))] };
}
