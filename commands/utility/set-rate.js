import {SlashCommandBuilder} from "discord.js";
import {writeFileSync, readFileSync} from "fs";
import {landmineRuntime} from "../../lib/landmineRuntime.js";

export const data = new SlashCommandBuilder()
    .setName('set-rate')
    .setDescription('Set ty le dap min')
    .addIntegerOption(option =>
        option.setName('rate')
            .setDescription('Ty le dap min moi (0-10%)')
            .setRequired(true),
);

export async function execute(interaction) {
    const newRate = interaction.options.getInteger('rate');
    if (newRate < 0 || newRate > 10) {
        await interaction.reply({content: 'suc vat ty le phai trong khoang 0-10%', ephemeral: true});
        return;
    }
    landmineRuntime.setRate(newRate);
    landmineRuntime.reload();
    await interaction.reply({content: `ty le dap min dang la **${newRate}%**`, ephemeral: false});
}