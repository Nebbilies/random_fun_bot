import { withOwnershipOperationClock } from './characterOwnershipHistory.js';
import { hydrateCharacterFranchises } from './characterSeries.js';
import { DatabaseSync } from 'node:sqlite';
import { characterLikesProjection } from './characterLikesProjection.js';
import { characterFranchiseRelation } from './characterFranchises.js';
import { isValidCharacterId } from './gameCharacterLookup.js';
import { isCharacterReserved, invalidateCharacterCrown } from './characterAvailability.js';
import { assertSeasonWritable } from '../features/seasons/seasonStore.js';

function validDiscordId(value) {
  return typeof value === 'string' && /^\d+$/.test(value);
}

function validateIds(db, guildId, characterId, ownerId) {
  if (!validDiscordId(guildId) || !isValidCharacterId(characterId, db) || !validDiscordId(ownerId)) {
    throw new Error('Invalid marriage identity');
  }
}

/** @typedef {{id: number, guildId: string, characterId: string | number, ownerId: string, marriedAt: string}} Marriage */
/** @typedef {Marriage & {rank: number, favourites: number, likes_source: string, name_full: string, name_native: string | null,
 *   name_alternatives: string | null, image_url: string | null, site_url: string | null,
 *   anime_titles: string | null}} MarriageRow */

/**
 * @param {DatabaseSync} db
 * @param {string} guildId
 * @param {string | number} characterId
 * @returns {Marriage | null}
 */
export function getMarriage(db, guildId, characterId) {
  if (!validDiscordId(guildId) || !isValidCharacterId(characterId, db)) throw new Error('Invalid marriage identity');
  return /** @type {Marriage | undefined} */ (db.prepare(`SELECT id, guild_id AS guildId,
    character_id AS characterId, owner_id AS ownerId, married_at AS marriedAt
    FROM marriages WHERE guild_id = ? AND character_id = ?`).get(guildId, characterId)) ?? null;
}

/**
 * @param {DatabaseSync} db
 * @param {string} guildId
 * @param {string | number} characterId
 * @param {string} ownerId
 * @param {number} [now]
 * @returns {{status: 'married' | 'already_yours' | 'already_owned' | 'unknown', marriage: Marriage | null}}
 */
export function marryCharacter(db, guildId, characterId, ownerId, now = Date.now()) {
  validateIds(db, guildId, characterId, ownerId);
  if (isCharacterReserved(db, guildId, characterId)) {
    const marriage = getMarriage(db, guildId, characterId);
    return { status: marriage?.ownerId === ownerId ? 'already_yours' : marriage ? 'already_owned' : 'unknown', marriage };
  }
  const result = db.prepare(`INSERT OR IGNORE INTO marriages
    (guild_id, character_id, owner_id, married_at)
    SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM characters WHERE id = ?)` )
    .run(guildId, characterId, ownerId, new Date(now).toISOString(), characterId);
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
  return hydrateCharacterFranchises(db, /** @type {MarriageRow[]} */ (db.prepare(`SELECT marriage.id, marriage.guild_id AS guildId,
    marriage.character_id AS characterId, marriage.owner_id AS ownerId,
    marriage.married_at AS marriedAt, character.rank, character.favourites,
    ${characterLikesProjection(db, 'character')},
    character.name_full, character.name_native, character.name_alternatives, character.image_url,
    character.site_url, character.anime_titles
    FROM marriages AS marriage JOIN characters AS character ON character.id = marriage.character_id
    WHERE marriage.guild_id = ? AND marriage.owner_id = ? ORDER BY ${order}`)
    .all(guildId, ownerId)), 'characterId');
}

/**
 * @typedef {{ id: number | null, name: string, characters: MarriageRow[] }} FranchiseMarriageGroup
 */

/**
 * @param {DatabaseSync} db
 * @param {string} guildId
 * @param {string} ownerId
 * @param {'time' | 'rank'} [sort]
 * @returns {FranchiseMarriageGroup[]}
 */
export function listMarriagesByFranchise(db, guildId, ownerId, sort = 'time') {
  const marriages = listMarriages(db, guildId, ownerId, sort);
  if (!marriages.length) return [];

  const characterIds = [...new Set(marriages.map((m) => m.characterId))];
  const placeholders = characterIds.map(() => '?').join(',');
  const rows = /** @type {{ characterId: string | number, franchiseId: number, franchiseName: string }[]} */ (
    db.prepare(`SELECT DISTINCT membership.character_id AS characterId, f.id AS franchiseId, f.display_name AS franchiseName
      FROM ${characterFranchiseRelation(db)} AS membership
      JOIN franchises AS f ON f.id = membership.franchise_id
      WHERE membership.character_id IN (${placeholders})
      ORDER BY f.display_name COLLATE NOCASE ASC`).all(...characterIds)
  );

  /** @type {Map<string | number, { id: number, name: string }[]>} */
  const charFranchiseMap = new Map();
  for (const row of rows) {
    let list = charFranchiseMap.get(row.characterId);
    if (!list) {
      list = [];
      charFranchiseMap.set(row.characterId, list);
    }
    list.push({ id: row.franchiseId, name: row.franchiseName });
  }

  /** @type {Map<number, FranchiseMarriageGroup>} */
  const franchiseGroups = new Map();
  /** @type {MarriageRow[]} */
  const unfranchised = [];

  for (const marriage of marriages) {
    const franchises = charFranchiseMap.get(marriage.characterId);
    if (!franchises || franchises.length === 0) {
      unfranchised.push(marriage);
    } else {
      for (const franchise of franchises) {
        let group = franchiseGroups.get(franchise.id);
        if (!group) {
          group = { id: franchise.id, name: franchise.name, characters: [] };
          franchiseGroups.set(franchise.id, group);
        }
        group.characters.push(marriage);
      }
    }
  }

  const sortedGroups = [...franchiseGroups.values()].sort((a, b) =>
    a.name.localeCompare(b.name, 'en', { sensitivity: 'base' })
  );

  if (unfranchised.length > 0) {
    sortedGroups.push({ id: null, name: 'Other', characters: unfranchised });
  }

  return sortedGroups;
}

/**
 * End only the exact marriage selected earlier; a later remarriage has a different row ID.
 * @param {DatabaseSync} db
 * @param {string} guildId
 * @param {string | number} characterId
 * @param {string} ownerId
 * @param {number} marriageId
 * @param {number} [now]
 */
export function divorceCharacter(db, guildId, characterId, ownerId, marriageId, now = Date.now()) {
  validateIds(db, guildId, characterId, ownerId);
  if (!Number.isSafeInteger(marriageId) || marriageId <= 0) throw new Error('Invalid marriage ID');
  if (isCharacterReserved(db, guildId, characterId)) return false;
  return withOwnershipOperationClock(db, now, () => {
    const removed = db.prepare(`DELETE FROM marriages WHERE guild_id = ? AND character_id = ?
      AND owner_id = ? AND id = ?`).run(guildId, characterId, ownerId, marriageId).changes === 1;
    if (removed) invalidateCharacterCrown(db, guildId, characterId);
    return removed;
  });
}

class BatchDivorceRejection extends Error {
  /** @param {'stale' | 'blocked'} status @param {string | number} characterId */
  constructor(status, characterId) {
    super('A selected marriage could not be ended');
    this.status = status;
    this.characterId = characterId;
  }
}

/**
 * Ends the selected marriages together, including their ownership loss records.
 * @param {DatabaseSync} db
 * @param {{guildId: string, ownerId: string, characters: {characterId: string | number, marriageId: number}[], now?: number, season?: number}} request
 */
export function divorceCharacters(db, { guildId, ownerId, characters, season, now = Date.now() }) {
  if (!characters.length || new Set(characters.map(row => row.characterId)).size !== characters.length) {
    throw new Error('A divorce batch requires distinct characters');
  }
  let writing;
  try {
    return withOwnershipOperationClock(db, now, () => {
      assertSeasonWritable(db,guildId,{season,now});
      for (const { characterId, marriageId } of characters) {
        writing = characterId;
        if (divorceCharacter(db, guildId, characterId, ownerId, marriageId, now)) continue;
        const current = getMarriage(db, guildId, characterId);
        throw new BatchDivorceRejection(current?.id === marriageId && current.ownerId === ownerId ? 'blocked' : 'stale', characterId);
      }
      writing = undefined;
      return { status: /** @type {const} */ ('divorced') };
    });
  } catch (error) {
    if (error instanceof BatchDivorceRejection) return { status: error.status, characterId: error.characterId };
    if (writing === undefined) throw error;
    throw Object.assign(new Error(error instanceof Error ? error.message : String(error), { cause: error }), { characterId: writing });
  }
}
