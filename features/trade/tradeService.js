import { readOwnedCharacter, readTransferOwnership, readSoulbind, readOpenEscape, writeOwnership } from './tradeRepository.js';
import { withOwnershipOperationClock } from '../../lib/characterOwnershipHistory.js';
import { DatabaseSync } from 'node:sqlite';
import { isValidCharacterId } from '../../lib/gameCharacterLookup.js';
import { isCharacterBusy, invalidateCharacterCrown } from '../../lib/characterAvailability.js';
/**
 * Ownership transfers for character trades and gifts.
 *
 * A trade swaps two characters between two players in one guild; a gift hands
 * one character over. Both reuse the `marriages` table so harem lists, escape
 * rules and protection locks keep working unchanged: only `owner_id` moves.
 */
function validDiscordId(value) {
    return typeof value === 'string' && /^\d+$/.test(value);
}
function validateIdentity(db, guildId, characterId, ownerId) {
    if (!validDiscordId(guildId) || !isValidCharacterId(characterId, db) || !validDiscordId(ownerId)) {
        throw new Error('Invalid character transfer identity');
    }
}
/**
 * @typedef {{status: 'transferred' | 'traded' | 'not_owned' | 'unknown_character' | 'locked' | 'escaping' | 'busy' | 'same_owner',
 *   name?: string, characterId?: string | number, ownerId?: string, first?: string, second?: string, rollback?: boolean}} TransferResult
 * @typedef {{status: 'ok' | 'not_owned' | 'unknown_character' | 'locked' | 'escaping' | 'busy', name?: string}} TransferCheck
 */
/**
 * Turns a failed check into a result that aborts the transaction.
 * @param {TransferCheck} check
 * @returns {TransferResult & {rollback: true}}
 */
function refuse(check) {
    return { status: /** @type {any} */ (check.status), name: check.name, rollback: true };
}
/**
 * Runs a callback inside a transaction and rolls back when the callback asks for it.
 * @template T
 * @param {DatabaseSync} db
 * @param {() => T} callback
 * @returns {T}
 */
function atomic(db, now, callback) {
    db.exec('BEGIN IMMEDIATE');
    let result;
    try {
        result = withOwnershipOperationClock(db, now, callback);
    }
    catch (error) {
        db.exec('ROLLBACK');
        throw error;
    }
    if (result && typeof result === 'object' && 'rollback' in result && result.rollback) {
        db.exec('ROLLBACK');
        return result;
    }
    db.exec('COMMIT');
    return result;
}
/**
 * Reads the character row a player owns in a guild.
 * @param {DatabaseSync} db
 * @param {string} guildId
 * @param {string} ownerId
 * @param {string | number} characterId
 * @returns {{marriageId: number, characterId: string | number, ownerId: string, name: string, rank: number} | null}
 */
export function getOwnedCharacter(db, guildId, ownerId, characterId) {
    validateIdentity(db, guildId, characterId, ownerId);
    return readOwnedCharacter(db, guildId, ownerId, characterId);
}
/**
 * Checks that a character may change hands: it must exist, still belong to the
 * expected owner, not be soulbound and not be mid escape attempt.
 * @param {DatabaseSync} db
 * @param {string} guildId
 * @param {string | number} characterId
 * @param {string} ownerId
 * @param {number} now
 * @param {number} [marriageId]
 * @returns {TransferCheck}
 */
function checkTransferable(db, guildId, characterId, ownerId, now, marriageId) {
    const row = readTransferOwnership(db, guildId, characterId);
    if (!row)
        return { status: 'unknown_character' };
    if (row.ownerId !== ownerId || (marriageId != null && row.marriageId !== marriageId))
        return { status: 'not_owned', name: row.name };
    const soulbound = readSoulbind(db, guildId, characterId, now);
    if (soulbound)
        return { status: 'locked', name: row.name };
    const escaping = readOpenEscape(db, guildId, characterId, now);
    if (escaping)
        return { status: 'escaping', name: row.name };
    if (isCharacterBusy(db, guildId, characterId, now))
        return { status: 'busy', name: row.name };
    return { status: 'ok', name: row.name };
}
/**
 * Moves one character to a new owner.
 * @param {DatabaseSync} db
 * @param {{guildId: string, characterId: string | number, fromOwnerId: string, toOwnerId: string, marriageId?: number, now?: number}} request
 * @returns {TransferResult}
 */
export function transferCharacter(db, request) {
    const { guildId, characterId, fromOwnerId, toOwnerId, now = Date.now() } = request;
    validateIdentity(db, guildId, characterId, fromOwnerId);
    validateIdentity(db, guildId, characterId, toOwnerId);
    if (fromOwnerId === toOwnerId)
        return { status: 'same_owner' };
    return atomic(db, now, () => {
        const check = checkTransferable(db, guildId, characterId, fromOwnerId, now, request.marriageId);
        if (check.status !== 'ok')
            return refuse(check);
        writeOwnership(db, guildId, characterId, fromOwnerId, toOwnerId, new Date(now).toISOString());
        invalidateCharacterCrown(db, guildId, characterId);
        return { status: 'transferred', name: check.name, characterId };
    });
}
/**
 * Swaps two characters between two players. Either both move or neither does.
 * @param {DatabaseSync} db
 * @param {{guildId: string, first: {characterId: string | number, ownerId: string, marriageId?: number},
 *   second: {characterId: string | number, ownerId: string, marriageId?: number}, now?: number}} request
 * @returns {TransferResult}
 */
export function swapCharacters(db, request) {
    const { guildId, first, second, now = Date.now() } = request;
    validateIdentity(db, guildId, first.characterId, first.ownerId);
    validateIdentity(db, guildId, second.characterId, second.ownerId);
    if (first.characterId === second.characterId)
        return { status: 'same_owner' };
    if (first.ownerId === second.ownerId)
        return { status: 'same_owner' };
    return atomic(db, now, () => {
        const firstCheck = checkTransferable(db, guildId, first.characterId, first.ownerId, now, first.marriageId);
        if (firstCheck.status !== 'ok')
            return refuse(firstCheck);
        const secondCheck = checkTransferable(db, guildId, second.characterId, second.ownerId, now, second.marriageId);
        if (secondCheck.status !== 'ok')
            return refuse(secondCheck);
        const marriedAt = new Date(now).toISOString();
        writeOwnership(db, guildId, first.characterId, first.ownerId, second.ownerId, marriedAt);
        writeOwnership(db, guildId, second.characterId, second.ownerId, first.ownerId, marriedAt);
        invalidateCharacterCrown(db, guildId, first.characterId);
        invalidateCharacterCrown(db, guildId, second.characterId);
        return { status: 'traded', first: firstCheck.name, second: secondCheck.name };
    });
}
