import { getAffectionDetail, getAffectionOverview, hasAffection } from './characterAffection.js';
import { characterFranchiseRelation } from './characterFranchises.js';
import { resolveServerLeaderboard, totalMarriedLeaderboard } from './serverLeaderboard.js';

function projectCharacter(row) {
  return { name: row.name || 'Unknown character', affection: row.total, portraitUrl: row.image };
}

function readCollection(db, guildId, userId) {
  db.exec('BEGIN');
  try {
    if (!hasAffection(db)) throw new Error('Profile card requires the affection catalog');
    const leaderboard = totalMarriedLeaderboard(db, guildId);
    const overview = getAffectionOverview(db, { guildId, userId, pageSize: 5 });
    const soulmateId = overview.benefits.soulmate?.characterId;
    const soulmate = soulmateId && (overview.rows.find(row => row.characterId === soulmateId)
      ?? getAffectionDetail(db, { guildId, userId, characterId: soulmateId }));
    const franchises = db.prepare(`SELECT f.id, f.display_name AS name, COUNT(DISTINCT m.character_id) AS count
      FROM marriages m JOIN ${characterFranchiseRelation(db)} cf ON cf.character_id = m.character_id
      JOIN franchises f ON f.id = cf.franchise_id
      WHERE m.guild_id = ? AND m.owner_id = ? GROUP BY f.id, f.display_name`).all(guildId, userId);
    franchises.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'en') || a.id - b.id);
    db.exec('COMMIT');
    return {
      leaderboard,
      soulmate: soulmate ? projectCharacter(soulmate) : null,
      topCharacters: overview.rows.map(projectCharacter),
      topFranchises: franchises.slice(0, 5).map(({ name, count }) => ({ name, count })),
    };
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

export async function loadProfileCardData(db, message) {
  const { guild, guildId, author, member } = message;
  const { leaderboard, ...collection } = readCollection(db, guildId, author.id);
  const place = leaderboard.findIndex(row => row.ownerId === author.id);
  const eligible = place < 0 ? [] : await resolveServerLeaderboard(guild, leaderboard.slice(0, place + 1));
  const rank = eligible.findIndex(row => row.ownerId === author.id);
  const avatarOptions = { extension: 'png', forceStatic: true, size: 256 };
  return {
    ...collection,
    displayName: member?.displayName ?? author.globalName ?? author.username,
    avatarUrl: member?.displayAvatarURL(avatarOptions) ?? author.displayAvatarURL?.(avatarOptions),
    characterCount: place < 0 ? 0 : leaderboard[place].score,
    serverRank: rank < 0 ? null : rank + 1,
  };
}
