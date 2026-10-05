import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const UTC_PLUS_7_MS = 7 * 60 * 60 * 1000;
const DEFAULT_FILE = fileURLToPath(new URL("../data/birthdays.json", import.meta.url));

export function isValidBirthday(month, day) {
    if (!Number.isInteger(month) || !Number.isInteger(day) || month < 1 || month > 12) return false;
    const daysInMonth = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return day >= 1 && day <= daysInMonth[month - 1];
}

export function utc7DateParts(date = new Date()) {
    const shifted = new Date(date.getTime() + UTC_PLUS_7_MS);
    return {
        year: shifted.getUTCFullYear(),
        month: shifted.getUTCMonth() + 1,
        day: shifted.getUTCDate(),
    };
}

export function dateKey({ year, month, day }) {
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function nextMidnightUtc7(date = new Date()) {
    const { year, month, day } = utc7DateParts(date);
    return new Date(Date.UTC(year, month - 1, day + 1) - UTC_PLUS_7_MS);
}

export function birthdaysOnDate(users, { year, month, day }) {
    const nonLeapFebruary28 = month === 2 && day === 28 &&
        new Date(Date.UTC(year, 1, 29)).getUTCMonth() !== 1;
    return Object.entries(users)
        .filter(([, birthday]) => birthday.month === month &&
            (birthday.day === day || (nonLeapFebruary28 && birthday.day === 29)))
        .map(([userId]) => userId);
}

export function upcomingBirthdays(users, from = new Date()) {
    const { year, month, day } = utc7DateParts(from);
    const start = Date.UTC(year, month - 1, day);
    const upcoming = [];
    for (let daysAway = 0; daysAway < 30; daysAway++) {
        const date = new Date(start + daysAway * 24 * 60 * 60 * 1000);
        const dateParts = {
            year: date.getUTCFullYear(),
            month: date.getUTCMonth() + 1,
            day: date.getUTCDate(),
        };
        for (const userId of birthdaysOnDate(users, dateParts).sort()) {
            upcoming.push({ userId, month: dateParts.month, day: dateParts.day, daysAway });
        }
    }
    return upcoming;
}

export class BirthdayStore {
    constructor(filePath = DEFAULT_FILE) {
        this.filePath = filePath;
    }

    read() {
        if (!existsSync(this.filePath)) return { guilds: {} };
        return JSON.parse(readFileSync(this.filePath, "utf8"));
    }

    write(data) {
        mkdirSync(dirname(this.filePath), { recursive: true });
        const temporaryPath = join(dirname(this.filePath), `.${process.pid}-${Date.now()}-birthdays.tmp`);
        writeFileSync(temporaryPath, `${JSON.stringify(data, null, 2)}\n`);
        renameSync(temporaryPath, this.filePath);
    }

    getAllGuilds() {
        return this.read().guilds;
    }

    getGuild(guildId) {
        return this.getAllGuilds()[guildId] ?? { channelId: null, users: {} };
    }

    setChannel(guildId, channelId) {
        const data = this.read();
        const guild = data.guilds[guildId] ?? { channelId: null, users: {} };
        guild.channelId = channelId;
        data.guilds[guildId] = guild;
        this.write(data);
    }

    setBirthday(guildId, userId, month, day) {
        if (!isValidBirthday(month, day)) throw new RangeError("Invalid birthday date");
        const data = this.read();
        const guild = data.guilds[guildId] ?? { channelId: null, users: {} };
        const previous = guild.users[userId];
        guild.users[userId] = {
            month,
            day,
            lastAnnounced: previous?.month === month && previous?.day === day
                ? previous.lastAnnounced ?? null
                : null,
        };
        data.guilds[guildId] = guild;
        this.write(data);
    }

    removeBirthday(guildId, userId) {
        const data = this.read();
        const users = data.guilds[guildId]?.users;
        if (!users?.[userId]) return false;
        delete users[userId];
        this.write(data);
        return true;
    }

    markAnnounced(guildId, userId, onDate) {
        const data = this.read();
        const birthday = data.guilds[guildId]?.users[userId];
        if (!birthday) throw new Error("Birthday record no longer exists");
        birthday.lastAnnounced = onDate;
        this.write(data);
    }
}
