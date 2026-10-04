import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    EmbedBuilder,
    PermissionFlagsBits,
    SlashCommandBuilder,
} from "discord.js";
import { BirthdayStore, isValidBirthday } from "../../lib/birthdays.js";
import { prepareBirthdayChannel, sendBirthdayMessage } from "../../lib/birthdayScheduler.js";

const store = new BirthdayStore();
const PROPOSAL_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const TESTER_ID = "227447542911074304";

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

export async function execute(client, interaction, birthdayStore = store) {
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === "test" && interaction.user.id !== TESTER_ID) {
        await interaction.reply({ content: `YOU ARE NOT <@${TESTER_ID}>` });
        return;
    }
    if (!interaction.inGuild()) {
        await interaction.reply({ content: "Use this command in a server.", ephemeral: true });
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
