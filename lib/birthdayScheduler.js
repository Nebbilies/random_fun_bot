import {
  birthdaysOnDate,
  dateKey,
  nextMidnightUtc7,
  utc7DateParts,
} from "./birthdays.js";

const RETRY_MS = 5 * 60 * 1000;

export async function prepareBirthdayChannel(client, guildId, channelId) {
  const channel = await client.channels.fetch(channelId);
  if (
    !channel ||
    channel.guildId !== guildId ||
    !channel.isTextBased() ||
    typeof channel.send !== "function"
  ) {
    throw new Error(`Birthday channel ${channelId} is unavailable`);
  }
  if (channel.isThread?.()) {
    if (channel.archived) {
      if (!channel.unarchivable)
        throw new Error(`Birthday thread ${channelId} cannot be reopened`);
      await channel.setArchived(false);
    }
    if (!channel.joined && channel.joinable) await channel.join();
  }
  return channel;
}

export async function sendBirthdayMessage(channel, userId) {
  return channel.send({
    content: `@everyone 🎂 <@${userId}>`,
    allowedMentions: { parse: ["everyone"], users: [userId] },
  });
}

export async function announceBirthdays(client, store, now = new Date()) {
  const localDate = utc7DateParts(now);
  const today = dateKey(localDate);
  let failed = false;

  for (const [guildId, guild] of Object.entries(store.getAllGuilds())) {
    if (!guild.channelId) continue;
    const dueUsers = birthdaysOnDate(guild.users, localDate).filter(
      (userId) => guild.users[userId].lastAnnounced !== today,
    );
    if (dueUsers.length === 0) continue;

    try {
      const channel = await prepareBirthdayChannel(
        client,
        guildId,
        guild.channelId,
      );
      for (const userId of dueUsers) {
        try {
          await sendBirthdayMessage(channel, userId);
          store.markAnnounced(guildId, userId, today);
        } catch (error) {
          failed = true;
          console.error(
            `Failed to announce birthday for ${userId} in ${guildId}:`,
            error,
          );
        }
      }
    } catch (error) {
      failed = true;
      console.error(`Failed to fetch birthday channel in ${guildId}:`, error);
    }
  }

  return { failed };
}

export function startBirthdayScheduler(client, store) {
  let timer;
  const run = async () => {
    let failed = false;
    try {
      ({ failed } = await announceBirthdays(client, store));
    } catch (error) {
      failed = true;
      console.error("Birthday scheduler failed:", error);
    }
    const untilMidnight = nextMidnightUtc7().getTime() - Date.now();
    timer = setTimeout(
      run,
      failed ? Math.min(RETRY_MS, untilMidnight) : untilMidnight,
    );
  };
  void run();
  return () => clearTimeout(timer);
}
