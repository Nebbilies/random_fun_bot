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
/** @typedef {Marriage & {rank: number, favourites: number, name_full: string, name_native: string | null,
 *   name_alternatives: string | null, image_url: string | null, site_url: string | null,
 *   anime_titles: string | null}} MarriageRow */

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
    SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM characters WHERE id = ?)` )
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
    marriage.married_at AS marriedAt, character.rank, character.favourites,
    character.name_full, character.name_native, character.name_alternatives, character.image_url,
    character.site_url, character.anime_titles
    FROM marriages AS marriage JOIN characters AS character ON character.id = marriage.character_id
    WHERE marriage.guild_id = ? AND marriage.owner_id = ? ORDER BY ${order}`)
    .all(guildId, ownerId));
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
  const rows = /** @type {{ characterId: number, franchiseId: number, franchiseName: string }[]} */ (
    db.prepare(`SELECT DISTINCT ca.character_id AS characterId, f.id AS franchiseId, f.display_name AS franchiseName
      FROM character_anime AS ca
      JOIN franchise_anime AS fa ON fa.anime_id = ca.anime_id
      JOIN franchises AS f ON f.id = fa.franchise_id
      WHERE ca.character_id IN (${placeholders})
      ORDER BY f.display_name COLLATE NOCASE ASC`).all(...characterIds)
  );

  /** @type {Map<number, { id: number, name: string }[]>} */
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
