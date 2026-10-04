import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PermissionFlagsBits } from "discord.js";
import {
    BirthdayStore,
    birthdaysOnDate,
    isValidBirthday,
    nextMidnightUtc7,
} from "../lib/birthdays.js";
import { announceBirthdays } from "../lib/birthdayScheduler.js";
import { data, execute, handleButton } from "../commands/utility/birthday.js";

test("validates yearless birthdays and maps February 29 in non-leap years", () => {
    assert.equal(isValidBirthday(2, 29), true);
    assert.equal(isValidBirthday(4, 31), false);
    assert.equal(isValidBirthday(13, 1), false);
    assert.equal(isValidBirthday(1, 0), false);

    const users = {
        leap: { month: 2, day: 29 },
        regular: { month: 2, day: 28 },
    };
    assert.deepEqual(birthdaysOnDate(users, { year: 2026, month: 2, day: 28 }), ["leap", "regular"]);
    assert.deepEqual(birthdaysOnDate(users, { year: 2028, month: 2, day: 28 }), ["regular"]);
    assert.deepEqual(birthdaysOnDate(users, { year: 2028, month: 2, day: 29 }), ["leap"]);
});

test("computes the next UTC+7 midnight", () => {
    assert.equal(nextMidnightUtc7(new Date("2026-10-03T16:59:59.000Z")).toISOString(), "2026-10-03T17:00:00.000Z");
    assert.equal(nextMidnightUtc7(new Date("2026-10-03T17:00:00.000Z")).toISOString(), "2026-10-04T17:00:00.000Z");
});

test("stores birthdays, channels, and delivery dates separately per server", () => {
    const directory = mkdtempSync(join(tmpdir(), "birthday-test-"));
    try {
        const store = new BirthdayStore(join(directory, "birthdays.json"));
        store.setChannel("guild-a", "channel-a");
        store.setBirthday("guild-a", "user-a", 10, 4);
        store.setBirthday("guild-b", "user-a", 12, 25);
        store.markAnnounced("guild-a", "user-a", "2026-10-04");

        const reloaded = new BirthdayStore(join(directory, "birthdays.json"));
        assert.equal(reloaded.getGuild("guild-a").channelId, "channel-a");
        assert.deepEqual(reloaded.getGuild("guild-a").users["user-a"], {
            month: 10,
            day: 4,
            lastAnnounced: "2026-10-04",
        });
        assert.deepEqual(reloaded.getGuild("guild-b").users["user-a"], {
            month: 12,
            day: 25,
            lastAnnounced: null,
        });
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("announces each due user once with the exact requested message", async () => {
    const directory = mkdtempSync(join(tmpdir(), "birthday-test-"));
    try {
        const store = new BirthdayStore(join(directory, "birthdays.json"));
        store.setChannel("guild-a", "channel-a");
        store.setBirthday("guild-a", "user-a", 10, 4);
        store.setBirthday("guild-a", "user-b", 10, 4);
        const sent = [];
        const channel = {
            guildId: "guild-a",
            isTextBased: () => true,
            send: async (message) => sent.push(message),
        };
        const client = { channels: { fetch: async () => channel } };
        const today = new Date("2026-10-03T17:00:00.000Z");

        await announceBirthdays(client, store, today);
        await announceBirthdays(client, store, today);

        assert.deepEqual(sent.map((message) => message.content), [
            "@everyone 🎂 <@user-a>",
            "@everyone 🎂 <@user-b>",
        ]);
        assert.deepEqual(sent[0].allowedMentions, { parse: ["everyone"], users: ["user-a"] });
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("sets your own birthday publicly and requires target confirmation for another user", async () => {
    const directory = mkdtempSync(join(tmpdir(), "birthday-test-"));
    try {
        const store = new BirthdayStore(join(directory, "birthdays.json"));
        const replies = [];
        const user = { id: "111", bot: false, toString: () => "<@111>" };
        const target = { id: "222", bot: false, toString: () => "<@222>" };
        const interaction = {
            inGuild: () => true,
            guildId: "333",
            user,
            options: {
                getSubcommand: () => "set",
                getInteger: (name) => name === "day" ? 4 : 10,
                getUser: () => null,
            },
            reply: async (message) => replies.push(message),
        };

        await execute(null, interaction, store);
        assert.equal(replies[0].content, "Your birthday is set to 4/10.");
        assert.equal(replies[0].ephemeral, undefined);
        assert.equal(store.getGuild("333").users["111"].day, 4);

        interaction.options.getUser = () => target;
        await execute(null, interaction, store);
        const proposal = replies[1];
        assert.equal(proposal.content, "<@222>");
        assert.equal(proposal.components[0].components.length, 2);
        assert.equal(store.getGuild("333").users["222"], undefined);

        const updates = [];
        const button = {
            customId: proposal.components[0].components[0].data.custom_id,
            guildId: "333",
            user: { id: "111" },
            reply: async (message) => replies.push(message),
            update: async (message) => updates.push(message),
        };
        await handleButton(button, store);
        assert.equal(store.getGuild("333").users["222"], undefined);
        assert.equal(replies[2].ephemeral, true);

        button.user.id = "222";
        await handleButton(button, store);
        assert.deepEqual(store.getGuild("333").users["222"], {
            month: 10,
            day: 4,
            lastAnnounced: null,
        });
        assert.deepEqual(updates[0].components, []);

        interaction.options.getUser = () => ({ id: "444", bot: false });
        await execute(null, interaction, store);
        button.customId = replies[3].components[0].components[1].data.custom_id;
        button.user.id = "444";
        await handleButton(button, store);
        assert.equal(store.getGuild("333").users["444"], undefined);
        assert.deepEqual(updates[1].components, []);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("limits channel configuration to server managers", async () => {
    const directory = mkdtempSync(join(tmpdir(), "birthday-test-"));
    try {
        const store = new BirthdayStore(join(directory, "birthdays.json"));
        const replies = [];
        const interaction = {
            inGuild: () => true,
            guildId: "333",
            memberPermissions: { has: () => false },
            options: {
                getSubcommand: () => "channel",
                getChannel: () => ({ id: "555", permissionsFor: () => ({ has: () => true }) }),
            },
            guild: { members: { fetchMe: async () => ({ id: "bot" }) } },
            reply: async (message) => replies.push(message),
        };

        await execute(null, interaction, store);
        assert.equal(replies[0].ephemeral, true);
        assert.equal(store.getGuild("333").channelId, null);

        interaction.memberPermissions.has = () => true;
        await execute(null, interaction, store);
        assert.equal(replies[1].content, "Birthday announcements will go to <#555>.");
        assert.equal(store.getGuild("333").channelId, "555");
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("denies unauthorized birthday tests without mentioning another user", async () => {
    const replies = [];
    await execute(null, {
        options: { getSubcommand: () => "test" },
        user: { id: "111" },
        reply: async (message) => replies.push(message),
    });
    assert.equal(replies[0].content, "You can't test this command.");
});

test("accepts a thread and reopens it before an announcement", async () => {
    const directory = mkdtempSync(join(tmpdir(), "birthday-test-"));
    try {
        const store = new BirthdayStore(join(directory, "birthdays.json"));
        const events = [];
        const checkedPermissions = [];
        const thread = {
            id: "555",
            guildId: "333",
            archived: true,
            unarchivable: true,
            joined: false,
            joinable: true,
            isThread: () => true,
            isTextBased: () => true,
            permissionsFor: () => ({ has: (permissions) => {
                checkedPermissions.push(permissions);
                return true;
            } }),
            setArchived: async () => events.push("unarchive"),
            join: async () => events.push("join"),
            send: async (message) => events.push(message.content),
        };
        const interaction = {
            inGuild: () => true,
            guildId: "333",
            memberPermissions: { has: () => true },
            options: { getSubcommand: () => "channel", getChannel: () => thread },
            guild: { members: { fetchMe: async () => ({ id: "bot" }) } },
            reply: async () => {},
        };

        await execute(null, interaction, store);
        assert.equal(store.getGuild("333").channelId, "555");
        assert.equal(checkedPermissions[0].includes(PermissionFlagsBits.SendMessagesInThreads), true);
        store.setBirthday("333", "222", 10, 4);
        await announceBirthdays({ channels: { fetch: async () => thread } }, store, new Date("2026-10-03T17:00:00.000Z"));
        assert.deepEqual(events, ["unarchive", "join", "@everyone 🎂 <@222>"]);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("lists birthdays in public, sorted pages of 20 lines, and lets anyone turn pages", async () => {
    const directory = mkdtempSync(join(tmpdir(), "birthday-test-"));
    try {
        const store = new BirthdayStore(join(directory, "birthdays.json"));
        assert.equal(data.toJSON().options.some((option) => option.name === "list"), true);
        for (let day = 21; day >= 1; day--) {
            store.setBirthday("333", String(100 + day), 1, day);
        }
        store.setBirthday("333", "500", 3, 5);
        store.setBirthday("333", "600", 12, 25);
        store.setBirthday("444", "700", 2, 14);

        const replies = [];
        const interaction = {
            inGuild: () => true,
            guildId: "333",
            user: { id: "111" },
            options: { getSubcommand: () => "list" },
            reply: async (message) => replies.push(message),
        };
        await execute(null, interaction, store);

        const first = replies[0];
        assert.equal(first.ephemeral, undefined);
        assert.deepEqual(first.allowedMentions, { parse: [] });
        assert.equal(first.embeds[0].data.description.split("\n").length, 20);
        assert.equal(first.embeds[0].data.description.split("\n")[0], "**January**");
        assert.equal(first.embeds[0].data.description.split("\n")[1], "1 — <@101>");
        assert.equal(first.components[0].components[0].data.disabled, true);

        const updates = [];
        await handleButton({
            customId: first.components[0].components[1].data.custom_id,
            guildId: "333",
            user: { id: "999" },
            update: async (message) => updates.push(message),
        }, store);

        const second = updates[0];
        assert.deepEqual(second.allowedMentions, { parse: [] });
        assert.equal(second.embeds[0].data.description, [
            "**January (continued)**",
            "20 — <@120>",
            "21 — <@121>",
            "**March**",
            "5 — <@500>",
            "**December**",
            "25 — <@600>",
        ].join("\n"));
        assert.equal(second.embeds[0].data.footer.text, "Page 2 of 2");
        assert.equal(second.components[0].components[1].data.disabled, true);

        await handleButton({
            customId: second.components[0].components[0].data.custom_id,
            guildId: "333",
            user: { id: "888" },
            update: async (message) => updates.push(message),
        }, store);
        assert.equal(updates[1].embeds[0].data.description, first.embeds[0].data.description);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("shows an empty birthday list", async () => {
    const directory = mkdtempSync(join(tmpdir(), "birthday-test-"));
    try {
        const store = new BirthdayStore(join(directory, "birthdays.json"));
        const replies = [];
        const interaction = {
            inGuild: () => true,
            guildId: "333",
            user: { id: "111" },
            options: { getSubcommand: () => "list" },
            reply: async (message) => replies.push(message),
        };

        await execute(null, interaction, store);
        assert.match(replies[0].embeds[0].data.description, /No birthdays/);
        assert.deepEqual(replies[0].components, []);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
