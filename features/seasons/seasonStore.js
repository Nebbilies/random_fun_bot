import { createHash } from 'node:crypto';
import { hasSeasonSchema } from '../../lib/seasonSchema.js';

/** @returns {{season:number,startedAt:number | null} | null} */
export function currentSeason(db, guildId) {
  if (!hasSeasonSchema(db)) return null;
  const row = db.prepare('SELECT season, started_at AS startedAt FROM guild_seasons WHERE guild_id=?').get(guildId);
  return row ? {season:Number(row.season),startedAt:row.startedAt == null ? null : Number(row.startedAt)}
    : {season:1,startedAt:null};
}

export function seasonCutoffReached(db, guildId, now = Date.now()) {
  return hasSeasonSchema(db) && Boolean(db.prepare(`SELECT 1 FROM season_rollovers r
    JOIN guild_seasons s ON s.guild_id=r.guild_id AND s.season=r.season
    WHERE r.guild_id=? AND r.phase IN ('announced','posting') AND r.cutoff_at<=?`).get(guildId, now));
}

/** @param {any} db @param {string} guildId @param {{season?:number,now?:number}} [options] */
export function assertSeasonWritable(db, guildId, { season, now = Date.now() } = {}) {
  const active = currentSeason(db, guildId);
  if (!active) return;
  if (season !== undefined && season !== active.season) {
    throw Object.assign(new Error('This action expired with the previous season.'), { code: 'SEASON_EXPIRED' });
  }
  if (seasonCutoffReached(db, guildId, now)) {
    throw Object.assign(new Error('The next season is starting. Please try again shortly.'), { code: 'SEASON_CUTOFF' });
  }
}

export function guildsAtCutoff(db,now=Date.now()) {
  if (!hasSeasonSchema(db)) return [];
  return db.prepare(`SELECT r.guild_id FROM season_rollovers r JOIN guild_seasons s USING(guild_id,season)
    WHERE r.phase IN ('announced','posting') AND r.cutoff_at<=? ORDER BY r.guild_id`).all(now)
    .map(row => String(row.guild_id));
}

export function recordSeasonPlayer(db, guildId, userId, now = Date.now()) {
  if (!hasSeasonSchema(db)) return;
  db.prepare('INSERT OR IGNORE INTO guild_seasons(guild_id,season,started_at) VALUES (?,1,?)').run(guildId, now);
  db.prepare(`INSERT OR IGNORE INTO season_players(guild_id,season,user_id)
    SELECT guild_id,season,? FROM guild_seasons WHERE guild_id=?`).run(userId, guildId);
}

export function seasonPlayers(db, guildId, season) {
  return db.prepare('SELECT user_id FROM season_players WHERE guild_id=? AND season=? ORDER BY user_id')
    .all(guildId, season).map(row => String(row.user_id));
}

export function addSeasonMessage(db, rollover, kind, { part = 0, users = [] } = {}) {
  const { guild_id, season, revision, channel_id } = rollover;
  const nonce = createHash('sha256').update(JSON.stringify([guild_id, season, revision, kind, part])).digest('hex').slice(0,25);
  db.prepare(`INSERT OR IGNORE INTO season_messages(guild_id,season,revision,kind,part,channel_id,users_json,nonce)
    VALUES (?,?,?,?,?,?,?,?)`).run(guild_id, season, revision, kind, part, channel_id, JSON.stringify(users), nonce);
}

export function claimResetBoundary(now, {claimIntervalMs, timezoneOffsetMinutes}) {
  const offset = timezoneOffsetMinutes * 60_000;
  return (Math.floor((now + offset) / claimIntervalMs) + 1) * claimIntervalMs - offset;
}

export function adjustSeasonSchedules(db, guildId, before, after, now) {
  if (before.claimIntervalMs === after.claimIntervalMs && before.timezoneOffsetMinutes === after.timezoneOffsetMinutes) return;
  const row = db.prepare(`SELECT r.* FROM season_rollovers r JOIN guild_seasons s USING(guild_id,season)
    WHERE r.guild_id=? AND r.phase IN ('queued','posting','announced')`).get(guildId);
  if (!row) return;
  if (row.phase !== 'queued') {
    if (claimResetBoundary(Number(row.cutoff_at)-1,after) !== row.cutoff_at) {
      throw Object.assign(new Error('This schedule change would move an announced season cutoff.'), { code:'CONFIG_SEASON_CUTOFF' });
    }
    return;
  }
  const reminder = claimResetBoundary(now,after);
  db.prepare('UPDATE season_rollovers SET reminder_at=?,cutoff_at=?,revision=revision+1 WHERE guild_id=? AND season=?')
    .run(reminder,claimResetBoundary(reminder,after),guildId,row.season);
}
