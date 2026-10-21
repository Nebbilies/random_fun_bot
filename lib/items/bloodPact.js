import { divorceCharacter, marryCharacter } from '../characterMarriage.js';

function parseNames(args) {
  const parts = args.length === 1 ? args[0].split(',') : args;
  return parts.map((name) => String(name).trim().replace(/^["']|["']$/g, '').trim()).filter(Boolean);
}

function ownedMarriages(db, guildId, userId) {
  return db.prepare(`
    SELECT m.id AS marriageId, m.character_id AS characterId, c.name_full, c.rank
    FROM marriages AS m
    JOIN characters AS c ON c.id = m.character_id
    WHERE m.guild_id = ? AND m.owner_id = ?
    ORDER BY m.character_id
  `).all(guildId, userId);
}

function franchisesOf(db, characterId) {
  const ids = db.prepare(`SELECT DISTINCT fa.franchise_id AS franchiseId
    FROM character_anime AS ca
    JOIN franchise_anime AS fa ON fa.anime_id = ca.anime_id
    WHERE ca.character_id = ?`).all(characterId).map((row) => row.franchiseId);
  return new Set(ids);
}

export const bloodPact = {
  id: 'blood_pact',
  name: 'Blood Pact',
  tier: 'epic',
  description: 'Sacrifices 3 characters you own from a franchise to summon 1 unowned character from that franchise with higher rank.',
  type: 'targeted_sacrifice',
  maxCharges: 1,

  execute({ db, guildId, userId, args }) {
    const names = parseNames(args);
    if (names.length !== 3) {
      return { success: false, message: 'Please specify 3 characters from the same franchise to sacrifice! Example: `!use bloodpact "Char1", "Char2", "Char3"`' };
    }

    const owned = ownedMarriages(db, guildId, userId);
    const sacrifices = [];
    for (const name of names) {
      const needle = name.toLowerCase();
      const match = owned.find((row) => row.name_full.toLowerCase().includes(needle));
      if (!match) {
        return { success: false, message: `You do not own a character matching "${name}".` };
      }
      if (sacrifices.some((row) => row.characterId === match.characterId)) {
        return { success: false, message: `**${match.name_full}** was listed twice — each sacrifice must be a different character.` };
      }
      sacrifices.push(match);
    }

    const shared = [...franchisesOf(db, sacrifices[0].characterId)]
      .filter((franchiseId) => sacrifices.every((row) => franchisesOf(db, row.characterId).has(franchiseId)));
    if (!shared.length) {
      return { success: false, message: 'All 3 sacrifices must come from the same franchise.' };
    }

    const placeholders = sacrifices.map(() => '?').join(', ');
    let candidate = null;
    for (const franchiseId of shared) {
      candidate = db.prepare(`SELECT c.id, c.name_full, c.rank
        FROM characters AS c
        JOIN character_anime AS ca ON ca.character_id = c.id
        JOIN franchise_anime AS fa ON fa.anime_id = ca.anime_id
        WHERE fa.franchise_id = ? AND c.id NOT IN (${placeholders})
          AND NOT EXISTS (SELECT 1 FROM marriages AS m WHERE m.guild_id = ? AND m.character_id = c.id)
        ORDER BY c.rank ASC, c.id ASC LIMIT 1`)
        .get(franchiseId, ...sacrifices.map((row) => row.characterId), guildId);
      if (candidate) break;
    }
    if (!candidate) {
      return { success: false, message: 'No unowned character from that franchise is left to summon.' };
    }

    for (const row of sacrifices) {
      if (!divorceCharacter(db, guildId, row.characterId, userId, row.marriageId)) {
        throw new Error('Blood Pact sacrifice changed during the ritual');
      }
    }
    const married = marryCharacter(db, guildId, candidate.id, userId);
    const summon = { ...candidate, ...(married.marriage ? {} : {}) };
    return {
      success: true,
      character: summon,
      message: `🩸 The Blood Pact consumes **${sacrifices.map((row) => row.name_full).join('**, **')}** and summons **${summon.name_full}** (rank #${summon.rank})!`,
    };
  },
};
