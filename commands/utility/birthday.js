import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    EmbedBuilder,
    PermissionFlagsBits,
    SlashCommandBuilder,
} from "discord.js";
import { BirthdayStore, isValidBirthday, upcomingBirthdays } from "../../lib/birthdays.js";
import { prepareBirthdayChannel, sendBirthdayMessage } from "../../lib/birthdayScheduler.js";

const store = new BirthdayStore();
const PROPOSAL_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const TESTER_ID = "227447542911074304";
const LIST_LINES_PER_PAGE = 20;
const MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
];

export const data = new SlashCommandBuilder()
    .setName("birthday")
    .setDescription("Manage birthday announcements")
    .addSubcommand((subcommand) => subcommand
        .setName("set")
        .setDescription("Set your birthday or propose one for another user")
        .addIntegerOption((option) => option.setName("day").setDescription("Day of the month").setRequired(true).setMinValue(1).setMaxValue(31))
        .addIntegerOption((option) => option.setName("month").setDescription("Month of the year").setRequired(true).setMinValue(1).setMaxValue(12))
        .addUserOption((option) => option.setName("user").setDescription("User whose birthday to set (defaults to you)")))
    .addSubcommand((subcommand) => subcommand
        .setName("list")
        .setDescription("View saved birthdays in this server"))
    .addSubcommand((subcommand) => subcommand
        .setName("remove")
        .setDescription("Remove your saved birthday from this server"))
    .addSubcommand((subcommand) => subcommand
        .setName("upcoming")
        .setDescription("View birthdays in the next 30 days"))
    .addSubcommand((subcommand) => subcommand
        .setName("channel")
        .setDescription("Choose the channel for birthday announcements")
        .addChannelOption((option) => option.setName("channel")
            .setDescription("Birthday announcement channel")
            .setRequired(true)
            .addChannelTypes(
                ChannelType.GuildText,
                ChannelType.GuildAnnouncement,
                ChannelType.PublicThread,
                ChannelType.PrivateThread,
                ChannelType.AnnouncementThread,
            )))
    .addSubcommand((subcommand) => subcommand
        .setName("test")
        .setDescription("Send a birthday announcement test")
        .addUserOption((option) => option.setName("user")
            .setDescription("User to mention in the test")
            .setRequired(true)));

function proposalButtons(guildId, targetId, month, day) {
    const proposal = `${guildId}:${targetId}:${month}:${day}:${Date.now()}`;
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`birthday:confirm:${proposal}`).setLabel("Confirm").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`birthday:deny:${proposal}`).setLabel("Deny").setStyle(ButtonStyle.Danger),
    );
}

function birthdayListPages(users) {
    const birthdays = Object.entries(users).sort(([firstId, first], [secondId, second]) =>
        first.month - second.month || first.day - second.day || firstId.localeCompare(secondId));
    const pages = [];
    let lines = [];
    let currentMonth = null;

    for (const [userId, birthday] of birthdays) {
        const monthName = MONTH_NAMES[birthday.month - 1];
        if (birthday.month !== currentMonth) {
            if (lines.length > LIST_LINES_PER_PAGE - 2) {
                pages.push(lines.join("\n"));
                lines = [];
            }
            lines.push(`**${monthName}**`);
            currentMonth = birthday.month;
        } else if (lines.length === LIST_LINES_PER_PAGE) {
            pages.push(lines.join("\n"));
            lines = [`**${monthName} (continued)**`];
        }
        lines.push(`${birthday.day} — <@${userId}>`);
    }
    if (lines.length) pages.push(lines.join("\n"));
    return pages;
}

function birthdayPageMessage(guildId, pages, requestedPage, action, title, emptyMessage) {
    const page = Math.min(requestedPage, Math.max(pages.length - 1, 0));
    const embed = new EmbedBuilder()
        .setTitle(title)
        .setDescription(pages[page] ?? emptyMessage);
    if (pages.length) embed.setFooter({ text: `Page ${page + 1} of ${pages.length}` });

    const components = pages.length > 1 ? [new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`birthday:${action}:${guildId}:${page - 1}`)
            .setLabel("Previous")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page === 0),
        new ButtonBuilder()
            .setCustomId(`birthday:${action}:${guildId}:${page + 1}`)
            .setLabel("Next")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page === pages.length - 1),
    )] : [];
    return { embeds: [embed], components, allowedMentions: { parse: [] } };
}

function birthdayListMessage(guildId, users, requestedPage = 0) {
    return birthdayPageMessage(guildId, birthdayListPages(users), requestedPage,
        "list", "Server birthdays", "No birthdays have been saved in this server.");
}

function birthdayUpcomingMessage(guildId, users, requestedPage = 0, now = new Date()) {
    const entries = upcomingBirthdays(users, now);
    const pages = [];
    for (let index = 0; index < entries.length; index += LIST_LINES_PER_PAGE) {
        pages.push(entries.slice(index, index + LIST_LINES_PER_PAGE).map(({ userId, month, day, daysAway }) => {
            const when = daysAway === 0 ? "today" : `in ${daysAway} ${daysAway === 1 ? "day" : "days"}`;
            return `**${day} ${MONTH_NAMES[month - 1]}** — <@${userId}> (${when})`;
        }).join("\n"));
    }
    return birthdayPageMessage(guildId, pages, requestedPage,
        "upcoming", "Upcoming birthdays", "No birthdays in the next 30 days.");
}

export async function execute(client, interaction, birthdayStore = store) {
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === "test" && interaction.user.id !== TESTER_ID) {
        await interaction.reply({ content: "You can't test this command." });
        return;
    }
    if (!interaction.inGuild()) {
        await interaction.reply({ content: "Use this command in a server.", ephemeral: true });
        return;
    }

    if (subcommand === "list") {
        await interaction.reply(birthdayListMessage(interaction.guildId, birthdayStore.getGuild(interaction.guildId).users));
        return;
    }

    if (subcommand === "upcoming") {
        await interaction.reply(birthdayUpcomingMessage(interaction.guildId,
            birthdayStore.getGuild(interaction.guildId).users, 0, interaction.createdAt ?? new Date()));
        return;
    }

    if (subcommand === "remove") {
        const removed = birthdayStore.removeBirthday(interaction.guildId, interaction.user.id);
        await interaction.reply({ content: removed
            ? "Your birthday was removed."
            : "You don't have a saved birthday in this server." });
        return;
    }

    if (subcommand === "test") {
        const channelId = birthdayStore.getGuild(interaction.guildId).channelId;
        if (!channelId) {
            await interaction.reply({ content: "No birthday announcement channel is configured." });
            return;
        }
        const target = interaction.options.getUser("user", true);
        await interaction.deferReply();
        try {
            const channel = await prepareBirthdayChannel(client, interaction.guildId, channelId);
            await sendBirthdayMessage(channel, target.id);
            await interaction.editReply({ content: `Birthday test sent in <#${channelId}>.` });
        } catch (error) {
            console.error("Birthday test failed:", error);
            await interaction.editReply({ content: "Could not send the birthday test to the configured channel." });
        }
        return;
    }

    if (subcommand === "channel") {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
            await interaction.reply({ content: "Manage Server permission is required.", ephemeral: true });
            return;
        }
        const channel = interaction.options.getChannel("channel", true);
        const guild = interaction.guild ?? await client.guilds.fetch(interaction.guildId);
        const botMember = await guild.members.fetchMe();
        const permissions = channel.permissionsFor(botMember);
        const isThread = channel.isThread?.() ?? false;
        const sendPermission = isThread ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages;
        if (!permissions?.has([PermissionFlagsBits.ViewChannel, sendPermission, PermissionFlagsBits.MentionEveryone])) {
            const sendName = isThread ? "Send Messages in Threads" : "Send Messages";
            await interaction.reply({ content: `I need View Channel, ${sendName}, and Mention Everyone permissions there.`, ephemeral: true });
            return;
        }
        if (isThread && channel.locked && !permissions.has(PermissionFlagsBits.ManageThreads)) {
            await interaction.reply({ content: "I need Manage Threads permission to reopen this locked thread for birthdays.", ephemeral: true });
            return;
        }
        if (isThread && channel.archived && !channel.unarchivable) {
            await interaction.reply({ content: "I cannot reopen this archived thread for birthday announcements.", ephemeral: true });
            return;
        }
        if (channel.type === ChannelType.PrivateThread && !channel.joined && !channel.joinable) {
            await interaction.reply({ content: "Add me to this private thread before choosing it.", ephemeral: true });
            return;
        }
        birthdayStore.setChannel(interaction.guildId, channel.id);
        await interaction.reply({ content: `Birthday announcements will go to <#${channel.id}>.` });
        return;
    }

    const day = interaction.options.getInteger("day", true);
    const month = interaction.options.getInteger("month", true);
    if (!isValidBirthday(month, day)) {
        await interaction.reply({ content: "That day does not exist in that month.", ephemeral: true });
        return;
    }
    const target = interaction.options.getUser("user") ?? interaction.user;
    if (target.bot) {
        await interaction.reply({ content: "Bot accounts cannot have birthday announcements.", ephemeral: true });
        return;
    }
    if (target.id === interaction.user.id) {
        birthdayStore.setBirthday(interaction.guildId, target.id, month, day);
        await interaction.reply({ content: `Your birthday is set to ${day}/${month}.` });
        return;
    }

    const embed = new EmbedBuilder()
        .setTitle("Birthday confirmation")
        .setDescription(`${interaction.user} proposed ${day}/${month} as your birthday. Confirm or deny this date within seven days.`);
    await interaction.reply({
        content: `<@${target.id}>`,
        embeds: [embed],
        components: [proposalButtons(interaction.guildId, target.id, month, day)],
        allowedMentions: { users: [target.id] },
    });
}

export async function handleButton(interaction, birthdayStore = store) {
    const [prefix, action, guildId, targetId, monthText, dayText, createdText] = interaction.customId.split(":");
    if (action === "list" || action === "upcoming") {
        const page = Number(targetId);
        if (prefix !== "birthday" || !/^\d+$/.test(guildId ?? "") ||
            !/^\d+$/.test(targetId ?? "") || !Number.isSafeInteger(page) ||
            interaction.guildId !== guildId) {
            await interaction.reply({ content: "This birthday list is invalid.", ephemeral: true });
            return;
        }
        const users = birthdayStore.getGuild(guildId).users;
        const message = action === "list"
            ? birthdayListMessage(guildId, users, page)
            : birthdayUpcomingMessage(guildId, users, page, interaction.createdAt ?? new Date());
        await interaction.update(message);
        return;
    }
    const month = Number(monthText);
    const day = Number(dayText);
    const createdAt = Number(createdText);
    if (prefix !== "birthday" || !["confirm", "deny"].includes(action) ||
        !/^\d+$/.test(guildId ?? "") || !/^\d+$/.test(targetId ?? "") ||
        !isValidBirthday(month, day) || !Number.isSafeInteger(createdAt)) {
        await interaction.reply({ content: "This birthday proposal is invalid.", ephemeral: true });
        return;
    }
    if (interaction.guildId !== guildId || interaction.user.id !== targetId) {
        await interaction.reply({ content: "Only the proposed user can decide this birthday.", ephemeral: true });
        return;
    }
    if (createdAt > Date.now() || Date.now() - createdAt > PROPOSAL_LIFETIME_MS) {
        await interaction.update({ content: `<@${targetId}> This birthday proposal expired.`, embeds: [], components: [], allowedMentions: { parse: [] } });
        return;
    }
    if (action === "confirm") {
        birthdayStore.setBirthday(guildId, targetId, month, day);
        await interaction.update({ content: `<@${targetId}> confirmed ${day}/${month}.`, embeds: [], components: [], allowedMentions: { parse: [] } });
    } else {
        await interaction.update({ content: `<@${targetId}> denied ${day}/${month}.`, embeds: [], components: [], allowedMentions: { parse: [] } });
    }
}
