import { unregisterPendingTransfer } from '../../lib/characterAvailability.js';
import { getGameConfig } from '../../lib/gameConfig.js';
/**
 * @typedef {{characterId: string | number, name: string, rank: number, marriageId: number}} TransferCharacter
 * @typedef {object} TransferSession
 * @property {number} id
 * @property {ReturnType<typeof getGameConfig>} rules
 * @property {'trade' | 'give'} kind
 * @property {string} guildId
 * @property {number} [season]
 * @property {string} channelId
 * @property {string} initiatorId
 * @property {string} recipientId
 * @property {'awaiting_offer' | 'awaiting_target' | 'awaiting_confirm'} state
 * @property {TransferCharacter[]} offer
 * @property {TransferCharacter[]} target
 * @property {string} prefix
 */
const terminationCallbacks = new WeakMap();
const currentPickers = new WeakMap();
/** @param {any} db @param {any} values @param {(reason: string) => void} onEnd @returns {TransferSession} */
export function createSession(db, values, onEnd) {
    const session = { ...values, id: ++sessionCounter };
    sessionStore(db).set(session.id, session);
    terminationCallbacks.set(session, onEnd);
    return session;
}
export function setPicker(session, token) { currentPickers.set(session, token); }
export function getPicker(session) { return currentPickers.get(session); }
export function clearPicker(session) { currentPickers.delete(session); }
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
export function findSessionByChannel(db, guildId, channelId) {
    for (const session of sessionStore(db).values()) {
        if (session.guildId === guildId && session.channelId === channelId)
            return session;
    }
    return null;
}
export function findSessionByUser(db, guildId, userId) {
    if (!guildId)
        return null;
    for (const session of sessionStore(db).values()) {
        if (session.guildId !== guildId)
            continue;
        if (session.initiatorId === userId || session.recipientId === userId)
            return session;
    }
    return null;
}
export function liveSession(db, session) {
    return sessionStore(db).get(session.id) === session;
}
export function expireGuildTransfers(db, guildId) {
    for (const session of sessionStore(db).values()) {
        if (session.guildId === guildId) endSession(db,session,'season-ended');
    }
}
export function endSession(db, session, reason = 'ended') {
    if (!liveSession(db, session))
        return;
    sessionStore(db).delete(session.id);
    unregisterPendingTransfer(db, `trade:${session.id}`);
    currentPickers.delete(session);
    try {
        terminationCallbacks.get(session)?.(reason);
    }
    catch (error) {
        console.error('Transfer termination notification failed:', error);
    }
}
/** Snapshot matching sessions without mutating memory before the DB commit.
 * Exact marriage identities prevent cancellation of a later remarriage's offer.
 * The callback is synchronous and performs no fallible network work.
 */
export function prepareTransferCancellation(db, guildId, selected) {
    const matches = [...sessionStore(db).values()].filter((session) => session.guildId === guildId
        && selected.some((row) => {
            const side = row.ownerId === session.initiatorId ? session.offer
                : row.ownerId === session.recipientId ? session.target : [];
            return side.some(character => character.characterId === row.characterId && character.marriageId === row.marriageId);
        }));
    return () => {
        for (const session of matches) {
            if (!liveSession(db, session))
                continue;
            endSession(db, session, 'kaimetsu');
        }
    };
}
