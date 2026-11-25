import { SlashCommandBuilder } from "discord.js";
import { astraYaoEmbed, getTopAstraYaoImage } from "../utils/astra-yao-test.js";

export const data = new SlashCommandBuilder()
  .setName("astra-url-test")
  .setDescription("Test a direct Danbooru image URL in an embed");

export async function execute(client, interaction) {
  await interaction.deferReply();
  try {
    const { post, imageUrl } = await getTopAstraYaoImage();
    await interaction.editReply({
      embeds: [astraYaoEmbed(post, imageUrl, "Direct Danbooru image URL")],
    });
  } catch (error) {
    console.error("Astra URL test failed:", error);
    await interaction.editReply(`Direct URL test failed: ${error.message}`);
  }
}
