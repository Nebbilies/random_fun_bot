import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, escapeMarkdown,
  MessageFlags, StringSelectMenuBuilder, TextDisplayBuilder } from 'discord.js';
import { getGameConfig } from './gameConfig.js';
import { listMarriages } from './characterMarriage.js';
import { getOwnedCharacter, swapCharacters, transferCharacter } from './characterTrade.js';
import { searchCharacters } from './gameCharacterLookup.js';
import { haremListComponents, haremPageCount } from './haremView.js';
import { markCharacterOwnership } from './characterOwnershipDisplay.js';
import { formatNumber } from './formatNumber.js';
import { isCharacterBusy, registerPendingTransfer, unregisterPendingTransfer } from './characterAvailability.js';

/**
 * Runtime for character trades and gifts.
 *
 * A trade walks three players' steps in one channel: the initiator offers one of
 * their characters, the recipient offers one of theirs, and the initiator
 * confirms the swap. A gift walks two: the initiator offers a character and the
 * recipient confirms. Answers are typed character names (with a select menu as
 * a fallback for ambiguous names) and the final step also takes a yes/no.
 *
 * Sessions live in memory only: a trade is a short conversation, and a restart
 * simply drops it instead of leaving half finished ownership changes behind.
 */

// Each transfer freezes timing at creation, including later confirmation stages.
const PICKER_OPTION_LIMIT = 25;

const YES_WORDS = new Set(['y', 'yes', 'yeah', 'yep', 'yup', 'ok', 'okay', 'sure', 'confirm']);
const NO_WORDS = new Set(['n', 'no', 'nope', 'nah', 'cancel', 'decline']);

/**
 * @typedef {{characterId: string | number, name: string, marriageId: number}} TransferCharacter
 * @typedef {object} TransferSession
 * @property {number} id
 * @property {ReturnType<typeof getGameConfig>} rules
 * @property {'trade' | 'give'} kind
 * @property {string} guildId
 * @property {string} channelId
 * @property {any} channel
 * @property {string} initiatorId
 * @property {string} recipientId
 * @property {'awaiting_offer' | 'awaiting_target' | 'awaiting_confirm'} state
 * @property {TransferCharacter | null} offer
 * @property {TransferCharacter | null} target
 * @property {any} confirmMessage
 * @property {string} prefix
 * @property {any} timer
 */

/** @type {WeakMap<any, Map<number, TransferSession>>} */
const sessionsByDb = new WeakMap();
let sessionCounter = 0;

function sessionStore(db) {
  let sessions = sessionsByDb.get(db);
  if (!sessions) {
    sessions = new Map();
    sessionsByDb.set(db, sessions);
  }
  return sessions;
}

function findSessionByChannel(db, guildId, channelId) {
  for (const session of sessionStore(db).values()) {
    if (session.guildId === guildId && session.channelId === channelId) return session;
  }
  return null;
}

function findSessionByUser(db, guildId, userId) {
  if (!guildId) return null;
  for (const session of sessionStore(db).values()) {
    if (session.guildId !== guildId) continue;
    if (session.initiatorId === userId || session.recipientId === userId) return session;
  }
  return null;
}

function liveSession(db, session) {
  return sessionStore(db).get(session.id) === session;
}

function endSession(db, session) {
  unregisterPendingTransfer(db, `trade:${session.id}`);
  if (session.timer) {
    clearTimeout(session.timer);
    session.timer = null;
  }
  sessionStore(db).delete(session.id);
}

/** Snapshot matching sessions without mutating memory before the DB commit.
 * Exact marriage identities prevent cancellation of a later remarriage's offer.
 * The callback is synchronous and performs no fallible network work.
 */
export function prepareTransferCancellation(db, guildId, selected) {
  const matches = [...sessionStore(db).values()].filter((session) => session.guildId === guildId
    && selected.some((row) =>
      (session.offer != null && session.offer.characterId === row.characterId && session.offer.marriageId === row.marriageId && session.initiatorId === row.ownerId)
      || (session.target != null && session.target.characterId === row.characterId && session.target.marriageId === row.marriageId && session.recipientId === row.ownerId)));
  return () => {
    for (const session of matches) {
      if (!liveSession(db, session)) continue;
      endSession(db, session);
      // Controls already fail liveSession before this best-effort visual update.
      void editResult(session.confirmMessage, `🚫 The ${session.kind} was canceled by Kaimetsu.`);
    }
  };
}

function armTimer(db, session) {
  if (!liveSession(db, session)) return;
  registerPendingTransfer(db, `trade:${session.id}`, session.guildId,
    [session.offer?.characterId, session.target?.characterId].filter((id) => id != null), Date.now() + session.rules.trades.stepTimeoutMs);
  if (session.timer) clearTimeout(session.timer);
  session.timer = setTimeout(() => { void expireSession(db, session); }, session.rules.trades.stepTimeoutMs);
  session.timer?.unref?.();
}

function mentions(session) {
  return { parse: [], users: [session.initiatorId, session.recipientId], repliedUser: false };
}

function parseUserToken(token) {
  const value = String(token ?? '').trim();
  const mention = value.match(/^<@!?(\d+)>$/);
  if (mention) return mention[1];
  if (/^\d+$/.test(value)) return value;
  return null;
}

async function resolveGuildMember(message, userId) {
  const guild = message.guild;
  if (!guild) return null;
  const cached = guild.members?.cache?.get(userId);
  if (cached) return cached;
  if (typeof guild.members?.fetch === 'function') {
    try {
      return await guild.members.fetch(userId);
    } catch {
      return null;
    }
  }
  return null;
}

function characterLabel(row) {
  const name = row.name_full || `Character ${row.characterId ?? row.id}`;
  const label = `#${formatNumber(row.rank)} • ${name}`;
  return label.length > 100 ? `${label.slice(0, 99)}…` : label;
}

/**
 * Builds an action row; the builder generics are wider than discord.js accepts.
 * @param {any[]} components
 * @returns {any}
 */
function actionRow(components) {
  return /** @type {any} */ (new ActionRowBuilder().addComponents(components));
}

async function sendText(session, content) {
  try {
    await session.channel.send({ content, allowedMentions: mentions(session) });
  } catch (error) {
    console.error('Could not send transfer message:', error);
  }
}

async function editResult(message, text) {
  if (!message || typeof message.edit !== 'function') return;
  try {
    await message.edit({
      components: [new ContainerBuilder().setAccentColor(0x5865f2)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(text))],
    });
  } catch (error) {
    console.error('Could not update transfer message:', error);
  }
}

/**
 * Sends a character list the given player picks from, with paging buttons.
 * @param {{db: any, session: TransferSession, send: (payload: any) => Promise<any>, rows: any[],
 *   targetId: string, notice: string, ownerId: string, title: string}} request
 */
async function sendHarem(request) {
  const { db, session, send, rows, targetId, notice, ownerId, title } = request;
  let page = 0;
  const pages = haremPageCount(rows);
  const render = (disabled = false) => haremListComponents(
    markCharacterOwnership(db, session.guildId, rows), targetId, 'rank', page, {
      disabled,
      notice,
      title,
      prevId: 'xfer:page:prev',
      nextId: 'xfer:page:next',
    });

  const sent = await send({
    flags: MessageFlags.IsComponentsV2,
    components: render(false),
    allowedMentions: mentions(session),
  });
  if (!sent?.createMessageComponentCollector) return sent;

  const collector = sent.createMessageComponentCollector({ time: session.rules.controls.lifetimeMs });
  collector.on('collect', async (interaction) => {
    try {
      if (interaction.user.id !== ownerId || interaction.guildId !== session.guildId) {
        await interaction.reply({
          content: 'Only the player choosing from this list can page through it.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (interaction.customId === 'xfer:page:prev' && page > 0) page--;
      else if (interaction.customId === 'xfer:page:next' && page < pages - 1) page++;
      else return;
      await interaction.deferUpdate();
      if (typeof sent.edit === 'function') await sent.edit({ components: render(false) });
    } catch (error) {
      console.error('Character list paging failed:', error);
    }
  });
  collector.on('end', () => {
    if (typeof sent.edit === 'function') sent.edit({ components: render(true) }).catch(() => {});
  });
  return sent;
}

/**
 * Sends a select menu for names that match more than one character.
 * @param {any} db
 * @param {TransferSession} session
 * @param {string} responderId
 * @param {any[]} matches
 */
async function sendCharacterPicker(db, session, responderId, matches) {
  const pickerToken = {};
  currentPickers.set(session, pickerToken);
  const options = matches.slice(0, PICKER_OPTION_LIMIT).map((row) => ({
    label: characterLabel(row),
    value: String(row.characterId ?? row.id),
  }));
  const container = new ContainerBuilder().setAccentColor(0x5865f2)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `## ${matches.length === 1 ? 'Did you mean this character?' : 'Several characters match'}\n<@${responderId}>, pick the character you meant.`))
    .addActionRowComponents(actionRow([
      new StringSelectMenuBuilder()
        .setCustomId(`xfer:choose:${session.id}`)
        .setPlaceholder('Select a character')
        .addOptions(options)]));

  const sent = await session.channel.send({
    flags: MessageFlags.IsComponentsV2,
    components: [container],
    allowedMentions: mentions(session),
  });
  const collector = sent?.createMessageComponentCollector?.({ time: session.rules.controls.lifetimeMs });
  collector?.on('collect', async (interaction) => {
    try {
      if (interaction.user.id !== responderId || interaction.guildId !== session.guildId) {
        await interaction.reply({
          content: 'Only the player choosing from this list can pick a character.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const expectedState = responderId === session.initiatorId ? 'awaiting_offer' : 'awaiting_target';
      if (!liveSession(db, session) || session.state !== expectedState || currentPickers.get(session) !== pickerToken) {
        await interaction.reply({ content: 'This character picker has expired.', flags: MessageFlags.Ephemeral });
        return;
      }
      const value = interaction.values?.[0];
      const picked = matches.slice(0, PICKER_OPTION_LIMIT)
        .find((row) => String(row.characterId ?? row.id) === value);
      if (!picked) return;
      await interaction.deferUpdate();
      if (currentPickers.get(session) !== pickerToken) return;
      currentPickers.delete(session);
      await acceptCharacter(db, session, responderId, picked);
    } catch (error) {
      console.error('Character pick failed:', error);
    }
  });
  return sent;
}

function confirmationUser(session) {
  return session.kind === 'trade' ? session.initiatorId : session.recipientId;
}

/**
 * Sends the final yes/no step of a trade or gift.
 * @param {any} db
 * @param {TransferSession} session
 */
async function sendConfirmation(db, session) {
  const isTrade = session.kind === 'trade';
  const offer = session.offer;
  if (!offer) return null;
  const target = session.target;
  const text = isTrade
    ? `## 🤝 Trade proposal\n<@${session.initiatorId}> trades **${escapeMarkdown(offer.name)}** for **${escapeMarkdown(target?.name ?? '')}**.\n<@${confirmationUser(session)}>, confirm?`
    : `## 🎁 Gift offer\n<@${session.recipientId}>: <@${session.initiatorId}> wants to give you **${escapeMarkdown(offer.name)}**, confirm?`;
  const container = new ContainerBuilder().setAccentColor(isTrade ? 0x5865f2 : 0x57f287)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(text))
    .addActionRowComponents(actionRow([
      new ButtonBuilder().setCustomId('xfer:confirm').setLabel('Confirm').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('xfer:cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary)]));

  const sent = await session.channel.send({
    flags: MessageFlags.IsComponentsV2,
    components: [container],
    allowedMentions: mentions(session),
  });
  session.confirmMessage = sent;

  const collector = sent?.createMessageComponentCollector?.({ time: session.rules.controls.lifetimeMs });
  collector?.on('collect', async (interaction) => {
    try {
      if (interaction.user.id !== confirmationUser(session) || interaction.guildId !== session.guildId) {
        await interaction.reply({
          content: `Only <@${confirmationUser(session)}> can answer this ${session.kind}.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (!liveSession(db, session) || session.state !== 'awaiting_confirm'
        || session.confirmMessage !== sent) {
        await interaction.reply({ content: 'This offer has expired.', flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.deferUpdate();
      if (interaction.customId === 'xfer:confirm') await completeTransfer(db, session, sent);
      else if (interaction.customId === 'xfer:cancel') await declineTransfer(db, session, sent, 'declined');
    } catch (error) {
      console.error('Transfer confirmation failed:', error);
    }
  });
  return sent;
}

const currentPickers = new WeakMap();

/**
 * Handles a character name typed by the player who has to pick one.
 * @param {any} db
 * @param {TransferSession} session
 * @param {string} responderId
 * @param {string} query
 */
async function handleCharacterInput(db, session, responderId, query) {
  currentPickers.delete(session);
  const rows = listMarriages(db, session.guildId, responderId, 'rank');
  const { matches, matchType } = searchCharacters(rows, query);
  if (!matches.length) {
    await sendText(session,
      `No character matching **${escapeMarkdown(query)}** in <@${responderId}>'s harem. Type the character name again.`);
    return;
  }
  const needsTypoAcceptance = matchType === 'fuzzy'
    && (session.kind === 'give' || session.state === 'awaiting_target');
  if (matches.length > 1 || needsTypoAcceptance) {
    await sendCharacterPicker(db, session, responderId, matches);
    return;
  }
  await acceptCharacter(db, session, responderId, matches[0]);
}

/**
 * Records the picked character and moves the session to its next step.
 * @param {any} db
 * @param {TransferSession} session
 * @param {string} responderId
 * @param {any} row
 */
async function acceptCharacter(db, session, responderId, row) {
  if (!liveSession(db, session)) return;
  if ((session.state !== 'awaiting_offer' || responderId !== session.initiatorId)
    && (session.state !== 'awaiting_target' || responderId !== session.recipientId)) return;
  const characterId = row.characterId ?? row.id;
  const name = row.name_full || `Character ${characterId}`;
  const owned = getOwnedCharacter(db, session.guildId, responderId, characterId);
  if (!owned) {
    await sendText(session, `<@${responderId}> does not own **${escapeMarkdown(name)}** anymore.`);
    return;
  }

  if (isCharacterBusy(db, session.guildId, characterId, Date.now(), `trade:${session.id}`)) {
    await sendText(session, 'That character is committed to another action. Pick another character.');
    return;
  }

  if (session.state === 'awaiting_offer') {
    session.offer = { characterId, name, marriageId: owned.marriageId };
    armTimer(db, session);
    if (session.kind === 'trade') {
      session.state = 'awaiting_target';
      const recipientRows = listMarriages(db, session.guildId, session.recipientId, 'rank');
      const notice = `## 📨 <@${session.initiatorId}> wants to trade **${escapeMarkdown(name)}**\n<@${session.recipientId}>, type the name of the character you want to trade for.`;
      await sendHarem({
        db,
        session,
        send: (payload) => session.channel.send(payload),
        rows: recipientRows,
        targetId: session.recipientId,
        notice,
        ownerId: session.recipientId,
        title: `### <@${session.recipientId}>'s characters`,
      });
    } else {
      session.state = 'awaiting_confirm';
      await sendConfirmation(db, session);
    }
    armTimer(db, session);
    return;
  }

  if (session.state === 'awaiting_target') {
    if (characterId === session.offer?.characterId) {
      await sendText(session, 'Pick a different character to trade for.');
      return;
    }
    session.target = { characterId, name, marriageId: owned.marriageId };
    armTimer(db, session);
    session.state = 'awaiting_confirm';
    await sendConfirmation(db, session);
    armTimer(db, session);
  }
}

function describeStatus(status) {
  switch (status) {
    case 'not_owned': return 'that character is no longer owned by the giver';
    case 'unknown_character': return 'that character no longer exists';
    case 'locked': return 'that character is soulbound';
    case 'escaping': return 'that character is trying to escape';
    case 'busy': return 'that character is committed to another action';
    case 'same_owner': return 'both characters belong to the same player';
    default: return status;
  }
}

/**
 * Applies the confirmed trade or gift.
 * @param {any} db
 * @param {TransferSession} session
 * @param {any} sent
 */
async function completeTransfer(db, session, sent) {
  if (!liveSession(db, session) || session.state !== 'awaiting_confirm') return;
  endSession(db, session);
  const offer = session.offer;
  const target = session.target;
  if (!offer) return;
  const result = session.kind === 'trade'
    ? swapCharacters(db, {
      guildId: session.guildId,
      first: { characterId: offer.characterId, ownerId: session.initiatorId, marriageId: offer.marriageId },
      second: { characterId: target?.characterId ?? offer.characterId, ownerId: session.recipientId, marriageId: target?.marriageId },
    })
    : transferCharacter(db, {
      guildId: session.guildId,
      characterId: offer.characterId,
      marriageId: offer.marriageId,
      fromOwnerId: session.initiatorId,
      toOwnerId: session.recipientId,
    });

  const succeeded = session.kind === 'trade' ? result.status === 'traded' : result.status === 'transferred';
  const text = succeeded
    ? (session.kind === 'trade'
      ? `🤝 <@${session.initiatorId}> and <@${session.recipientId}> traded **${escapeMarkdown(offer.name)}** for **${escapeMarkdown(target?.name ?? '')}**.`
      : `🎁 <@${session.initiatorId}> gave **${escapeMarkdown(offer.name)}** to <@${session.recipientId}>.`)
    : `⚠️ The ${session.kind} could not be completed: ${describeStatus(result.status)}. Nothing changed.`;
  await editResult(sent, text);
}

/**
 * Ends the session without changing ownership.
 * @param {any} db
 * @param {TransferSession} session
 * @param {any} sent
 * @param {'declined' | 'cancelled'} reason
 */
async function declineTransfer(db, session, sent, reason) {
  if (!liveSession(db, session)) return;
  endSession(db, session);
  const text = reason === 'cancelled'
    ? `🚫 The ${session.kind} was cancelled.`
    : `❌ <@${session.recipientId}> declined the ${session.kind}.`;
  await editResult(sent, text);
}

async function expireSession(db, session) {
  if (!sessionStore(db).has(session.id)) return;
  endSession(db, session);
  await sendText(session, `⌛ This ${session.kind} expired.`);
  await editResult(session.confirmMessage, `⌛ This ${session.kind} expired.`);
}

/**
 * Starts a trade with another player.
 * @param {any} ctx
 */
export async function startTrade(ctx) {
  await beginTransfer(ctx, 'trade');
}

/**
 * Starts a gift to another player.
 * @param {any} ctx
 */
export async function startGift(ctx) {
  await beginTransfer(ctx, 'give');
}

/**
 * @param {any} ctx
 * @param {'trade' | 'give'} kind
 */
async function beginTransfer(ctx, kind) {
  const { yoshiko, message } = ctx;
  const prefix = ctx.prefix ?? '!';
  const db = yoshiko.catalogDb;
  const guildId = message.guildId;
  if (!guildId) {
    await message.reply('This command only works in a server.');
    return;
  }

  const usage = `Usage: ${prefix}${ctx.args?.[0] || (kind === 'trade' ? 'me' : 'give')} @user`;
  const targetId = parseUserToken(ctx.args?.[1]);
  if (!targetId) {
    await message.reply(usage);
    return;
  }
  const initiatorId = message.author.id;
  if (targetId === initiatorId) {
    await message.reply(kind === 'trade'
      ? 'You cannot trade with yourself.'
      : 'You cannot gift a character to yourself.');
    return;
  }
  if (!(await resolveGuildMember(message, targetId))) {
    await message.reply('That user is not in this server.');
    return;
  }

  if (findSessionByUser(db, guildId, initiatorId)) {
    await message.reply(`You already have a pending trade or gift. Use ${prefix}cancel to end it.`);
    return;
  }
  if (findSessionByUser(db, guildId, targetId)) {
    await message.reply(`<@${targetId}> already has a pending trade or gift.`);
    return;
  }
  if (findSessionByChannel(db, guildId, message.channelId)) {
    await message.reply('Another trade or gift is already in progress in this channel.');
    return;
  }

  const initiatorRows = listMarriages(db, guildId, initiatorId, 'rank');
  if (!initiatorRows.length) {
    await message.reply(kind === 'trade'
      ? 'You do not own any characters to trade.'
      : 'You do not own any characters to give.');
    return;
  }
  if (kind === 'trade' && !listMarriages(db, guildId, targetId, 'rank').length) {
    await message.reply(`<@${targetId}> does not own any characters to trade.`);
    return;
  }

  /** @type {TransferSession} */
  const session = {
    id: ++sessionCounter,
    rules: getGameConfig(db, guildId),
    kind,
    guildId,
    channelId: message.channelId,
    channel: message.channel,
    initiatorId,
    recipientId: targetId,
    state: 'awaiting_offer',
    offer: null,
    target: null,
    confirmMessage: null,
    prefix,
    timer: null,
  };
  sessionStore(db).set(session.id, session);

  const notice = kind === 'trade'
    ? `## 🤝 Trade with <@${targetId}>\n<@${initiatorId}>, type the name of the character you want to offer.`
    : `## 🎁 Gift for <@${targetId}>\n<@${initiatorId}>, type the name of the character you want to give.`;
  await sendHarem({
    db,
    session,
    send: (payload) => message.reply(payload),
    rows: initiatorRows,
    targetId: initiatorId,
    notice,
    ownerId: initiatorId,
    title: `### <@${initiatorId}>'s characters`,
  });
  armTimer(db, session);
}

/**
 * Cancels the pending trade or gift of the calling player.
 * @param {any} ctx
 */
export async function cancelTransfer(ctx) {
  const { yoshiko, message } = ctx;
  const db = yoshiko.catalogDb;
  const session = findSessionByUser(db, message.guildId, message.author.id);
  if (!session) {
    await message.reply('There is no pending trade or gift to cancel.');
    return;
  }
  endSession(db, session);
  await message.reply(`The ${session.kind} was cancelled.`);
  await editResult(session.confirmMessage, `🚫 The ${session.kind} was cancelled.`);
}

/**
 * Consumes a chat message as an answer to a pending trade or gift.
 * @param {any} db
 * @param {any} message
 * @returns {Promise<boolean>} true when the message belonged to a pending transfer
 */
export async function onTradeAnswer(db, message) {
  if (!message?.guildId || !message?.channelId || message.author?.bot) return false;
  const session = findSessionByChannel(db, message.guildId, message.channelId);
  if (!session) return false;
  const content = String(message.content ?? '').trim();
  if (!content) return false;

  if (session.state === 'awaiting_offer' || session.state === 'awaiting_target') {
    const responderId = session.state === 'awaiting_offer' ? session.initiatorId : session.recipientId;
    if (message.author.id !== responderId) return false;
    await handleCharacterInput(db, session, responderId, content);
    return true;
  }

  if (session.state === 'awaiting_confirm') {
    if (message.author.id !== confirmationUser(session)) return false;
    const answer = content.toLowerCase();
    if (YES_WORDS.has(answer)) {
      await completeTransfer(db, session, session.confirmMessage);
      return true;
    }
    if (NO_WORDS.has(answer)) {
      await declineTransfer(db, session, session.confirmMessage, 'declined');
      return true;
    }
  }
  return false;
}
