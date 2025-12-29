import {SlashCommandBuilder} from "discord.js";
import {writeFileSync, readFileSync} from "fs";
import {landmineRuntime} from "../../lib/landmineRuntime.js";

export const data = new SlashCommandBuilder()
    .setName('set-pity')
    .setDescription('Set so lan gui tin nhan de 1 thang ngu dap min')
    .addIntegerOption(option =>
        option.setName('pity')
            .setDescription('So lan gui tin nhan de 1 thang ngu dap min (0 = no pity)')
            .setRequired(true),
    );

export async function execute(interaction) {
    const newPity = interaction.options.getInteger('pity');
    if (newPity < 0) {
        await interaction.reply({content: 'pity phai lon hon hoac bang 0', ephemeral: true});
    }
    landmineRuntime.setPity(newPity);
    landmineRuntime.reload();
    await interaction.reply({content: `so lan gui tin nhan de 1 thang ngu dap min dang la **${newPity}**`, ephemeral: false});
}