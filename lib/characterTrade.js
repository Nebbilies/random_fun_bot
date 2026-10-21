import { DatabaseSync } from 'node:sqlite';

/**
 * Ownership transfers for character trades and gifts.
 *
 * A trade swaps two characters between two players in one guild; a gift hands
 * one character over. Both reuse the `marriages` table so harem lists, escape
 * rules and protection locks keep working unchanged: only `owner_id` moves.
 */

const SOULBIND_LOCK = 'soulbind';

function validDiscordId(value) {
  return typeof value === 'string' && /^\d+$/.test(value);
}

function validCharacterId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validateIdentity(guildId, characterId, ownerId) {
  if (!validDiscordId(guildId) || !validCharacterId(characterId) || !validDiscordId(ownerId)) {
    throw new Error('Invalid character transfer identity');
  }
}

/**
 * @typedef {{status: 'transferred' | 'traded' | 'not_owned' | 'unknown_character' | 'locked' | 'escaping' | 'same_owner',
 *   name?: string, characterId?: number, ownerId?: string, first?: string, second?: string, rollback?: boolean}} TransferResult
 * @typedef {{status: 'ok' | 'not_owned' | 'unknown_character' | 'locked' | 'escaping', name?: string}} TransferCheck
 */

/**
 * Runs a query and returns its first row.
 * @param {DatabaseSync} db
 * @param {string} sql
 * @param {...any} params
 * @returns {any}
 */
function firstRow(db, sql, ...params) {
  return /** @type {any} */ (db.prepare(sql).get(...params));
}

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
function atomic(db, callback) {
  db.exec('BEGIN IMMEDIATE');
  let result;
  try {
    result = callback();
  } catch (error) {
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
 * @param {number} characterId
 * @returns {{marriageId: number, characterId: number, ownerId: string, name: string, rank: number} | null}
 */
export function getOwnedCharacter(db, guildId, ownerId, characterId) {
  validateIdentity(guildId, characterId, ownerId);
  return firstRow(db, `SELECT marriage.id AS marriageId, marriage.character_id AS characterId,
    marriage.owner_id AS ownerId, character.name_full AS name, character.rank AS rank
    FROM marriages AS marriage JOIN characters AS character ON character.id = marriage.character_id
    WHERE marriage.guild_id = ? AND marriage.owner_id = ? AND marriage.character_id = ?`,
  guildId, ownerId, characterId) ?? null;
}

/**
 * Checks that a character may change hands: it must exist, still belong to the
 * expected owner, not be soulbound and not be mid escape attempt.
 * @param {DatabaseSync} db
 * @param {string} guildId
 * @param {number} characterId
 * @param {string} ownerId
 * @returns {TransferCheck}
 */
function checkTransferable(db, guildId, characterId, ownerId) {
  const row = firstRow(db, `SELECT marriage.id AS marriageId, marriage.owner_id AS ownerId,
    character.name_full AS name FROM marriages AS marriage
    JOIN characters AS character ON character.id = marriage.character_id
    WHERE marriage.guild_id = ? AND marriage.character_id = ?`, guildId, characterId);
  if (!row) return { status: 'unknown_character' };
  if (row.ownerId !== ownerId) return { status: 'not_owned', name: row.name };
  const soulbound = firstRow(db, `SELECT 1 AS locked FROM character_protection_locks
    WHERE guild_id = ? AND character_id = ? AND lock_type = ? AND protected_until IS NULL`,
  guildId, characterId, SOULBIND_LOCK);
  if (soulbound) return { status: 'locked', name: row.name };
  const escaping = firstRow(db, `SELECT 1 AS escaping FROM character_rolls
    WHERE guild_id = ? AND character_id = ? AND escape_marriage_id IS NOT NULL AND state = 'open'`,
  guildId, characterId);
  if (escaping) return { status: 'escaping', name: row.name };
  return { status: 'ok', name: row.name };
}

/**
 * Moves one character to a new owner.
 * @param {DatabaseSync} db
 * @param {{guildId: string, characterId: number, fromOwnerId: string, toOwnerId: string, now?: number}} request
 * @returns {TransferResult}
 */
export function transferCharacter(db, request) {
  const { guildId, characterId, fromOwnerId, toOwnerId, now = Date.now() } = request;
  validateIdentity(guildId, characterId, fromOwnerId);
  validateIdentity(guildId, characterId, toOwnerId);
  if (fromOwnerId === toOwnerId) return { status: 'same_owner' };

  return atomic(db, () => {
    const check = checkTransferable(db, guildId, characterId, fromOwnerId);
    if (check.status !== 'ok') return refuse(check);
    db.prepare(`UPDATE marriages SET owner_id = ?, married_at = ?
      WHERE guild_id = ? AND character_id = ? AND owner_id = ?`)
      .run(toOwnerId, new Date(now).toISOString(), guildId, characterId, fromOwnerId);
    return { status: 'transferred', name: check.name, characterId };
  });
}

/**
 * Swaps two characters between two players. Either both move or neither does.
 * @param {DatabaseSync} db
 * @param {{guildId: string, first: {characterId: number, ownerId: string},
 *   second: {characterId: number, ownerId: string}, now?: number}} request
 * @returns {TransferResult}
 */
export function swapCharacters(db, request) {
  const { guildId, first, second, now = Date.now() } = request;
  validateIdentity(guildId, first.characterId, first.ownerId);
  validateIdentity(guildId, second.characterId, second.ownerId);
  if (first.characterId === second.characterId) return { status: 'same_owner' };
  if (first.ownerId === second.ownerId) return { status: 'same_owner' };

  return atomic(db, () => {
    const firstCheck = checkTransferable(db, guildId, first.characterId, first.ownerId);
    if (firstCheck.status !== 'ok') return refuse(firstCheck);
    const secondCheck = checkTransferable(db, guildId, second.characterId, second.ownerId);
    if (secondCheck.status !== 'ok') return refuse(secondCheck);

    const marriedAt = new Date(now).toISOString();
    db.prepare(`UPDATE marriages SET owner_id = ?, married_at = ?
      WHERE guild_id = ? AND character_id = ? AND owner_id = ?`)
      .run(second.ownerId, marriedAt, guildId, first.characterId, first.ownerId);
    db.prepare(`UPDATE marriages SET owner_id = ?, married_at = ?
      WHERE guild_id = ? AND character_id = ? AND owner_id = ?`)
      .run(first.ownerId, marriedAt, guildId, second.characterId, second.ownerId);
    return { status: 'traded', first: firstCheck.name, second: secondCheck.name };
  });
}
