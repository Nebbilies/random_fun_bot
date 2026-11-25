import { AttachmentBuilder, SlashCommandBuilder } from "discord.js";
import {
  astraYaoEmbed,
  downloadAstraYaoImage,
  getTopAstraYaoImage,
} from "../utils/astra-yao-test.js";

export const data = new SlashCommandBuilder()
  .setName("astra-upload-test")
  .setDescription("Test an uploaded Danbooru image in an embed");

export async function execute(client, interaction) {
  await interaction.deferReply();
  try {
    const { post, imageUrl } = await getTopAstraYaoImage();
    const { buffer, name } = await downloadAstraYaoImage(post, imageUrl);
    await interaction.editReply({
      embeds: [
        astraYaoEmbed(post, `attachment://${name}`, "Image uploaded by bot"),
      ],
      files: [new AttachmentBuilder(buffer, { name })],
    });
  } catch (error) {
    console.error("Astra upload test failed:", error);
    await interaction.editReply(`Upload test failed: ${error.message}`);
  }
}
