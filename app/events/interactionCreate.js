import { onRollReport } from "../../lib/characterRollRuntime.js";
import { onMysteryButton } from "../../lib/mysteryRuntime.js";
import { onVaultInteraction } from "../../lib/vaultRuntime.js";
import { onItemActionInteraction } from "../../lib/itemActionRuntime.js";
import { onInventoryButton } from "../../commands/inv.js";
import { claimedCollectorInteractions } from './collectorInteractions.js';
/** @param {any} options */
export function createInteractionHandler({ yoshiko, isReady, schedule = setTimeout }) {
    return async function onInteraction(interaction) {
        if (!isReady())
            return;
        // Retired inbox controls must never settle rewards or suggest rerunning the removed command.
        if (/^(?:rewards|rewardreplace):/.test(interaction.customId ?? '')) {
            await interaction.reply({ content: 'The pending rewards inbox has been removed. Use the original reward card to claim or manage this reward.', ephemeral: true }).catch(console.error);
            return;
        }
        // Collector-only dialogs are process-local. The collector handles live ones;
        // after restart/cutover provide an explicit expired response, never replay.
        if (/^(?:char|wish|divorce|xfer|affection|soulmate|profile):/.test(interaction.customId ?? '')) {
            const timer = schedule(() => {
                if (!claimedCollectorInteractions.has(interaction) && !interaction.replied && !interaction.deferred)
                    interaction.reply({ content: 'This character-game dialog expired. Run the command again.', ephemeral: true }).catch(console.error);
            }, 500);
            timer.unref();
            return;
        }
        if (interaction.isButton() && interaction.customId.startsWith('mystery:')) {
            try {
                await onMysteryButton(yoshiko.catalogDb, interaction);
            }
            catch (error) {
                console.error('Mystery button failed:', error);
                if (!interaction.replied && !interaction.deferred)
                    await interaction.reply({ content: 'Mystery choice failed. Please try again later.', ephemeral: true }).catch(console.error);
            }
            return;
        }
        if (interaction.customId?.startsWith('item:')) {
            try {
                await onItemActionInteraction(yoshiko.catalogDb, interaction);
            }
            catch (error) {
                console.error('Item action failed:', error);
                if (!interaction.replied && !interaction.deferred)
                    await interaction.reply({ content: 'Item action failed. Please retry.', ephemeral: true }).catch(console.error);
            }
            return;
        }
        if (interaction.customId?.startsWith('vault:')) {
            try {
                await onVaultInteraction(yoshiko.catalogDb, interaction);
            }
            catch (error) {
                console.error('Vault button failed:', error);
                if (!interaction.replied && !interaction.deferred)
                    await interaction.reply({ content: 'Vault choice failed. Please try again later.', ephemeral: true }).catch(console.error);
            }
            return;
        }
        if (interaction.customId?.startsWith('inv:use:')) {
            try {
                await onInventoryButton(yoshiko.catalogDb, interaction);
            }
            catch (error) {
                console.error('Inventory button failed:', error);
                if (!interaction.replied && !interaction.deferred)
                    await interaction.reply({ content: 'Inventory action failed. Please try again later.', ephemeral: true }).catch(console.error);
            }
            return;
        }
        if (interaction.isButton() && ['roll:report', 'roll:gender-report'].includes(interaction.customId)) {
            try {
                await onRollReport(yoshiko.catalogDb, interaction);
            }
            catch (error) {
                console.error('Roll report failed:', error);
                if (!interaction.replied)
                    await interaction.reply({ content: 'Report failed. Please try again later.', ephemeral: true }).catch(console.error);
            }
            return;
        }
        const birthdayButton = interaction.isButton() && interaction.customId.startsWith("birthday:");
        if (!birthdayButton && !interaction.isChatInputCommand())
            return;
        const command = yoshiko.commands.get(birthdayButton ? "birthday" : interaction.commandName);
        if (!command)
            return;
        try {
            if (birthdayButton) {
                await command.handleButton(interaction);
            }
            else {
                await command.execute(yoshiko.client, interaction);
            }
        }
        catch (error) {
            console.error(error);
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp({ content: 'There was an error while executing this command!', ephemeral: true });
            }
            else {
                await interaction.reply({ content: 'There was an error while executing this command!', ephemeral: true });
            }
        }
    };
}
