import { SlashCommandBuilder } from "discord.js";

export const data = new SlashCommandBuilder()
  .setName("lixi")
  .setDescription("Phát lộc đầu năm")
  .addIntegerOption((opt) =>
    opt
      .setName("amount")
      .setDescription("Số tiền bạn muốn lì xì. (Default: 1000)")
      .setRequired(false)
      .setMinValue(500),
  );

export async function execute(client, interaction) {
  const amount = interaction.options.getInteger("amount") || 1000;
  const COOLDOWN = 10 * 1000;
  if (client.cooldowns.has(interaction.user.id)) {
    const remainingTime = client.cooldowns.get(interaction.user.id);
    await interaction.reply({
      content: `Cooldown: **${remainingTime / 1000}s**`,
      ephemeral: true,
    });
    return;
  } else {
    client.cooldowns.set(interaction.user.id, COOLDOWN);
    setTimeout(() => client.cooldowns.delete(interaction.user.id), COOLDOWN);
  }

  const user = interaction.user;
  const members = interaction.guild.members.cache;
  const chooseUser = members
    .filter((member) => !member.user.bot && member.id !== user.id)
    .random().user;
  await interaction.reply({
    content: `<@${user.id}> đã lì xì **${amount}đ** cho <@${chooseUser.id}>`,
  });
}
