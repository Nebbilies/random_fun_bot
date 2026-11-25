import { PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { setGuildPrefix } from "../../lib/guildPrefix.js";

export const data = new SlashCommandBuilder()
  .setName("prefix")
  .setDescription("Change the server text-command prefix")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addStringOption((option) =>
    option
      .setName("value")
      .setDescription("New prefix, such as !")
      .setRequired(true)
      .setMinLength(1)
      .setMaxLength(5),
  );

export async function execute(client, interaction) {
  if (
    !interaction.guildId ||
    !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
  ) {
    await interaction.reply({
      content: "Manage Server permission is required.",
      ephemeral: true,
    });
    return;
  }
  const prefix = interaction.options.getString("value", true);
  try {
    setGuildPrefix(client.catalogDb, interaction.guildId, prefix);
  } catch (error) {
    if (error.message !== "Invalid prefix") throw error;
    await interaction.reply({
      content: "Use 1–5 letters, numbers, or common symbols, with no spaces.",
      ephemeral: true,
    });
    return;
  }
  await interaction.reply({
    content: `Text commands now use \`${prefix}\` in this server.`,
    ephemeral: true,
  });
}
