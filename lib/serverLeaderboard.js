/** Rankable server-local owners, ordered by the sum of their ten best current ranks. */
export function serverLeaderboard(db, guildId) {
  const characters = db.prepare(`WITH ranked AS (
    SELECT marriage.owner_id AS ownerId, character.rank,
      ROW_NUMBER() OVER (PARTITION BY marriage.owner_id ORDER BY character.rank ASC) AS position
    FROM marriages AS marriage JOIN characters AS character ON character.id = marriage.character_id
    WHERE marriage.guild_id = ? AND character.rank > 0
  ) SELECT ownerId, rank FROM ranked WHERE position <= 10 ORDER BY ownerId, rank`).all(guildId);
  const owners = new Map();
  for (const { ownerId, rank } of characters) {
    if (!owners.has(ownerId)) owners.set(ownerId, { ownerId, ranks: [], score: 0 });
    const owner = owners.get(ownerId);
    owner.ranks.push(rank);
    owner.score += rank;
  }
  return [...owners.values()].filter((owner) => owner.ranks.length === 10).sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    for (let index = 0; index < 10; index += 1) {
      if (a.ranks[index] !== b.ranks[index]) return a.ranks[index] - b.ranks[index];
    }
    return a.ownerId < b.ownerId ? -1 : a.ownerId > b.ownerId ? 1 : 0;
  });
}

/** Current server-local ownership totals, including characters outside the active catalog. */
export function totalMarriedLeaderboard(db, guildId) {
  return db.prepare(`SELECT owner_id AS ownerId, COUNT(*) AS score
    FROM marriages WHERE guild_id = ? GROUP BY owner_id
    ORDER BY score DESC, owner_id ASC`).all(guildId);
}

/** Resolve actual membership; only Discord's explicit Unknown Member means absent. */
export async function resolveServerLeaderboard(guild, rows) {
  const resolved = [];
  for (const row of rows) {
    let member;
    try {
      member = await guild.members.fetch({ user: row.ownerId, force: true });
    } catch (error) {
      if (Number(error.code) === 10007) continue;
      throw error;
    }
    resolved.push({ ...row, username: member.user.username,
      avatarUrl: member.user.displayAvatarURL({ size: 128 }) });
  }
  return resolved;
}
