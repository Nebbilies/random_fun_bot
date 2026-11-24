import { performance } from 'node:perf_hooks';

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

/** Every invocation requests fresh membership. Only completed chunks prove absence. */
export async function resolveGuildMembers(guild, userIds) {
  const ids = [...new Set(userIds)];
  if (!ids.length) return new Map();
  const deadline = performance.now() + 5000;
  let timer;
  const failure = () => Object.assign(new Error('Could not load server members. Please try again.'), { code: 'LEADERBOARD_MEMBERS_UNAVAILABLE' });
  const work = async () => {
    const members = new Map();
    for (let start = 0; start < ids.length; start += 100) {
      const remaining = Math.floor(deadline - performance.now());
      if (remaining <= 0) throw failure();
      const batch = await guild.members.fetch({ user: ids.slice(start, start + 100), withPresences: false, time: remaining });
      if (performance.now() >= deadline) throw failure();
      for (const [id, member] of batch) members.set(id, member);
    }
    return members;
  };
  try {
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(failure()), 5000); });
    return await Promise.race([work(), timeout]);
  } catch (cause) {
    const error = failure();error.cause = cause;throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function resolveServerLeaderboard(guild, rows) {
  const members = await resolveGuildMembers(guild, rows.map(row => row.ownerId));
  return rows.filter(row => members.has(row.ownerId)).map(row => ({ ...row,
    username: members.get(row.ownerId).user.username,
    avatarUrl: members.get(row.ownerId).user.displayAvatarURL({ size: 128 }) }));
}
