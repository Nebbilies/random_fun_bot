import { DatabaseSync } from 'node:sqlite';
const SOULBIND_LOCK = 'soulbind';
/** @param {DatabaseSync} db @param {string} sql @param {...any} params @returns {any} */
function firstRow(db, sql, ...params) {
    return /** @type {any} */ (db.prepare(sql).get(...params));
}
export function readOwnedCharacter(db, guildId, ownerId, characterId) {
    return firstRow(db, `SELECT marriage.id AS marriageId, marriage.character_id AS characterId,
    marriage.owner_id AS ownerId, character.name_full AS name, character.rank AS rank
    FROM marriages AS marriage JOIN characters AS character ON character.id = marriage.character_id
    WHERE marriage.guild_id = ? AND marriage.owner_id = ? AND marriage.character_id = ?`, guildId, ownerId, characterId) ?? null;
}
export function readTransferOwnership(db, guildId, characterId) {
    return firstRow(db, `SELECT marriage.id AS marriageId, marriage.owner_id AS ownerId,
    character.name_full AS name FROM marriages AS marriage
    JOIN characters AS character ON character.id = marriage.character_id
    WHERE marriage.guild_id = ? AND marriage.character_id = ?`, guildId, characterId);
}
export function readSoulbind(db, guildId, characterId, now) {
    return firstRow(db, `SELECT 1 AS locked FROM character_protection_locks
    WHERE guild_id = ? AND character_id = ? AND lock_type = ?
      AND (protected_until IS NULL OR protected_until > ?)`, guildId, characterId, SOULBIND_LOCK, now);
}
export function readOpenEscape(db, guildId, characterId, now) {
    return firstRow(db, `SELECT 1 AS escaping FROM character_rolls
    WHERE guild_id = ? AND character_id = ? AND escape_marriage_id IS NOT NULL AND state = 'open'
      AND (expires_at IS NULL OR expires_at > ?)`, guildId, characterId, now);
}
export function writeOwnership(db, guildId, characterId, fromOwnerId, toOwnerId, marriedAt, marriageId) {
    return db.prepare(`UPDATE marriages SET owner_id = ?, married_at = ?
      WHERE guild_id = ? AND character_id = ? AND owner_id = ? AND id = COALESCE(?, id)`)
        .run(toOwnerId, marriedAt, guildId, characterId, fromOwnerId, marriageId ?? null).changes === 1;
}
