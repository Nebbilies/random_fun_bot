import { getGameConfig } from "../../lib/gameConfig.js";
import { hasSeasonSchema } from "../../lib/seasonSchema.js";
import { hasWeeklyEventSchema } from "../../lib/weeklyEventSchema.js";

const dayMs = 86_400_000;
export const weekMs = 7 * dayMs;
export const weeklyThemes = {
  steals: [
    "Steals and divorces",
    "Steal or forcibly divorce opposing characters.",
  ],
  affection: ["Affection", "Gain affection."],
  wishes: ["Wish matches", "Roll characters on server wishlists."],
  reclaims: ["Reclaims", "Successfully reclaim escaping characters."],
  mystery: ["Mystery Champion", "Win mystery events."],
  franchise: [
    "Franchise Collector",
    "Gain distinct characters from a single franchise.",
  ],
};

function withinWrite(db, work) {
  if (db.isTransaction) return work();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function weekStart(now, { day, minute, offset }) {
  const epoch = (day - 4) * dayMs + (minute - offset) * 60_000;
  return epoch + Math.floor((now - epoch) / weekMs) * weekMs;
}

function enqueue(db, contestId, kind, channelId) {
  db.prepare(
    "INSERT OR IGNORE INTO weekly_notices(contest_id,kind,channel_id) VALUES(?,?,?)",
  ).run(contestId, kind, channelId);
}

export function setWeeklyControls(
  db,
  { guildId, enabled, channelId, nextTheme, now = Date.now() },
) {
  if (
    !/^\d+$/.test(guildId) ||
    typeof enabled !== "boolean" ||
    !/^\d+$/.test(channelId) ||
    (nextTheme != null && !Object.hasOwn(weeklyThemes, nextTheme))
  )
    throw new Error("Invalid Weekly Event settings");
  return withinWrite(db, () => {
    advanceWeeklyContest(db, guildId, now);
    db.prepare(
      `INSERT INTO weekly_controls VALUES(?,?,?,?,?) ON CONFLICT(guild_id) DO UPDATE SET
      enabled=excluded.enabled, channel_id=excluded.channel_id, next_theme=excluded.next_theme,
      enabled_at=CASE WHEN weekly_controls.enabled=0 AND excluded.enabled=1 THEN excluded.enabled_at ELSE weekly_controls.enabled_at END`,
    ).run(guildId, +enabled, channelId, now, nextTheme ?? null);
    db.prepare(
      `UPDATE weekly_notices SET channel_id=?,last_error=NULL WHERE message_id IS NULL AND channel_id<>?
      AND contest_id IN (SELECT id FROM weekly_contests WHERE guild_id=?)`,
    ).run(channelId, channelId, guildId);
  });
}

export function advanceWeeklyContest(
  db,
  guildId,
  now = Date.now(),
  random = Math.random,
) {
  if (!hasWeeklyEventSchema(db)) return null;
  if (
    !db.prepare("SELECT 1 FROM weekly_controls WHERE guild_id=?").get(guildId)
  )
    return null;
  return withinWrite(db, () => {
    const controls = db
      .prepare("SELECT * FROM weekly_controls WHERE guild_id=?")
      .get(guildId);
    const latest = db
      .prepare(
        "SELECT * FROM weekly_contests WHERE guild_id=? ORDER BY starts_at DESC LIMIT 1",
      )
      .get(guildId);
    const seasonal = hasSeasonSchema(db);
    const season = seasonal
      ? db
          .prepare(
            "SELECT season,started_at FROM guild_seasons WHERE guild_id=?",
          )
          .get(guildId)
      : null;
    if (
      season &&
      db
        .prepare(
          `SELECT 1 FROM season_rollovers WHERE guild_id=? AND season=?
      AND phase IN ('announced','posting') AND cutoff_at<=?`,
        )
        .get(guildId, season.season, now)
    )
      return null;
    if (latest?.state === "open" && latest.ends_at <= now) {
      db.prepare("UPDATE weekly_contests SET state='pending' WHERE id=?").run(
        latest.id,
      );
    }
    if (latest?.state === "open" && latest.ends_at > now) return latest;
    if (!controls.enabled) return null;
    const config = getGameConfig(db, guildId);
    const rules = config.weeklyEvents;
    const schedule = {
      day: rules.day,
      minute: rules.minute,
      offset: config.schedules.timezoneOffsetMinutes,
    };
    const savedSchedule = JSON.stringify(schedule);
    const start = weekStart(now, schedule);
    if (start <= controls.enabled_at || (latest && start <= latest.starts_at))
      return null;
    if (
      season?.started_at >= start &&
      db
        .prepare(
          `SELECT 1 FROM season_rollovers
      WHERE guild_id=? AND season=? AND phase='applied'`,
        )
        .get(guildId, season.season - 1)
    )
      return null;
    const prizeWeek =
      latest && (latest.state !== "settled" || latest.winner_id) ? weekMs : 0;
    if (
      latest &&
      latest.state !== "cancelled" &&
      start <
        latest.ends_at + (latest.schedule === savedSchedule ? 0 : prizeWeek)
    )
      return null;
    const weighted = Object.entries(rules.themeWeights).filter(
      ([, weight]) => weight > 0,
    );
    const pool =
      weighted.length > 1
        ? weighted.filter(([theme]) => theme !== latest?.theme)
        : weighted;
    let remaining =
      random() * pool.reduce((sum, [, weight]) => sum + weight, 0);
    const selected =
      pool.find(([, weight]) => (remaining -= weight) < 0) ?? pool.at(-1);
    const theme = controls.next_theme ?? selected?.[0];
    if (!theme)
      throw new Error("Weekly Events require a positive theme weight");
    const contest = db
      .prepare(
        `INSERT INTO weekly_contests(guild_id,season,theme,starts_at,ends_at,rules,schedule)
      VALUES(?,?,?,?,?,?,?) RETURNING *`,
      )
      .get(
        guildId,
        season?.season ?? (seasonal ? 1 : 0),
        theme,
        start,
        start + weekMs,
        JSON.stringify(rules),
        savedSchedule,
      );
    db.prepare(
      "UPDATE weekly_controls SET next_theme=NULL WHERE guild_id=?",
    ).run(guildId);
    enqueue(db, contest.id, "start", controls.channel_id);
    return contest;
  });
}

export function weeklyPrize(db, guildId, userId, theme, now) {
  if (!hasWeeklyEventSchema(db)) return null;
  const winning = db
    .prepare(
      `SELECT id,rules FROM weekly_contests WHERE guild_id=? AND winner_id=? AND theme=?
    AND state='settled' AND prize_revoked=0 AND ends_at<=? AND ends_at>? ORDER BY ends_at DESC LIMIT 1`,
    )
    .get(guildId, userId, theme, now, now - weekMs);
  return winning
    ? { ...JSON.parse(winning.rules), contestId: winning.id }
    : null;
}

export function tryWeeklyClaimReset(db, guildId, userId, period, now, random) {
  const prize = weeklyPrize(db, guildId, userId, "franchise", now);
  if (!prize?.claimAttempts) return false;
  const used = db
    .prepare(
      `INSERT INTO weekly_claim_checks VALUES(?,?,1)
    ON CONFLICT(contest_id,period) DO UPDATE SET attempts=attempts+1 WHERE attempts<?`,
    )
    .run(prize.contestId, period, prize.claimAttempts);
  return Boolean(used.changes) && random() < prize.claimChance;
}

export function weeklyExtraCharges(db, guildId, userId, itemId, now) {
  const prize = weeklyPrize(db, guildId, userId, "steals", now);
  return prize?.chargeItems.includes(itemId) ? prize.extraCharges : 0;
}

export function weeklyRewardExtraCharges(db, reward, itemId, now) {
  if (!hasWeeklyEventSchema(db)) return 0;
  const stored = db
    .prepare("SELECT extra FROM weekly_reward_charges WHERE reward_id=?")
    .get(reward.vaultId);
  if (stored) return stored.extra;
  const extra = weeklyExtraCharges(
    db,
    reward.guildId,
    reward.userId,
    itemId,
    reward.state === "overflow" ? (reward.resolvedAt ?? now) : now,
  );
  db.prepare("INSERT INTO weekly_reward_charges VALUES(?,?)").run(
    reward.vaultId,
    extra,
  );
  return extra;
}

/** @param {any} db @param {{guildId: string,userId: string,theme: string,key: string,now: number,points?: number,characterId?: string|number}} outcome */
export function scoreWeekly(
  db,
  { guildId, userId, theme, key, now, points = 1, characterId },
) {
  if (points <= 0 || !hasWeeklyEventSchema(db)) return;
  withinWrite(db, () => {
    const contest = advanceWeeklyContest(db, guildId, now);
    if (contest?.theme !== theme || now < contest.starts_at) return;
    const outcome = db
      .prepare(
        "INSERT OR IGNORE INTO weekly_outcomes(contest_id,outcome_key) VALUES(?,?)",
      )
      .run(contest.id, key);
    if (!outcome.changes) return;
    if (theme === "franchise") {
      db.prepare(
        `INSERT OR IGNORE INTO weekly_franchise_gains
        SELECT ?,?,CAST(franchise_id AS TEXT),CAST(character_id AS TEXT) FROM effective_character_franchises WHERE character_id=?`,
      ).run(contest.id, userId, characterId);
      points =
        db
          .prepare(
            `SELECT COUNT(*) count FROM weekly_franchise_gains WHERE contest_id=? AND user_id=?
        GROUP BY franchise_id ORDER BY count DESC LIMIT 1`,
          )
          .get(contest.id, userId)?.count ?? 0;
      const old = db
        .prepare(
          "SELECT points FROM weekly_scores WHERE contest_id=? AND user_id=?",
        )
        .get(contest.id, userId);
      points -= old?.points ?? 0;
      if (!points) return;
    }
    db.prepare(
      `INSERT INTO weekly_scores VALUES(?,?,?,?,?) ON CONFLICT(contest_id,user_id) DO UPDATE SET
      points=points+excluded.points,reached_at=excluded.reached_at,reached_order=excluded.reached_order`,
    ).run(contest.id, userId, points, now, outcome.lastInsertRowid);
  });
}

export function scoreWeeklyGain(db, guildId, userId, characterId, key, now) {
  scoreWeekly(db, {
    guildId,
    userId,
    theme: "franchise",
    characterId,
    key: `gain:${userId}:${characterId}:${key}`,
    now,
  });
}

export function scoreWeeklyLoss(db, guildId, userId, key, now, points = 1) {
  scoreWeekly(db, {
    guildId,
    userId,
    theme: "steals",
    key: `loss:${key}`,
    now,
    points,
  });
}

export function weeklyStandings(db, contestId) {
  return db
    .prepare(
      `SELECT user_id,points FROM weekly_scores WHERE contest_id=?
    ORDER BY points DESC,reached_at,reached_order`,
    )
    .all(contestId);
}

export function settleWeeklyContest(db, contestId, members) {
  return withinWrite(db, () => {
    const contest = db
      .prepare("SELECT * FROM weekly_contests WHERE id=? AND state='pending'")
      .get(contestId);
    if (!contest) return;
    const winner = weeklyStandings(db, contestId).find((row) =>
      members.has(row.user_id),
    );
    db.prepare(
      "UPDATE weekly_contests SET state='settled',winner_id=? WHERE id=?",
    ).run(winner?.user_id ?? null, contestId);
    const { channel_id: channelId } = db
      .prepare("SELECT * FROM weekly_controls WHERE guild_id=?")
      .get(contest.guild_id);
    enqueue(db, contestId, "result", channelId);
    db.prepare("DELETE FROM weekly_outcomes WHERE contest_id=?").run(contestId);
    db.prepare("DELETE FROM weekly_franchise_gains WHERE contest_id=?").run(
      contestId,
    );
  });
}

export function cancelWeeklyForSeason(db, guildId, cutoff) {
  if (!hasWeeklyEventSchema(db)) return;
  db.prepare(
    `UPDATE weekly_contests SET state=CASE WHEN state IN ('open','pending') THEN 'cancelled' ELSE state END,
    prize_revoked=1 WHERE guild_id=? AND prize_revoked=0 AND (state IN ('open','pending') OR ends_at>?)`,
  ).run(guildId, cutoff - weekMs);
  db.prepare(
    `DELETE FROM weekly_notices WHERE message_id IS NULL AND kind='start' AND contest_id IN
    (SELECT id FROM weekly_contests WHERE guild_id=? AND state='cancelled')`,
  ).run(guildId);
}

export function weeklyView(
  db,
  guildId,
  userId,
  now,
  { reconcile = true } = {},
) {
  if (!hasWeeklyEventSchema(db)) return { contest: null };
  const contest = reconcile
    ? advanceWeeklyContest(db, guildId, now)
    : (db
        .prepare(
          `SELECT * FROM weekly_contests
    WHERE guild_id=? AND state='open' AND starts_at<=? AND ends_at>? LIMIT 1`,
        )
        .get(guildId, now, now) ?? null);
  const controls = db
    .prepare("SELECT * FROM weekly_controls WHERE guild_id=?")
    .get(guildId);
  const errors = db
    .prepare(
      `SELECT kind,last_error FROM weekly_notices JOIN weekly_contests ON id=contest_id
    WHERE guild_id=? AND last_error IS NOT NULL`,
    )
    .all(guildId);
  if (!contest) return { contest, controls, errors };
  const standings = weeklyStandings(db, contest.id);
  const index = standings.findIndex((row) => row.user_id === userId);
  return {
    contest,
    controls,
    errors,
    leaders: standings.slice(
      0,
      getGameConfig(db, guildId).weeklyEvents.leaderboardLength,
    ),
    rank: index < 0 ? null : index + 1,
    score: index < 0 ? 0 : standings[index].points,
  };
}
