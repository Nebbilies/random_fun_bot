import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { setMaxRolls } from '../../features/rolls/rollAllowanceService.js';

export const data = new SlashCommandBuilder()
  .setName('set-roll')
  .setDescription('Set the base maximum hourly rolls per user in this server')
  .setDMPermission(false)
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addIntegerOption((option) => option
    .setName('amount')
    .setDescription('Maximum rolls per user per hour (default: 7)')
    .setRequired(true)
    .setMinValue(1)
    .setMaxValue(Number.MAX_SAFE_INTEGER));

export async function execute(client, interaction) {
  if (!interaction.guildId || !interaction.guild
    || !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: 'Administrator permission is required.', ephemeral: true });
    return;
  }
  const amount = interaction.options.getInteger('amount', true);
  if (!Number.isSafeInteger(amount) || amount < 1) {
    await interaction.reply({ content: 'Choose a positive whole number of rolls.', ephemeral: true });
    return;
  }
  setMaxRolls(client.catalogDb, interaction.guildId, amount);
  await interaction.reply({
    content: `Base maximum set to ${amount} rolls per user per hour in this server. Applies immediately; rolls already spent this hour still count. Daily refills now restore ${amount} rolls.`,
    ephemeral: true,
  });
}
