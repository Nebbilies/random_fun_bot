import { transaction } from "../../lib/catalogDb.js";
import { nextClaimReset } from "../rolls/rollAllowanceService.js";
import { currentSeason } from "./seasonStore.js";

const id = (value) =>
  typeof value === "string" && /^[1-9]\d{0,19}$/.test(value);
const day = 86_400_000;
const defaults = {
  target_days: 30,
  revision: 0,
  channel_id: null,
  channel_checked_at: null,
  channel_error: null,
};
const conflict = (message) =>
  Object.assign(new Error(message), { code: "SEASON_STALE" });

export function getSeasonStatus(db, guildId, now = Date.now()) {
  const active = currentSeason(db, guildId);
  if (!active)
    throw new Error("Season controls require the final game catalog.");
  const settings =
    db
      .prepare("SELECT * FROM guild_season_settings WHERE guild_id=?")
      .get(guildId) ?? defaults;
  const rollover =
    db
      .prepare("SELECT * FROM season_rollovers WHERE guild_id=? AND season=?")
      .get(guildId, active.season) ?? null;
  const lastRollover = db
    .prepare(
      "SELECT season,completed_at FROM season_rollovers WHERE guild_id=? AND phase='applied' ORDER BY season DESC LIMIT 1",
    )
    .get(guildId);
  const deliverySeason = rollover?.season ?? lastRollover?.season;
  const deliveries =
    deliverySeason == null
      ? []
      : db
          .prepare(
            `SELECT kind,state,count(*) AS count,max(last_error) AS error
    FROM season_messages WHERE guild_id=? AND season=? AND revision=(
      SELECT revision FROM season_rollovers WHERE guild_id=? AND season=?)
    GROUP BY kind,state ORDER BY kind,state`,
          )
          .all(guildId, deliverySeason, guildId, deliverySeason);
  const canAbandonReminder =
    rollover?.phase === "posting" && rollover.cutoff_at <= now;
  return {
    guildId,
    current: active,
    settings,
    rollover,
    lastRollover: lastRollover ?? null,
    deliveries,
    canAbandonReminder,
    targetAt:
      active.startedAt == null
        ? null
        : active.startedAt + Number(settings.target_days) * day,
  };
}

export function saveSeasonSettings(
  db,
  { guildId, channelId, targetDays, revision = 0 },
) {
  if (
    !id(guildId) ||
    !id(channelId) ||
    !Number.isSafeInteger(targetDays) ||
    targetDays <= 0 ||
    targetDays > Math.floor(Number.MAX_SAFE_INTEGER / day)
  ) {
    throw new Error(
      "Enter a valid server, announcement channel, and target length in whole days.",
    );
  }
  return transaction(db, () => {
    const { settings, rollover } = getSeasonStatus(db, guildId);
    if (settings.revision !== revision)
      throw conflict("Season settings changed. Reload them and try again.");
    if (
      settings.channel_id !== channelId &&
      rollover &&
      ["queued", "posting", "announced"].includes(rollover.phase)
    ) {
      throw conflict(
        "Cancel the queued reminder or wait for rollover before changing its announcement channel.",
      );
    }
    db.prepare(
      `INSERT INTO guild_season_settings(guild_id,channel_id,target_days,revision)
      VALUES (?,?,?,1) ON CONFLICT(guild_id) DO UPDATE SET channel_id=excluded.channel_id,
        target_days=excluded.target_days,revision=guild_season_settings.revision+1,
        channel_checked_at=CASE WHEN guild_season_settings.channel_id=excluded.channel_id
          AND guild_season_settings.channel_error IS NULL THEN guild_season_settings.channel_checked_at END,
        channel_error=NULL`,
    ).run(guildId, channelId, targetDays);
    return getSeasonStatus(db, guildId);
  });
}

export function previewRollover(db, guildId, now = Date.now()) {
  if (!id(guildId)) throw new Error("Enter a valid server ID.");
  const { current, settings, rollover } = getSeasonStatus(db, guildId);
  if (current.season !== 0 && current.startedAt === null)
    throw new Error("This server has no season players yet.");
  if (
    !settings.channel_id ||
    settings.channel_checked_at == null ||
    settings.channel_error
  ) {
    throw new Error("Wait for the bot to verify the announcement channel.");
  }
  if (rollover && ["queued", "posting", "announced"].includes(rollover.phase))
    throw conflict("This server already has a scheduled rollover.");
  const reminderAt = nextClaimReset(now, db, guildId);
  return {
    season: current.season,
    channelId: settings.channel_id,
    settingsRevision: settings.revision,
    revision: rollover?.revision ?? 0,
    reminderAt,
    cutoffAt: nextClaimReset(reminderAt, db, guildId),
  };
}

export function queueRollover(
  db,
  { guildId, requester, preview, now = Date.now() },
) {
  return transaction(db, () => {
    const plan = previewRollover(db, guildId, now);
    if (!preview || Object.keys(plan).some((key) => plan[key] !== preview[key]))
      throw conflict(
        "The rollover preview changed. Review the new times and confirm again.",
      );
    db.prepare(
      `INSERT INTO season_rollovers(guild_id,season,revision,phase,channel_id,reminder_at,cutoff_at,requester)
      VALUES (?,?,?,'queued',?,?,?,?) ON CONFLICT(guild_id,season) DO UPDATE SET
        revision=excluded.revision,phase='queued',channel_id=excluded.channel_id,
        reminder_at=excluded.reminder_at,cutoff_at=excluded.cutoff_at,requester=excluded.requester,
        last_error=NULL`,
    ).run(
      guildId,
      plan.season,
      Number(plan.revision) + 1,
      plan.channelId,
      plan.reminderAt,
      plan.cutoffAt,
      requester,
    );
    return getSeasonStatus(db, guildId).rollover;
  });
}

export function cancelRollover(
  db,
  {
    guildId,
    revision,
    abandonUnconfirmed = false,
    requester = "",
    now = Date.now(),
  },
) {
  return transaction(db, () => {
    const { current, rollover, canAbandonReminder } = getSeasonStatus(
      db,
      guildId,
      now,
    );
    if (
      !rollover ||
      rollover.revision !== revision ||
      (abandonUnconfirmed ? !canAbandonReminder : rollover.phase !== "queued")
    ) {
      throw conflict(
        "Only a queued reminder or an overdue unconfirmed reminder can be canceled.",
      );
    }
    if (abandonUnconfirmed) {
      db.prepare(
        "UPDATE season_rollovers SET phase='canceled',revision=revision+1,last_error=? WHERE guild_id=? AND season=?",
      ).run(
        `Unconfirmed reminder abandoned by ${requester}. Current season resumed.`,
        guildId,
        current.season,
      );
    } else {
      db.prepare(
        "UPDATE season_rollovers SET phase='canceled' WHERE guild_id=? AND season=?",
      ).run(guildId, current.season);
    }
    return getSeasonStatus(db, guildId).rollover;
  });
}
