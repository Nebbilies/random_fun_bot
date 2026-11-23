import { readOwnedCharacter, readTransferOwnership, readSoulbind, readOpenEscape, writeOwnership } from './tradeRepository.js';
import { withOwnershipOperationClock } from '../../lib/characterOwnershipHistory.js';
import { DatabaseSync } from 'node:sqlite';
import { isValidCharacterId } from '../../lib/gameCharacterLookup.js';
import { isCharacterBusy, invalidateCharacterCrown } from '../../lib/characterAvailability.js';
/**
 * Ownership transfers for character trades and gifts.
 *
 * Trades exchange characters between two players in one guild. Gifts move
 * characters one way. Both update the existing marriage owner and timestamp.
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
 * @typedef {{characterId: string | number, marriageId: number}} MarriageSnapshot
 * @typedef {{characterId: string | number, marriageId?: number, fromOwnerId: string, toOwnerId: string}} OwnershipMove
 */
/**
 * Runs a callback inside a transaction and rolls back when the callback asks for it.
 * @template T
 * @param {DatabaseSync} db
 * @param {() => T} callback
 * @returns {T}
 */
function atomic(db, now, callback) {
    db.exec('BEGIN IMMEDIATE');
    try {
        const result = withOwnershipOperationClock(db, now, callback);
        db.exec(result && typeof result === 'object' && 'rollback' in result && result.rollback ? 'ROLLBACK' : 'COMMIT');
        return result;
    }
    catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
    }
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

/** @param {DatabaseSync} db @param {string} guildId @param {OwnershipMove[]} moves @param {number} now */
function moveCharacters(db, guildId, moves, now) {
    return atomic(db, now, () => {
        const names = [];
        for (const { characterId, fromOwnerId, marriageId } of moves) {
            const { status, name } = checkTransferable(db, guildId, characterId, fromOwnerId, now, marriageId);
            if (status !== 'ok') return { status, name, characterId, rollback: true };
            names.push(name);
        }
        const marriedAt = new Date(now).toISOString();
        for (const [index, { characterId, fromOwnerId, toOwnerId, marriageId }] of moves.entries()) {
            try {
                if (!writeOwnership(db, guildId, characterId, fromOwnerId, toOwnerId, marriedAt, marriageId)) {
                    return { status: /** @type {const} */ ('not_owned'), name: names[index], characterId, rollback: true };
                }
                invalidateCharacterCrown(db, guildId, characterId);
            } catch (error) {
                throw Object.assign(new Error(error instanceof Error ? error.message : String(error), { cause: error }), { characterId });
            }
        }
        return { status: /** @type {const} */ ('ok'), names };
    });
}

/** @param {DatabaseSync} db @param {string} guildId @param {OwnershipMove[]} moves */
function validateBatch(db, guildId, moves) {
    if (!moves.length || new Set(moves.map(move => move.characterId)).size !== moves.length) {
        throw new Error('A transfer batch requires distinct characters');
    }
    for (const { characterId, marriageId, fromOwnerId, toOwnerId } of moves) {
        validateIdentity(db, guildId, characterId, fromOwnerId);
        validateIdentity(db, guildId, characterId, toOwnerId);
        if (!marriageId || !Number.isSafeInteger(marriageId) || marriageId < 1) throw new Error('Invalid marriage ID');
    }
}

/**
 * @param {DatabaseSync} db
 * @param {{guildId: string, fromOwnerId: string, toOwnerId: string, characters: MarriageSnapshot[], now?: number}} request
 * @returns {TransferResult}
 */
export function transferCharacters(db, { guildId, fromOwnerId, toOwnerId, characters, now = Date.now() }) {
    const moves = characters.map(character => ({ ...character, fromOwnerId, toOwnerId }));
    validateBatch(db, guildId, moves);
    if (fromOwnerId === toOwnerId) return { status: 'same_owner' };
    const result = moveCharacters(db, guildId, moves, now);
    return result.status === 'ok' ? { status: 'transferred' } : result;
}

/**
 * @param {DatabaseSync} db
 * @param {{guildId: string, first: {ownerId: string, characters: MarriageSnapshot[]},
 *   second: {ownerId: string, characters: MarriageSnapshot[]}, now?: number}} request
 * @returns {TransferResult}
 */
export function swapCharacterBatches(db, { guildId, first, second, now = Date.now() }) {
    if (!first.characters.length || !second.characters.length) throw new Error('A trade requires characters on both sides');
    const moves = [
        ...first.characters.map(character => ({ ...character, fromOwnerId: first.ownerId, toOwnerId: second.ownerId })),
        ...second.characters.map(character => ({ ...character, fromOwnerId: second.ownerId, toOwnerId: first.ownerId })),
    ];
    validateBatch(db, guildId, moves);
    if (first.ownerId === second.ownerId) return { status: 'same_owner' };
    const result = moveCharacters(db, guildId, moves, now);
    return result.status === 'ok' ? { status: 'traded' } : result;
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
    const result = moveCharacters(db, guildId, [{ characterId, fromOwnerId, toOwnerId, marriageId: request.marriageId }], now);
    if (result.status === 'ok') return { status: 'transferred', name: result.names[0], characterId };
    return { status: result.status, name: result.name, rollback: true };
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
    const result = moveCharacters(db, guildId, [
        { ...first, fromOwnerId: first.ownerId, toOwnerId: second.ownerId },
        { ...second, fromOwnerId: second.ownerId, toOwnerId: first.ownerId },
    ], now);
    if (result.status === 'ok') return { status: 'traded', first: result.names[0], second: result.names[1] };
    return { status: result.status, name: result.name, rollback: true };
}
