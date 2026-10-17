import { DatabaseSync } from 'node:sqlite';

function validDiscordId(value) {
  return typeof value === 'string' && /^\d+$/.test(value);
}

function validCharacterId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validateIds(guildId, characterId, ownerId) {
  if (!validDiscordId(guildId) || !validCharacterId(characterId) || !validDiscordId(ownerId)) {
    throw new Error('Invalid marriage identity');
  }
}

/** @typedef {{id: number, guildId: string, characterId: number, ownerId: string, marriedAt: string}} Marriage */
/** @typedef {Marriage & {rank: number, name_full: string, name_native: string | null,
 *   name_alternatives: string | null, image_url: string | null}} MarriageRow */

/**
 * @param {DatabaseSync} db
 * @param {string} guildId
 * @param {number} characterId
 * @returns {Marriage | null}
 */
export function getMarriage(db, guildId, characterId) {
  if (!validDiscordId(guildId) || !validCharacterId(characterId)) throw new Error('Invalid marriage identity');
  return /** @type {Marriage | undefined} */ (db.prepare(`SELECT id, guild_id AS guildId,
    character_id AS characterId, owner_id AS ownerId, married_at AS marriedAt
    FROM marriages WHERE guild_id = ? AND character_id = ?`).get(guildId, characterId)) ?? null;
}

/**
 * @param {DatabaseSync} db
 * @param {string} guildId
 * @param {number} characterId
 * @param {string} ownerId
 * @returns {{status: 'married' | 'already_yours' | 'already_owned' | 'unknown', marriage: Marriage | null}}
 */
export function marryCharacter(db, guildId, characterId, ownerId) {
  validateIds(guildId, characterId, ownerId);
  const result = db.prepare(`INSERT OR IGNORE INTO marriages
    (guild_id, character_id, owner_id, married_at)
    SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM characters WHERE id = ?)`)
    .run(guildId, characterId, ownerId, new Date().toISOString(), characterId);
  const marriage = getMarriage(db, guildId, characterId);
  if (result.changes) return { status: 'married', marriage };
  if (!marriage) return { status: 'unknown', marriage: null };
  return { status: marriage.ownerId === ownerId ? 'already_yours' : 'already_owned', marriage };
}

/**
 * @param {DatabaseSync} db
 * @param {string} guildId
 * @param {string} ownerId
 * @param {'time' | 'rank'} [sort]
 * @returns {MarriageRow[]}
 */
export function listMarriages(db, guildId, ownerId, sort = 'time') {
  if (!validDiscordId(guildId) || !validDiscordId(ownerId) || !['time', 'rank'].includes(sort)) {
    throw new Error('Invalid marriage list');
  }
  const order = sort === 'rank' ? 'character.rank ASC, marriage.id ASC'
    : 'marriage.married_at DESC, marriage.id DESC';
  return /** @type {MarriageRow[]} */ (db.prepare(`SELECT marriage.id, marriage.guild_id AS guildId,
    marriage.character_id AS characterId, marriage.owner_id AS ownerId,
    marriage.married_at AS marriedAt, character.rank,
    character.name_full, character.name_native, character.name_alternatives, character.image_url
    FROM marriages AS marriage JOIN characters AS character ON character.id = marriage.character_id
    WHERE marriage.guild_id = ? AND marriage.owner_id = ? ORDER BY ${order}`)
    .all(guildId, ownerId));
}

/**
 * End only the exact marriage selected earlier; a later remarriage has a different row ID.
 * @param {DatabaseSync} db
 * @param {string} guildId
 * @param {number} characterId
 * @param {string} ownerId
 * @param {number} marriageId
 */
export function divorceCharacter(db, guildId, characterId, ownerId, marriageId) {
  validateIds(guildId, characterId, ownerId);
  if (!Number.isSafeInteger(marriageId) || marriageId <= 0) throw new Error('Invalid marriage ID');
  return db.prepare(`DELETE FROM marriages WHERE guild_id = ? AND character_id = ?
    AND owner_id = ? AND id = ?`).run(guildId, characterId, ownerId, marriageId).changes === 1;
}
