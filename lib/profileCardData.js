import {
  getAffectionDetail,
  getAffectionOverview,
  hasAffection,
} from "./characterAffection.js";
import { characterFranchiseRelation } from "./characterFranchises.js";
import {
  resolveServerLeaderboard,
  totalMarriedLeaderboard,
} from "./serverLeaderboard.js";
import {
  currentSeason,
  seasonCutoffReached,
} from "../features/seasons/seasonStore.js";
import { hasSeasonSchema } from "./seasonSchema.js";

function projectCharacter(row) {
  return {
    name: row.name || "Unknown character",
    affection: row.total,
    portraitUrl: row.image,
  };
}

export function readProfileCollection(db, guildId, userId) {
  if (!hasAffection(db))
    throw new Error("Profile card requires the affection catalog");
  const overview = getAffectionOverview(db, { guildId, userId, pageSize: 5 });
  const soulmateId = overview.benefits.soulmate?.characterId;
  const soulmate =
    soulmateId &&
    (overview.rows.find((row) => row.characterId === soulmateId) ??
      getAffectionDetail(db, { guildId, userId, characterId: soulmateId }));
  const franchises = db
    .prepare(
      `SELECT f.id, f.display_name AS name, COUNT(DISTINCT m.character_id) AS count
    FROM marriages m JOIN ${characterFranchiseRelation(db)} cf ON cf.character_id = m.character_id
    JOIN franchises f ON f.id = cf.franchise_id
    WHERE m.guild_id = ? AND m.owner_id = ? GROUP BY f.id, f.display_name`,
    )
    .all(guildId, userId);
  franchises.sort(
    (a, b) =>
      b.count - a.count || a.name.localeCompare(b.name, "en") || a.id - b.id,
  );
  return {
    soulmate: soulmate ? projectCharacter(soulmate) : null,
    topCharacters: overview.rows.map(projectCharacter),
    topFranchises: franchises
      .slice(0, 5)
      .map(({ name, count }) => ({ name, count })),
  };
}

function readCollection(db, guildId, userId) {
  db.exec("BEGIN");
  try {
    const leaderboard = totalMarriedLeaderboard(db, guildId);
    const collection = readProfileCollection(db, guildId, userId);
    db.exec("COMMIT");
    return { leaderboard, ...collection };
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

export function profileSeasons(db, guildId, userId) {
  if (!hasSeasonSchema(db)) return null;
  const archived = db
    .prepare(
      "SELECT season FROM season_profiles WHERE guild_id=? AND user_id=? ORDER BY season DESC",
    )
    .all(guildId, userId)
    .map((row) => Number(row.season));
  return { current: currentSeason(db, guildId)?.season ?? 1, archived };
}

export async function loadProfileCardData(db, message, season = null) {
  const { guild, guildId, author, member } = message;
  const avatarOptions = { extension: "png", forceStatic: true, size: 256 };
  const identity = {
    displayName: member?.displayName ?? author.globalName ?? author.username,
    avatarUrl:
      member?.displayAvatarURL(avatarOptions) ??
      author.displayAvatarURL?.(avatarOptions),
  };
  if (season != null) {
    const archived = db
      .prepare(
        "SELECT summary_json FROM season_profiles WHERE guild_id=? AND user_id=? AND season=?",
      )
      .get(guildId, author.id, season);
    if (!archived) throw new Error("This season profile is unavailable.");
    return { ...JSON.parse(archived.summary_json), ...identity };
  }
  if (seasonCutoffReached(db, guildId)) {
    throw Object.assign(
      new Error("The next season is starting. Please try again shortly."),
      { code: "SEASON_CUTOFF" },
    );
  }
  const { leaderboard, ...collection } = readCollection(db, guildId, author.id);
  const place = leaderboard.findIndex((row) => row.ownerId === author.id);
  const eligible =
    place < 0
      ? []
      : await resolveServerLeaderboard(guild, leaderboard.slice(0, place + 1));
  const rank = eligible.findIndex((row) => row.ownerId === author.id);
  return {
    ...collection,
    ...identity,
    characterCount: place < 0 ? 0 : leaderboard[place].score,
    serverRank: rank < 0 ? null : rank + 1,
  };
}
