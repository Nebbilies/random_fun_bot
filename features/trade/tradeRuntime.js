import { mentions, confirmationUser, confirmationComponents, resultPayload, transferSummary } from './tradePresentation.js';
import { createSession, findSessionByChannel, findSessionByUser, liveSession, endSession, setPicker, getPicker, clearPicker } from './tradeSessions.js';
export { prepareTransferCancellation } from './tradeSessions.js';
import { MessageFlags } from 'discord.js';
import { getGameConfig } from '../../lib/gameConfig.js';
import { listMarriages } from '../../lib/characterMarriage.js';
import { getOwnedCharacter, swapCharacterBatches, transferCharacters } from './tradeService.js';
import { CHARACTER_BATCH_LIMIT, characterSelectionProgress, planCharacterSelection } from '../../lib/characterBatchSelection.js';
import { CHARACTER_BATCH_INSTRUCTIONS, CHARACTER_PICKER_PAGE_SIZE, characterBatchLine,
    characterPickerComponents, characterPickerPage, displayCharacterQuery } from '../../lib/characterBatchPresentation.js';
import { haremListComponents, haremPageCount } from '../../lib/haremView.js';
import { markCharacterOwnership } from '../../lib/characterOwnershipDisplay.js';
import { isCharacterBusy, registerPendingTransfer } from '../../lib/characterAvailability.js';
const handlesBySession = new WeakMap();
/** @returns {any} */
function runtimeFor(session) { return handlesBySession.get(session); }
/**
 * Runtime for character trades and gifts.
 *
 * The initiator offers characters, the recipient chooses theirs for a trade,
 * and the initiator confirms. For a gift, the recipient confirms the offer.
 * Players type names and use a select menu when a name needs clarification.
 *
 * Sessions live in memory only: a trade is a short conversation, and a restart
 * simply drops it instead of leaving half finished ownership changes behind.
 */
// Each transfer freezes timing at creation, including later confirmation stages.
const YES_WORDS = new Set(['y', 'yes', 'yeah', 'yep', 'yup', 'ok', 'okay', 'sure', 'confirm']);
const NO_WORDS = new Set(['n', 'no', 'nope', 'nah', 'cancel', 'decline']);
/** @typedef {import('./tradeSessions.js').TransferSession} TransferSession */
/** @typedef {import('./tradeSessions.js').TransferCharacter} TransferCharacter */
/** @typedef {import('../../lib/characterMarriage.js').MarriageRow} MarriageRow */
/** @typedef {import('../../lib/characterBatchSelection.js').SelectionEntry} SelectionEntry */
function armTimer(db, session) {
    if (!liveSession(db, session))
        return;
    const selectedIds = [...session.offer, ...session.target].map(character => character.characterId);
    registerPendingTransfer(db, `trade:${session.id}`, session.guildId, selectedIds, Date.now() + session.rules.trades.stepTimeoutMs);
    if (runtimeFor(session).timer)
        clearTimeout(runtimeFor(session).timer);
    runtimeFor(session).timer = setTimeout(() => { void expireSession(db, session); }, session.rules.trades.stepTimeoutMs);
    runtimeFor(session).timer?.unref?.();
}
function parseUserToken(token) {
    const value = String(token ?? '').trim();
    const mention = value.match(/^<@!?(\d+)>$/);
    if (mention)
        return mention[1];
    if (/^\d+$/.test(value))
        return value;
    return null;
}
async function resolveGuildMember(message, userId) {
    const guild = message.guild;
    if (!guild)
        return null;
    const cached = guild.members?.cache?.get(userId);
    if (cached)
        return cached;
    if (typeof guild.members?.fetch === 'function') {
        try {
            return await guild.members.fetch(userId);
        }
        catch {
            return null;
        }
    }
    return null;
}
async function sendText(session, content) {
    try {
        await runtimeFor(session).channel.send({ content, allowedMentions: mentions(session) });
    }
    catch (error) {
        console.error('Could not send transfer message:', error);
    }
}
async function editResult(message, text) {
    if (!message || typeof message.edit !== 'function')
        return;
    try {
        await message.edit(resultPayload(text));
    }
    catch (error) {
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
    const render = (disabled = false) => haremListComponents(markCharacterOwnership(db, session.guildId, rows), targetId, 'rank', page, {
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
    if (!sent?.createMessageComponentCollector)
        return sent;
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
            if (interaction.customId === 'xfer:page:prev' && page > 0)
                page--;
            else if (interaction.customId === 'xfer:page:next' && page < pages - 1)
                page++;
            else
                return;
            await interaction.deferUpdate();
            if (typeof sent.edit === 'function')
                await sent.edit({ components: render(false) });
        }
        catch (error) {
            console.error('Character list paging failed:', error);
        }
    });
    collector.on('end', () => {
        if (typeof sent.edit === 'function')
            sent.edit({ components: render(true) }).catch(() => { });
    });
    return sent;
}
/**
 * Sends a paged menu for the current name. Each menu belongs to one answer.
 * @param {any} db
 * @param {TransferSession} session
 * @param {string} responderId
 * @param {SelectionEntry[]} entries
 * @param {SelectionEntry} entry
 */
async function sendCharacterPicker(db, session, responderId, entries, entry) {
    const { matches, query } = entry;
    const expectedState = session.state;
    const isCurrent = () => liveSession(db, session) && session.state === expectedState && getPicker(session) === entries;
    const chooseId = 'xfer:choose';
    const previousId = 'xfer:pick:prev';
    const nextId = 'xfer:pick:next';
    const pages = Math.ceil(matches.length / CHARACTER_PICKER_PAGE_SIZE);
    let page = 0;
    let busy = false;
    let closed = false;
    const render = (disabled = false) => characterPickerComponents({ matches, page, chooseId, previousId, nextId, disabled,
        title: matches.length === 1 ? 'Did you mean this character?' : 'Several characters match',
        detail: `<@${responderId}>, pick the character you meant by **${displayCharacterQuery(query)}**.`,
    });
    const sent = await runtimeFor(session).channel.send({
        flags: MessageFlags.IsComponentsV2,
        components: render(),
        allowedMentions: mentions(session),
    });
    if (!isCurrent()) {
        await sent?.edit?.({ components: render(true) });
        return;
    }
    const collector = sent?.createMessageComponentCollector?.({ time: session.rules.controls.lifetimeMs });
    collector?.on('collect', async (interaction) => {
        let ownsLock = false;
        try {
            if (interaction.user.id !== responderId || interaction.guildId !== session.guildId) {
                await interaction.reply({ content: 'Only the player choosing from this list can pick a character.', flags: MessageFlags.Ephemeral });
                return;
            }
            if (closed || !isCurrent()) {
                await interaction.reply({ content: 'This character picker has expired.', flags: MessageFlags.Ephemeral });
                return;
            }
            if (busy) {
                await interaction.deferUpdate();
                return;
            }
            busy = true;
            ownsLock = true;
            await interaction.deferUpdate();
            if (closed || !isCurrent()) return;
            const id = interaction.customId;
            if (id === previousId && page > 0) {
                page--;
            } else if (id === nextId && page < pages - 1) {
                page++;
            } else if (id === chooseId) {
                const picked = characterPickerPage(matches, page).find(row => String(row.characterId) === interaction.values?.[0]);
                if (!picked) return;
                entry.row = picked;
                closed = true;
                collector.stop();
                void sent.edit({ components: render(true) }).catch(console.error);
                await finishCharacterSelection(db, session, responderId, entries);
                return;
            } else {
                return;
            }
            await sent.edit({ components: render() });
        }
        catch (error) {
            console.error('Character pick failed:', error);
        }
        finally { if (ownsLock) busy = false; }
    });
    collector?.on('end', () => {
        if (closed) return;
        closed = true;
        void sent.edit({ components: render(true) }).catch(console.error);
    });
}
/**
 * Sends the final yes/no step of a trade or gift.
 * @param {any} db
 * @param {TransferSession} session
 */
async function sendConfirmation(db, session) {
    if (!session.offer.length)
        return null;
    const sent = await runtimeFor(session).channel.send({
        flags: MessageFlags.IsComponentsV2,
        components: confirmationComponents(session),
        allowedMentions: mentions(session),
    });
    runtimeFor(session).confirmMessage = sent;
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
                || runtimeFor(session).confirmMessage !== sent) {
                await interaction.reply({ content: 'This offer has expired.', flags: MessageFlags.Ephemeral });
                return;
            }
            await interaction.deferUpdate();
            if (!liveSession(db, session) || session.state !== 'awaiting_confirm' || runtimeFor(session).confirmMessage !== sent) return;
            if (interaction.customId === 'xfer:confirm')
                await completeTransfer(db, session, sent);
            else if (interaction.customId === 'xfer:cancel')
                await declineTransfer(db, session, sent, 'declined');
        }
        catch (error) {
            console.error('Transfer confirmation failed:', error);
        }
    });
    return sent;
}
/**
 * Handles a character name typed by the player who has to pick one.
 * @param {any} db
 * @param {TransferSession} session
 * @param {string} responderId
 * @param {string} query
 */
async function handleCharacterInput(db, session, responderId, query) {
    clearPicker(session);
    const rows = listMarriages(db, session.guildId, responderId, 'rank');
    const selection = planCharacterSelection(rows, query, {
        confirmFuzzy: session.kind === 'give' || session.state === 'awaiting_target',
    });
    if (selection.status === 'limit') return sendText(session, `Choose up to ${CHARACTER_BATCH_LIMIT} characters. Type the list again.`);
    if (selection.status === 'empty') return sendText(session, 'A character name is missing before or after `$`. Type the list again.');
    if (selection.status === 'missing') return sendText(session,
        `No character matching **${displayCharacterQuery(selection.query)}** in <@${responderId}>'s harem. Type the name or list again.`);
    setPicker(session, selection.entries);
    await finishCharacterSelection(db, session, responderId, selection.entries);
}

/** @param {any} db @param {TransferSession} session @param {string} responderId @param {SelectionEntry[]} entries */
async function finishCharacterSelection(db, session, responderId, entries) {
    if (!liveSession(db, session) || getPicker(session) !== entries) return;
    const selection = characterSelectionProgress(entries);
    if (selection.status === 'choose') return sendCharacterPicker(db, session, responderId, entries, selection.entry);
    clearPicker(session);
    if (selection.status === 'duplicate') return sendText(session,
        `**${displayCharacterQuery(selection.row.name_full)}** is listed more than once. Type the corrected list.`);
    await acceptCharacters(db, session, responderId, selection.rows);
}
/**
 * Records the resolved batch and advances the session.
 * @param {any} db
 * @param {TransferSession} session
 * @param {string} responderId
 * @param {MarriageRow[]} rows
 */
async function acceptCharacters(db, session, responderId, rows) {
    if (!liveSession(db, session))
        return;
    if ((session.state !== 'awaiting_offer' || responderId !== session.initiatorId)
        && (session.state !== 'awaiting_target' || responderId !== session.recipientId))
        return;
    const now = Date.now();
    /** @type {TransferCharacter[]} */
    const characters = [];
    for (const row of rows) {
        const { characterId } = row;
        const name = row.name_full || `Character ${characterId}`;
        const owned = getOwnedCharacter(db, session.guildId, responderId, characterId);
        if (owned?.marriageId !== row.id) return sendText(session,
            `The marriage for **${displayCharacterQuery(name)}** has changed. Type the name or list again.`);
        if (session.offer.some(character => character.characterId === characterId)) return sendText(session,
            `**${displayCharacterQuery(name)}** is already on the other side of the trade. Type the corrected list.`);
        if (isCharacterBusy(db, session.guildId, characterId, now, `trade:${session.id}`)) return sendText(session,
            `**${displayCharacterQuery(name)}** is committed to another action. Type the corrected list.`);
        characters.push({ characterId, name, rank: owned.rank, marriageId: owned.marriageId });
    }
    if (session.state === 'awaiting_offer') {
        session.offer = characters;
        armTimer(db, session);
        if (session.kind === 'trade') {
            session.state = 'awaiting_target';
            const recipientRows = listMarriages(db, session.guildId, session.recipientId, 'rank');
            const offer = characters.length === 1 ? ` **${displayCharacterQuery(characters[0].name)}**`
                : ` these characters\n${characters.map(characterBatchLine).join('\n')}`;
            const notice = `## 📨 <@${session.initiatorId}> wants to trade${offer}\n<@${session.recipientId}>, type what you want to offer. ${CHARACTER_BATCH_INSTRUCTIONS}`;
            await sendHarem({
                db,
                session,
                send: (payload) => runtimeFor(session).channel.send(payload),
                rows: recipientRows,
                targetId: session.recipientId,
                notice,
                ownerId: session.recipientId,
                title: `### <@${session.recipientId}>'s characters`,
            });
        }
        else {
            session.state = 'awaiting_confirm';
            await sendConfirmation(db, session);
        }
        armTimer(db, session);
        return;
    }
    if (session.state === 'awaiting_target') {
        session.target = characters;
        armTimer(db, session);
        session.state = 'awaiting_confirm';
        await sendConfirmation(db, session);
        armTimer(db, session);
    }
}
function describeStatus(status) {
    switch (status) {
        case 'not_owned': return 'the marriage has changed';
        case 'unknown_character': return 'the marriage no longer exists';
        case 'locked': return 'the character is soulbound';
        case 'escaping': return 'the character is trying to escape';
        case 'busy': return 'the character is committed to another action';
        case 'same_owner': return 'both sides belong to the same player';
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
    if (!liveSession(db, session) || session.state !== 'awaiting_confirm')
        return;
    endSession(db, session);
    const { offer, target, kind, guildId, initiatorId, recipientId } = session;
    const findName = (id) => [...offer, ...target].find(character => character.characterId === id)?.name;
    const failureMessage = (reason, name) => `⚠️ The ${kind} could not be completed. ${name ? `**${displayCharacterQuery(name)}** — ` : ''}${reason}. Nothing changed.`;
    let result;
    try {
        result = kind === 'trade'
            ? swapCharacterBatches(db, { guildId,
                first: { ownerId: initiatorId, characters: offer }, second: { ownerId: recipientId, characters: target },
            })
            : transferCharacters(db, { guildId, fromOwnerId: initiatorId, toOwnerId: recipientId, characters: offer });
    } catch (error) {
        console.error('Transfer write failed:', error);
        return editResult(sent, failureMessage('the ownership update failed', findName(error?.characterId)));
    }
    if (result.status !== 'traded' && result.status !== 'transferred') return editResult(sent,
        failureMessage(describeStatus(result.status), result.name || findName(result.characterId)));
    const initiator = `<@${initiatorId}>`;
    const recipient = `<@${recipientId}>`;
    const name = displayCharacterQuery(offer[0].name);
    if (kind === 'trade' && offer.length === 1 && target.length === 1) return editResult(sent,
        `🤝 ${initiator} and ${recipient} traded **${name}** for **${displayCharacterQuery(target[0].name)}**.`);
    if (kind === 'give' && offer.length === 1) return editResult(sent, `🎁 ${initiator} gave **${name}** to ${recipient}.`);
    const title = kind === 'trade' ? `🤝 ${initiator} and ${recipient} completed the trade.`
        : `🎁 ${initiator} gave ${offer.length} characters to ${recipient}.`;
    await editResult(sent, `${title}\n${transferSummary(session)}`);
}
/**
 * Ends the session without changing ownership.
 * @param {any} db
 * @param {TransferSession} session
 * @param {any} sent
 * @param {'declined' | 'cancelled'} reason
 */
async function declineTransfer(db, session, sent, reason) {
    if (!liveSession(db, session))
        return;
    endSession(db, session);
    const text = reason === 'cancelled'
        ? `🚫 The ${session.kind} was cancelled.`
        : `❌ <@${session.recipientId}> declined the ${session.kind}.`;
    await editResult(sent, text);
}
async function expireSession(db, session) {
    if (!liveSession(db, session))
        return;
    endSession(db, session);
    await sendText(session, `⌛ This ${session.kind} expired.`);
    await editResult(runtimeFor(session).confirmMessage, `⌛ This ${session.kind} expired.`);
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
    const session = createSession(db, {
        rules: getGameConfig(db, guildId),
        kind,
        guildId,
        channelId: message.channelId,
        initiatorId,
        recipientId: targetId,
        state: 'awaiting_offer',
        offer: [],
        target: [],
        prefix,
    }, reason => {
        const handles = runtimeFor(session);
        if (handles.timer) {
            clearTimeout(handles.timer);
            handles.timer = null;
        }
        if (reason === 'kaimetsu')
            void editResult(handles.confirmMessage, `🚫 The ${session.kind} was canceled by Kaimetsu.`);
    });
    handlesBySession.set(session, { channel: message.channel, confirmMessage: null, timer: null });
    const notice = kind === 'trade'
        ? `## 🤝 Trade with <@${targetId}>\n<@${initiatorId}>, type the characters you want to offer. ${CHARACTER_BATCH_INSTRUCTIONS}`
        : `## 🎁 Gift for <@${targetId}>\n<@${initiatorId}>, type the characters you want to give. ${CHARACTER_BATCH_INSTRUCTIONS}`;
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
    await editResult(runtimeFor(session).confirmMessage, `🚫 The ${session.kind} was cancelled.`);
}
/**
 * Consumes a chat message as an answer to a pending trade or gift.
 * @param {any} db
 * @param {any} message
 * @returns {Promise<boolean>} true when the message belonged to a pending transfer
 */
export async function onTradeAnswer(db, message) {
    if (!message?.guildId || !message?.channelId || message.author?.bot)
        return false;
    const session = findSessionByChannel(db, message.guildId, message.channelId);
    if (!session)
        return false;
    const content = String(message.content ?? '').trim();
    if (!content)
        return false;
    if (session.state === 'awaiting_offer' || session.state === 'awaiting_target') {
        const responderId = session.state === 'awaiting_offer' ? session.initiatorId : session.recipientId;
        if (message.author.id !== responderId)
            return false;
        await handleCharacterInput(db, session, responderId, content);
        return true;
    }
    if (session.state === 'awaiting_confirm') {
        if (message.author.id !== confirmationUser(session))
            return false;
        const answer = content.toLowerCase();
        if (YES_WORDS.has(answer)) {
            await completeTransfer(db, session, runtimeFor(session).confirmMessage);
            return true;
        }
        if (NO_WORDS.has(answer)) {
            await declineTransfer(db, session, runtimeFor(session).confirmMessage, 'declined');
            return true;
        }
    }
    return false;
}
