import { createHash } from "node:crypto";
import { hasWeeklyEventSchema } from "../../lib/weeklyEventSchema.js";
import { resolveGuildMembers } from "../../lib/serverLeaderboard.js";
import {
  advanceWeeklyContest,
  settleWeeklyContest,
  weeklyStandings,
  weeklyThemes,
} from "./weeklyEvents.js";

export async function runWeeklyWork({ db, client, now = Date.now() }) {
  if (!hasWeeklyEventSchema(db)) return;
  for (const { guild_id: guildId } of db
    .prepare("SELECT guild_id FROM weekly_controls")
    .all()) {
    advanceWeeklyContest(db, guildId, now);
  }
  const pending = db
    .prepare("SELECT id,guild_id FROM weekly_contests WHERE state='pending'")
    .all();
  for (const { id, guild_id: guildId } of pending) {
    try {
      const ids = weeklyStandings(db, id).map((row) => row.user_id);
      const guild = ids.length ? await client.guilds.fetch(guildId) : null;
      settleWeeklyContest(
        db,
        id,
        guild ? await resolveGuildMembers(guild, ids) : new Set(),
      );
    } catch (error) {
      console.error("Weekly Event membership check failed:", error.message);
    }
  }
  const notices = db
    .prepare(
      `SELECT n.*,c.guild_id,c.theme,c.ends_at,c.winner_id,c.state FROM weekly_notices n
    JOIN weekly_contests c ON c.id=n.contest_id WHERE n.message_id IS NULL ORDER BY n.contest_id,n.kind`,
    )
    .all();
  for (const notice of notices) {
    const { contest_id: id, kind, channel_id: channelId } = notice;
    if (
      kind === "start" &&
      (notice.ends_at <= now || notice.state === "cancelled")
    ) {
      db.prepare(
        "DELETE FROM weekly_notices WHERE contest_id=? AND kind=? AND message_id IS NULL",
      ).run(id, kind);
      continue;
    }
    try {
      const channel = await client.channels.fetch(channelId);
      if (channel?.guildId !== notice.guild_id || !channel.isTextBased())
        throw new Error("Announcement channel is unavailable");
      const [title, condition] = weeklyThemes[notice.theme];
      const content =
        kind === "start"
          ? `-# Weekly Event\n## ${title}\n${condition}\nEnds <t:${Math.floor(notice.ends_at / 1000)}:R>.`
          : `-# Weekly Event result\n## ${title}\n${notice.winner_id ? `<@${notice.winner_id}> won.` : "No winner."}`;
      const nonce = createHash("sha256")
        .update(`weekly:${id}:${kind}`)
        .digest("hex")
        .slice(0, 24);
      const message = await channel.send({
        content,
        nonce,
        enforceNonce: true,
        allowedMentions: { parse: [] },
      });
      db.prepare(
        "UPDATE weekly_notices SET message_id=?,last_error=NULL WHERE contest_id=? AND kind=?",
      ).run(message.id, id, kind);
    } catch (error) {
      db.prepare(
        "UPDATE weekly_notices SET last_error=? WHERE contest_id=? AND kind=?",
      ).run(String(error.message), id, kind);
    }
  }
}
