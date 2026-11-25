import { PermissionFlagsBits } from "discord.js";
import { transaction } from "../../lib/catalogDb.js";
import { getGuildPrefix } from "../../lib/guildPrefix.js";
import { hasSeasonSchema } from "../../lib/seasonSchema.js";
import { resolveGuildMembers } from "../../lib/serverLeaderboard.js";
import { nextClaimReset } from "../rolls/rollAllowanceService.js";
import { applySeasonRollover, closingPlayerIds } from "./seasonRollover.js";
import { addSeasonMessage, seasonPlayers } from "./seasonStore.js";
import { expireGuildTransfers } from "../trade/tradeSessions.js";
import { pruneSeasonReceipts } from "./seasonPruning.js";

const lookback = 20_000;
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

function deferReminder(db, rollover, now, error) {
  const reminderAt = nextClaimReset(now, db, rollover.guild_id);
  db.prepare(
    `UPDATE season_rollovers SET phase='queued',revision=revision+1,reminder_at=?,cutoff_at=?,last_error=?
    WHERE guild_id=? AND season=? AND revision=? AND phase IN ('queued','posting')`,
  ).run(
    reminderAt,
    nextClaimReset(reminderAt, db, rollover.guild_id),
    error,
    rollover.guild_id,
    rollover.season,
    rollover.revision,
  );
}

function announcement(db, rollover, message, prefix) {
  const number = Number(rollover.season);
  const time = `<t:${Math.floor(Number(rollover.cutoff_at) / 1000)}:F>`;
  if (message.kind === "start")
    return `**Season ${number + 1} has started!** View Season ${number}'s final card with \`${getGuildPrefix(db, rollover.guild_id, prefix)}profile\`.`;
  if (message.kind === "ping") {
    const users = JSON.parse(message.users_json);
    return `Season ${number} players: ${users.map((id) => `<@${id}>`).join(" ")}\nRollover: ${time}.`;
  }
  return `**Season ${number + 1} starts ${time}.** Choose the soulmate you want to carry over with \`${getGuildPrefix(db, rollover.guild_id, prefix)}soulmate\`. You can bypass the switch cooldown once before rollover.`;
}

async function findSentMessage(channel, client, message) {
  const attempt = Number(message.attempted_at);
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
        entry.content === message.content,
    );
    if (sent) return { status: "found", id: sent.id };
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

function finishMessage(db, rollover, message, id, now) {
  transaction(db, () => {
    db.prepare(
      `UPDATE season_messages SET state='sent',message_id=?,search_before=NULL,retry_at=NULL,last_error=NULL WHERE ${whereMessage}`,
    ).run(id, ...key(message));
    if (message.kind === "reminder")
      db.prepare(
        `UPDATE season_rollovers SET phase='announced',announced_at=?,last_error=NULL
      WHERE guild_id=? AND season=? AND revision=? AND phase='posting'`,
      ).run(now, rollover.guild_id, rollover.season, rollover.revision);
  });
}

async function deliver(db, client, rollover, message, channel, now, prefix) {
  if (message.kind === "ping" && now() >= rollover.cutoff_at) return;
  if (message.state === "sending") {
    if (now() - Number(message.attempted_at) < retryDelay) return;
    try {
      const match = await findSentMessage(channel, client, message);
      if (match.status === "found") {
        finishMessage(db, rollover, message, match.id, now());
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
      if (message.kind === "reminder") {
        deferReminder(
          db,
          rollover,
          now(),
          "Reminder delivery could not be confirmed. Scheduled for the next claim window.",
        );
        return;
      }
      db.prepare(
        `UPDATE season_messages SET state='pending' WHERE ${whereMessage} AND state='sending'`,
      ).run(...key(message));
    } catch (error) {
      db.prepare(
        `UPDATE season_messages SET last_error=?,retry_at=? WHERE ${whereMessage}`,
      ).run(reason(error), now() + retryDelay, ...key(message));
      return;
    }
  }

  const content =
    message.content ?? announcement(db, rollover, message, prefix);
  if (message.kind === "ping" && now() >= rollover.cutoff_at) return;
  const claims = db
    .prepare(
      `UPDATE season_messages SET state='sending',content=?,attempted_at=?,search_before=NULL,retry_at=NULL
    WHERE ${whereMessage} AND state='pending' AND EXISTS (
      SELECT 1 FROM season_rollovers r WHERE r.guild_id=season_messages.guild_id AND r.season=season_messages.season
      AND r.revision=season_messages.revision AND r.phase<>'canceled')`,
    )
    .run(content, now(), ...key(message));
  if (!claims.changes) return;
  try {
    const posted = await channel.send({
      content,
      nonce: message.nonce,
      enforceNonce: true,
      allowedMentions: {
        parse: [],
        users: JSON.parse(message.users_json),
        repliedUser: false,
      },
    });
    finishMessage(db, rollover, message, posted.id, now());
  } catch (error) {
    const rejected = surelyRejected(error);
    db.prepare(
      `UPDATE season_messages SET state=?,last_error=? WHERE ${whereMessage}`,
    ).run(rejected ? "pending" : "sending", reason(error), ...key(message));
    if (rejected && message.kind === "reminder")
      deferReminder(db, rollover, now(), reason(error));
  }
}

async function startReminder(db, client, rollover, now) {
  if (
    now() - Number(rollover.reminder_at) > lookback ||
    now() >= rollover.cutoff_at
  ) {
    deferReminder(
      db,
      rollover,
      now(),
      "The scheduled reminder window was missed.",
    );
    return;
  }
  let members;
  try {
    const { guild } = await guildAndChannel(
      client,
      rollover.guild_id,
      rollover.channel_id,
    );
    members = await resolveGuildMembers(
      guild,
      seasonPlayers(db, rollover.guild_id, rollover.season),
    );
  } catch (error) {
    deferReminder(db, rollover, now(), reason(error));
    return;
  }
  transaction(db, () => {
    const update = db
      .prepare(
        `UPDATE season_rollovers SET phase='posting'
      WHERE guild_id=? AND season=? AND revision=? AND phase='queued' AND cutoff_at>?`,
      )
      .run(rollover.guild_id, rollover.season, rollover.revision, now());
    if (!update.changes) return;
    addSeasonMessage(db, rollover, "reminder");
    const users = [...members]
      .filter(([, member]) => !member.user?.bot)
      .map(([id]) => id);
    for (let start = 0; start < users.length; start += 70) {
      addSeasonMessage(db, rollover, "ping", {
        part: start / 70,
        users: users.slice(start, start + 70),
      });
    }
  });
}

async function sendPending(db, client, now, prefix, reminders) {
  const eligible = reminders
    ? "m.kind='reminder' AND r.phase='posting'"
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
      (now() - Number(rollover.reminder_at) > lookback ||
        now() >= rollover.cutoff_at)
    ) {
      deferReminder(
        db,
        rollover,
        now(),
        "The scheduled reminder window was missed.",
      );
      continue;
    }
    try {
      const { channel } = await guildAndChannel(
        client,
        message.guild_id,
        message.channel_id,
      );
      await deliver(db, client, rollover, message, channel, now, prefix);
    } catch (error) {
      db.prepare(
        `UPDATE season_messages SET last_error=?,retry_at=? WHERE ${whereMessage}`,
      ).run(reason(error), now() + retryDelay, ...key(message));
      if (message.kind === "reminder" && message.state === "pending")
        deferReminder(db, rollover, now(), reason(error));
    }
  }
}

/** @param {{db:any,client:any,prefix?:string,now?:()=>number}} options */
export async function runSeasonWork({
  db,
  client,
  prefix = "!",
  now = Date.now,
}) {
  if (!hasSeasonSchema(db)) return;
  await checkConfiguredChannels(db, client, now);
  const upcoming = db
    .prepare(
      "SELECT * FROM season_rollovers WHERE phase='queued' AND reminder_at<=? ORDER BY reminder_at",
    )
    .all(now());
  for (const rollover of upcoming)
    await startReminder(db, client, rollover, now);
  await sendPending(db, client, now, prefix, true);

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
  await sendPending(db, client, now, prefix, false);
  pruneSeasonReceipts(db, { now: now() });
}
