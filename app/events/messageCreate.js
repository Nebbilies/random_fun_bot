import { getGuildPrefix } from "../../lib/guildPrefix.js";
import { isCatalogDraining, isNewGameActionCommand } from '../../lib/catalogMaintenance.js';
import { onMysteryAnswer } from "../../lib/mysteryRuntime.js";
import { onTradeAnswer } from "../../lib/tradeRuntime.js";
import { resolveGameCommand, loadPrefixCommand, hasLegacyCommand } from '../commandRegistry.js';
/** @param {any} options */
export function createMessageHandler({ yoshiko, isReady, handleLandmine }) {
    const config = yoshiko.config;
    return async function onMessage(message) {
        if (!isReady())
            return;
        if (message.author.bot) {
            return;
        }
        if (!message.guild) {
            return;
        }
        const prefix = getGuildPrefix(yoshiko.catalogDb, message.guild.id, config.prefix);
        const args = message.content.trim().split(/ +/g);
        const gameCommand = args[0].startsWith(prefix) ? args[0].slice(prefix.length).toLowerCase() : '';
        const handler = resolveGameCommand(gameCommand);
        if (handler) {
            args[0] = gameCommand;
            if (isCatalogDraining(yoshiko.catalogDb) && isNewGameActionCommand(gameCommand)) {
                await message.reply('Character game is draining for maintenance. Existing actions may finish; new actions are paused.').catch(console.error);
                return;
            }
            try {
                const command = await loadPrefixCommand(handler);
                await command.run({ yoshiko, message, args, prefix });
            }
            catch (error) {
                console.error('Character game command failed:', error);
                await message.reply('Character game command failed. Please try again later.').catch(console.error);
            }
            return;
        }
        if (!message.content.startsWith(prefix)) {
            try {
                if (await onMysteryAnswer(yoshiko.catalogDb, message))
                    return;
            }
            catch (error) {
                console.error('Mystery answer failed:', error);
            }
            try {
                if (await onTradeAnswer(yoshiko.catalogDb, message))
                    return;
            }
            catch (error) {
                console.error('Trade answer failed:', error);
            }
        }
        if (await handleLandmine(message))
            return;
        if (!args[0].startsWith(prefix)) {
            return;
        } // W!CHOOSERANDOM A
        args[0] = args[0].slice(prefix.length).toLowerCase();
        const ctx = { yoshiko, message, args, prefix };
        if (!hasLegacyCommand(args[0]))
            return;
        loadPrefixCommand(args[0]).then(command => { command.run(ctx); });
    };
}
