import { PermissionFlagsBits } from "discord.js";
import { transaction } from "../../lib/catalogDb.js";
import { getGuildPrefix } from "../../lib/guildPrefix.js";
import { hasSeasonSchema } from "../../lib/seasonSchema.js";
import { resolveGuildMembers } from "../../lib/serverLeaderboard.js";
import { applySeasonRollover, closingPlayerIds } from "./seasonRollover.js";
import { addSeasonMessage, seasonPlayers } from "./seasonStore.js";
import { expireGuildTransfers } from "../trade/tradeSessions.js";
import { pruneSeasonReceipts } from "./seasonPruning.js";

const retryDelay = 5_000;
const reason = (error) => String(error?.message ?? error).slice(0, 300);
const surelyRejected = (error) =>
  Number(error?.status) >= 400 && Number(error?.status) < 500;
const whereMessage =
  "guild_id=? AND season=? AND revision=? AND kind=? AND part=?";
const key = (message) => [
  message.guild_id,
  message.season,
  message.revision,
  message.kind,
  message.part,
];

export function nextSeasonDeadline(db, now = Date.now()) {
  if (!hasSeasonSchema(db)) return null;
  const row = db
    .prepare(
      `SELECT min(deadline) AS deadline FROM (
    SELECT reminder_at AS deadline FROM season_rollovers WHERE phase='queued'
    UNION ALL
    SELECT cutoff_at AS deadline FROM season_rollovers WHERE phase IN ('posting','announced')
  ) WHERE deadline>?`,
    )
    .get(now);
  return row?.deadline == null ? null : Number(row.deadline);
}

async function guildAndChannel(client, guildId, channelId) {
  const guild =
    client.guilds.cache?.get(guildId) ?? (await client.guilds.fetch(guildId));
  const channel = await guild.channels.fetch(channelId);
  if (!channel?.isTextBased() || !channel.send || channel.guildId !== guildId)
    throw new Error("Choose a text channel in this server.");
  const permissions = channel.permissionsFor(
    guild.members.me ?? (await guild.members.fetchMe()),
  );
  const send = channel.isThread?.()
    ? PermissionFlagsBits.SendMessagesInThreads
    : PermissionFlagsBits.SendMessages;
  if (!permissions?.has([PermissionFlagsBits.ViewChannel, send]))
    throw new Error("The bot cannot post in this channel.");
  if (!permissions.has(PermissionFlagsBits.ReadMessageHistory))
    throw new Error(
      "The bot needs Read Message History to recover announcement delivery.",
    );
  return { guild, channel };
}

async function checkConfiguredChannels(db, client, now) {
  for (const row of db
    .prepare(
      "SELECT * FROM guild_season_settings WHERE channel_id IS NOT NULL AND channel_checked_at IS NULL",
    )
    .all()) {
    let error = null;
    try {
      await guildAndChannel(client, row.guild_id, row.channel_id);
    } catch (failure) {
      error = reason(failure);
    }
    db.prepare(
      "UPDATE guild_season_settings SET channel_checked_at=?,channel_error=? WHERE guild_id=? AND revision=?",
    ).run(now(), error, row.guild_id, row.revision);
  }
}

const unposted = `r.phase='queued' OR (r.phase='posting' AND NOT EXISTS (
  SELECT 1 FROM season_messages m WHERE m.guild_id=r.guild_id AND m.season=r.season
  AND m.revision=r.revision AND m.kind='reminder' AND m.state='sending'))`;
const needsCorrection = `m.kind='reminder' AND m.state IN ('sending','sent')
  AND m.retry_at IS NOT NULL AND (m.revision<>r.revision OR r.phase='canceled')`;
const previousSendResolved = `NOT EXISTS (
  SELECT 1 FROM season_messages older WHERE older.guild_id=m.guild_id AND older.season=m.season
  AND older.revision<m.revision AND older.kind='reminder' AND older.state='sending'
  AND older.retry_at IS NOT NULL)`;

export function hasDueSeasonWork(db, now = Date.now()) {
  return !!db
    .prepare(
      `SELECT 1 FROM season_rollovers r WHERE
    (r.phase='queued' AND r.reminder_at<=:now) OR
    (r.cutoff_at<=:now AND (r.phase='announced' OR ${unposted})) OR
    EXISTS (SELECT 1 FROM season_messages m WHERE m.guild_id=r.guild_id AND m.season=r.season
      AND COALESCE(m.retry_at,0)<=:now AND ((${needsCorrection}) OR
        (m.kind='reminder' AND r.phase='posting' AND m.revision=r.revision AND m.state<>'sent'
          AND ${previousSendResolved})))
    LIMIT 1`,
    )
    .get({ now });
}

function cancelMissedReminders(db, now) {
  db.prepare(
    `UPDATE season_rollovers AS r SET phase='canceled',
    last_error='The reminder was not posted before cutoff. The current season continues.'
    WHERE r.cutoff_at<=? AND (${unposted})`,
  ).run(now);
}

function announcement(db, rollover, message, prefix, users) {
  const number = Number(rollover.season);
  const time = `<t:${Math.floor(Number(rollover.cutoff_at) / 1000)}:F>`;
  if (message.kind === "start")
    return `**Season ${number + 1} has started!** View Season ${number}'s final card with \`${getGuildPrefix(db, rollover.guild_id, prefix)}profile\`.`;
  if (message.kind === "ping") {
    return `Season ${number} players: ${users.map((id) => `<@${id}>`).join(" ")}\nRollover: ${time}.`;
  }
  return `**Season ${number + 1} starts ${time}.** Choose the soulmate you want to carry over with \`${getGuildPrefix(db, rollover.guild_id, prefix)}soulmate\`. You can bypass the switch cooldown once before rollover.`;
}

async function findSentMessage(db, channel, client, message) {
  const attempt = Number(message.attempted_at);
  const otherReminders =
    message.kind === "reminder"
      ? new Set(
          db
            .prepare(
              `SELECT message_id FROM season_messages
      WHERE guild_id=? AND season=? AND kind='reminder' AND revision<>? AND message_id IS NOT NULL`,
            )
            .all(message.guild_id, message.season, message.revision)
            .map((row) => row.message_id),
        )
      : new Set();
  let before = message.search_before;
  for (let page = 0; page < 5; page++) {
    const batch = await channel.messages.fetch(
      before ? { before, limit: 100 } : { limit: 100 },
    );
    const ordered = [...batch.values()].sort(
      (a, b) => b.createdTimestamp - a.createdTimestamp,
    );
    const sent = ordered.find(
      (entry) =>
        entry.author?.id === client.user?.id &&
        entry.createdTimestamp >= attempt - 2_000 &&
        !otherReminders.has(entry.id) &&
        entry.content === message.content,
    );
    if (sent) return { status: "found", message: sent };
    const oldest = ordered.at(-1);
    if (
      !oldest ||
      oldest.createdTimestamp < attempt - 2_000 ||
      ordered.length < 100
    )
      return { status: "absent" };
    before = oldest.id;
  }
  return { status: "continue", before };
}

function finishMessage(db, rollover, message, posted, now) {
  transaction(db, () => {
    let correction = null;
    if (message.kind === "reminder") {
      const current = db
        .prepare(
          `SELECT revision,phase FROM season_rollovers
        WHERE guild_id=? AND season=?`,
        )
        .get(rollover.guild_id, rollover.season);
      if (
        current.revision !== message.revision ||
        current.phase === "canceled"
      ) {
        correction = now;
      } else if (current.phase === "posting") {
        const postedAt = posted.createdTimestamp ?? now;
        if (postedAt < rollover.cutoff_at) {
          db.prepare(
            `UPDATE season_rollovers SET phase='announced',announced_at=?,last_error=NULL
            WHERE guild_id=? AND season=?`,
          ).run(postedAt, rollover.guild_id, rollover.season);
        } else {
          db.prepare(
            `UPDATE season_rollovers SET phase='canceled',
            last_error='The reminder was posted at or after cutoff. The current season continues.'
            WHERE guild_id=? AND season=?`,
          ).run(rollover.guild_id, rollover.season);
          correction = now;
        }
      }
    }
    db.prepare(
      `UPDATE season_messages SET state='sent',message_id=?,search_before=NULL,retry_at=?,last_error=NULL WHERE ${whereMessage}`,
    ).run(posted.id, correction, ...key(message));
  });
}

async function deliver(
  db,
  client,
  rollover,
  message,
  guild,
  channel,
  now,
  prefix,
) {
  if (message.kind === "ping" && now() >= rollover.cutoff_at) return;
  if (message.state === "sending") {
    if (now() - Number(message.attempted_at) < retryDelay) return;
    try {
      const match = await findSentMessage(db, channel, client, message);
      if (match.status === "found") {
        finishMessage(db, rollover, message, match.message, now());
        return;
      }
      if (match.status === "continue") {
        db.prepare(
          `UPDATE season_messages SET search_before=?,last_error=? WHERE ${whereMessage}`,
        ).run(
          match.before,
          "Searching message history to confirm delivery.",
          ...key(message),
        );
        return;
      }
      db.prepare(
        `UPDATE season_messages SET state='pending',retry_at=NULL,search_before=NULL
          WHERE ${whereMessage} AND state='sending'
          AND EXISTS (SELECT 1 FROM season_rollovers r WHERE r.guild_id=season_messages.guild_id
          AND r.season=season_messages.season AND r.revision=season_messages.revision AND r.phase<>'canceled')`,
      ).run(...key(message));
      return;
    } catch (error) {
      db.prepare(
        `UPDATE season_messages SET last_error=?,retry_at=? WHERE ${whereMessage}`,
      ).run(reason(error), now() + retryDelay, ...key(message));
      return;
    }
  }

  if (message.kind !== "start" && now() >= rollover.cutoff_at) return;
  let users = JSON.parse(message.users_json);
  if (message.kind === "ping" && message.content === null) {
    const members = await resolveGuildMembers(guild, users);
    users = users.filter((id) => members.has(id) && !members.get(id).user?.bot);
    if (!users.length) {
      db.prepare(
        `DELETE FROM season_messages WHERE ${whereMessage}
        AND state='pending' AND content IS NULL`,
      ).run(...key(message));
      return;
    }
  }
  const content =
    message.content ?? announcement(db, rollover, message, prefix, users);
  const sentAt = now();
  const claimed = db
    .prepare(
      `UPDATE season_messages SET state='sending',content=?,users_json=?,attempted_at=?,search_before=NULL,retry_at=NULL
    WHERE ${whereMessage} AND state='pending' AND EXISTS (
      SELECT 1 FROM season_rollovers r WHERE r.guild_id=season_messages.guild_id AND r.season=season_messages.season
      AND r.revision=season_messages.revision AND r.phase<>'canceled'
      AND (season_messages.kind='start' OR r.cutoff_at>?))`,
    )
    .run(content, JSON.stringify(users), sentAt, ...key(message), sentAt);
  if (!claimed.changes) return;
  try {
    const posted = await channel.send({
      content,
      nonce: message.nonce,
      enforceNonce: true,
      allowedMentions: {
        parse: [],
        users,
        repliedUser: false,
      },
    });
    finishMessage(db, rollover, message, posted, now());
  } catch (error) {
    const rejected = surelyRejected(error);
    db.prepare(
      `UPDATE season_messages SET state=?,last_error=?,retry_at=? WHERE ${whereMessage}`,
    ).run(
      rejected ? "pending" : "sending",
      reason(error),
      now() + retryDelay,
      ...key(message),
    );
  }
}

function startReminder(db, rollover, now) {
  transaction(db, () => {
    const update = db
      .prepare(
        `UPDATE season_rollovers SET phase='posting'
      WHERE guild_id=? AND season=? AND revision=? AND phase='queued' AND cutoff_at>?`,
      )
      .run(rollover.guild_id, rollover.season, rollover.revision, now());
    if (!update.changes) return;
    addSeasonMessage(db, rollover, "reminder");
    const users = seasonPlayers(db, rollover.guild_id, rollover.season);
    for (let offset = 0; offset < users.length; offset += 70)
      addSeasonMessage(db, rollover, "ping", {
        part: offset / 70,
        users: users.slice(offset, offset + 70),
      });
  });
}

async function sendPending(db, client, now, prefix, reminders) {
  const eligible = reminders
    ? `m.kind='reminder' AND r.phase='posting' AND ${previousSendResolved}`
    : "((m.kind='ping' AND r.phase='announced' AND r.cutoff_at>?) OR (m.kind='start' AND r.phase='applied'))";
  const time = now();
  const messages = db
    .prepare(
      `SELECT m.* FROM season_messages m JOIN season_rollovers r USING(guild_id,season,revision)
    WHERE m.state<>'sent' AND COALESCE(m.retry_at,0)<=? AND ${eligible}
    ORDER BY COALESCE(m.retry_at,m.attempted_at,0),m.kind DESC,r.reminder_at,m.part LIMIT 24`,
    )
    .all(time, ...(reminders ? [] : [time]));
  for (const message of messages) {
    const rollover = db
      .prepare("SELECT * FROM season_rollovers WHERE guild_id=? AND season=?")
      .get(message.guild_id, message.season);
    if (rollover?.revision !== message.revision) continue;
    if (
      message.kind === "reminder" &&
      message.state === "pending" &&
      now() >= rollover.cutoff_at
    )
      continue;
    try {
      const { guild, channel } = await guildAndChannel(
        client,
        message.guild_id,
        message.channel_id,
      );
      await deliver(db, client, rollover, message, guild, channel, now, prefix);
    } catch (error) {
      db.prepare(
        `UPDATE season_messages SET last_error=?,retry_at=? WHERE ${whereMessage}`,
      ).run(reason(error), now() + retryDelay, ...key(message));
    }
  }
}

// retry_at tracks edits on retired reminder revisions. The original send state
// and search cursor also let cancellation survive an ambiguous Discord response.
async function correctCanceledReminders(db, client, now) {
  const messages = db
    .prepare(
      `SELECT m.* FROM season_messages m JOIN season_rollovers r USING(guild_id,season)
    WHERE ${needsCorrection} AND m.retry_at<=? ORDER BY m.retry_at LIMIT 24`,
    )
    .all(now());
  for (const message of messages) {
    const update = (query, ...args) =>
      db
        .prepare(`UPDATE season_messages SET ${query} WHERE ${whereMessage}`)
        .run(...args, ...key(message));
    let messageId = message.message_id;
    try {
      if (!messageId && now() - Number(message.attempted_at) < retryDelay)
        continue;
      const { channel } = await guildAndChannel(
        client,
        message.guild_id,
        message.channel_id,
      );
      if (!messageId) {
        const match = await findSentMessage(db, channel, client, message);
        if (match.status === "continue") {
          update("search_before=?", match.before);
          continue;
        }
        if (match.status === "absent") {
          update("retry_at=NULL,search_before=NULL,last_error=NULL");
          continue;
        }
        messageId = match.message.id;
        update("state='sent',message_id=?,search_before=NULL", messageId);
      }
      await channel.messages.edit(messageId, {
        content: `**Season rollover canceled.** Season ${message.season} continues.`,
        allowedMentions: { parse: [], users: [], repliedUser: false },
      });
      update("retry_at=NULL,last_error=NULL");
    } catch (error) {
      if (messageId && Number(error?.code) === 10008) {
        update("retry_at=NULL,last_error=NULL");
      } else {
        update("retry_at=?,last_error=?", now() + retryDelay, reason(error));
      }
    }
  }
}

/** @param {{db:any,client:any,prefix?:string,now?:()=>number,maintenance?:boolean}} options */
export async function runSeasonWork({
  db,
  client,
  prefix = "!",
  now = Date.now,
  maintenance = true,
}) {
  if (!hasSeasonSchema(db)) return;
  if (maintenance) await checkConfiguredChannels(db, client, now);
  cancelMissedReminders(db, now());
  const upcoming = db
    .prepare(
      "SELECT * FROM season_rollovers WHERE phase='queued' AND reminder_at<=? ORDER BY reminder_at",
    )
    .all(now());
  for (const rollover of upcoming) startReminder(db, rollover, now);
  await sendPending(db, client, now, prefix, true);
  cancelMissedReminders(db, now());

  const due = db
    .prepare(
      "SELECT * FROM season_rollovers WHERE phase='announced' AND cutoff_at<=? ORDER BY cutoff_at",
    )
    .all(now());
  for (const rollover of due) {
    try {
      const guild =
        client.guilds.cache?.get(rollover.guild_id) ??
        (await client.guilds.fetch(rollover.guild_id));
      const members = await resolveGuildMembers(
        guild,
        closingPlayerIds(db, rollover.guild_id, rollover.season),
      );
      const result = applySeasonRollover(db, {
        guildId: rollover.guild_id,
        season: rollover.season,
        members: new Set(members.keys()),
        now: now(),
      });
      if (result.status === "applied")
        expireGuildTransfers(db, rollover.guild_id);
    } catch (error) {
      db.prepare(
        "UPDATE season_rollovers SET last_error=? WHERE guild_id=? AND season=? AND phase='announced'",
      ).run(reason(error), rollover.guild_id, rollover.season);
    }
  }
  await correctCanceledReminders(db, client, now);
  await sendPending(db, client, now, prefix, false);
  if (maintenance) pruneSeasonReceipts(db, { now: now() });
}
