import {
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  TextDisplayBuilder,
} from "discord.js";
import {
  characterActionRow,
  characterBatchLine,
  displayCharacterQuery,
} from "../../lib/characterBatchPresentation.js";
import { formatNumber } from "../../lib/formatNumber.js";

/** @typedef {import('./tradeSessions.js').TransferSession} TransferSession */

export function mentions(session) {
  return {
    parse: [],
    users: [session.initiatorId, session.recipientId],
    repliedUser: false,
  };
}

export function confirmationUser(session) {
  return session.kind === "trade" ? session.initiatorId : session.recipientId;
}

/** @param {TransferSession} session */
export function transferSummary(session) {
  const { offer, target, initiatorId, recipientId } = session;
  const offered = offer.map(characterBatchLine).join("\n");
  return session.kind === "give"
    ? offered
    : `**<@${initiatorId}> offers**\n${offered}\n\n**<@${recipientId}> offers**\n${target.map(characterBatchLine).join("\n")}`;
}

/** @param {TransferSession} session */
export function confirmationComponents(session) {
  const { kind, initiatorId, recipientId } = session;
  const isTrade = kind === "trade";
  const [offer] = session.offer;
  if (!offer) return null;
  const [target] = session.target;
  const title = isTrade ? "🤝 Trade proposal" : "🎁 Gift offer";
  const ask = `<@${confirmationUser(session)}>, confirm?`;
  let detail = `${transferSummary(session)}\n${ask}`;
  if (session.offer.length === 1 && session.target.length <= 1) {
    const name = displayCharacterQuery(offer.name);
    detail = target
      ? `<@${initiatorId}> trades **${name}** for **${displayCharacterQuery(target.name)}**.\n#${formatNumber(offer.rank)} for #${formatNumber(target.rank)}\n${ask}`
      : `<@${recipientId}>: <@${initiatorId}> wants to give you **${name}**, confirm?\n#${formatNumber(offer.rank)}`;
  } else if (!isTrade) {
    detail = `<@${initiatorId}> wants to give these characters to <@${recipientId}>.\n${detail}`;
  }
  const container = new ContainerBuilder()
    .setAccentColor(isTrade ? 0x5865f2 : 0x57f287)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`## ${title}\n${detail}`),
    )
    .addActionRowComponents(
      characterActionRow(
        new ButtonBuilder()
          .setCustomId("xfer:confirm")
          .setLabel("Confirm")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId("xfer:cancel")
          .setLabel("Cancel")
          .setStyle(ButtonStyle.Secondary),
      ),
    );
  return [container];
}

export function resultPayload(text) {
  return {
    components: [
      new ContainerBuilder()
        .setAccentColor(0x5865f2)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(text)),
    ],
    allowedMentions: { parse: [] },
  };
}
