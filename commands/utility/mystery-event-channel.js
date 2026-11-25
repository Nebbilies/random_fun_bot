import {
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import { setMysteryEventChannel } from "../../lib/mysteryCoordinator.js";

export const data = new SlashCommandBuilder()
  .setName("mystery-event-channel")
  .setDescription(
    "Set the mystery event channel, or clear it to use the roll channel",
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addChannelOption((option) =>
    option
      .setName("channel")
      .setDescription("Guild text channel for mystery events; omit to clear")
      .addChannelTypes(ChannelType.GuildText),
  );

export async function execute(client, interaction) {
  if (
    !interaction.guildId ||
    !interaction.guild ||
    !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
  ) {
    await interaction.reply({
      content: "Administrator permission is required.",
      ephemeral: true,
    });
    return;
  }

  const channel = interaction.options.getChannel("channel");
  if (!channel) {
    setMysteryEventChannel(client.catalogDb, interaction.guildId, null);
    await interaction.reply({
      content: "Mystery events now use the channel where each roll starts.",
      ephemeral: true,
    });
    return;
  }

  if (
    channel.guildId !== interaction.guildId ||
    channel.type !== ChannelType.GuildText
  ) {
    await interaction.reply({
      content: "Choose a text channel in this server.",
      ephemeral: true,
    });
    return;
  }

  const botMember = await interaction.guild.members.fetchMe();
  const permissions = channel.permissionsFor(botMember);
  if (
    !permissions?.has([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks,
      PermissionFlagsBits.AttachFiles,
      PermissionFlagsBits.AddReactions,
    ])
  ) {
    await interaction.reply({
      content:
        "I need View Channel, Send Messages, Embed Links, Attach Files, and Add Reactions there.",
      ephemeral: true,
    });
    return;
  }

  setMysteryEventChannel(client.catalogDb, interaction.guildId, channel.id);
  await interaction.reply({
    content: `Mystery events now appear in ${channel}.`,
    ephemeral: true,
  });
}
