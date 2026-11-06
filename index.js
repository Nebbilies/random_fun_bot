import { readdirSync, readFileSync, writeFileSync } from "fs";
import { Client, Events, Collection, GatewayIntentBits, Partials, ButtonBuilder, ButtonStyle, ComponentType, REST, Routes } from "discord.js";
import commandCooldown from "discord-command-cooldown";
import config from "./config.js";
import checkTimeouts from "./lib/checkTimeouts.js";
import {sendLandmine} from "./commands/utils/send-landmine.js";
import { TranslationServiceClient } from "@google-cloud/translate";
import {landmineRuntime} from "./lib/landmineRuntime.js";
import {BirthdayStore} from "./lib/birthdays.js";
import {startBirthdayScheduler} from "./lib/birthdayScheduler.js";
import {openCatalog} from "./lib/catalogDb.js";
import {getGuildPrefix} from "./lib/guildPrefix.js";
import {createCatalogCache} from "./lib/catalogCache.js";
import {isCatalogDraining, isNewGameActionCommand} from './lib/catalogMaintenance.js';
import {assertCatalogRuntimeRestartReady} from './lib/catalogRuntimeRecovery.js';
import {createCharacterImagePicker} from "./lib/characterImages.js";
import {onRollReaction, onRollReport, recoverRollRuntime, recoverForcedEscapes, recoverOpenEscapes} from "./lib/characterRollRuntime.js";
import {recoverPendingRollDeliveries} from './lib/rollDelivery.js';
import {onMysteryAnswer, onMysteryButton, cancelMysteryRuntime, recoverMysteryRuntime} from "./lib/mysteryRuntime.js";
import {onTradeAnswer} from "./lib/tradeRuntime.js";
import {onVaultInteraction, recoverVaultRewards, recoverVaultSessions} from "./lib/vaultRuntime.js";
import {onItemActionInteraction, recoverItemActionRuntime} from "./lib/itemActionRuntime.js";
import {onInventoryButton} from "./commands/inv.js";
import {cleanupExpiredItems} from './lib/itemExpiryCleanup.js';
import {recoverBinocularsUses} from './lib/binocularsUse.js';
import {recoverSelectedAffectionRewards} from './lib/affectionRewards.js';
import {parseFranchiseCommand} from "./lib/franchiseModifiers.js";
import {parseTopCommand} from "./lib/topModifiers.js";

const { CommandCooldown, msToMinutes } = commandCooldown;

// Create a new client instance
const intents = [ GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessageReactions ];

const client = new Client({ intents, partials: [Partials.Message, Partials.Channel, Partials.Reaction] });
client.cooldowns = new Collection();
client.catalogDb = openCatalog();
// Final-schema startup must not silently cancel paid actions or guess recovery.
// Run before handlers, timers, recovery writes, or Discord login are enabled.
if (client.catalogDb.prepare('PRAGMA user_version').get().user_version === 12) {
    assertCatalogRuntimeRestartReady(client.catalogDb);
}
const catalogCache = createCatalogCache(client.catalogDb);

export const yoshiko = {
    client: client,
    config,
    cooldowns: client.cooldowns,
    catalogDb: client.catalogDb,
    get catalogSnapshot() { return catalogCache.get(); },
    get characterIndex() { return catalogCache.get().characterIndex; },
    get franchiseIndex() { return catalogCache.get().franchiseIndex; },
    imagePicker: createCharacterImagePicker(),
    vaultEnabled: process.env.VAULT_ROLLS_DISABLED !== '1',
};
cancelMysteryRuntime(client.catalogDb);
recoverRollRuntime(client.catalogDb);
let gameRuntimeReady = false;

client.on(Events.MessageReactionAdd, (reaction, user) => {
    if (!gameRuntimeReady) return;
    onRollReaction(yoshiko, reaction, user).catch((error) => console.error('Roll reaction failed:', error));
});

// const chooserandomCooldown = new CommandCooldown("chooserandom", 15 * 1000);
// const lixiCooldown = new CommandCooldown("lixi", 15 * 1000);
// yoshiko.cooldowns.push(chooserandomCooldown);
// yoshiko.cooldowns.push(lixiCooldown);

// Code tu duoi ready tro di
yoshiko.client.once(Events.ClientReady, async (c) => {
    yoshiko.client.user.setActivity("Se hoat dong khi thay 727");
    console.log("dmLam");
    recoverBinocularsUses(yoshiko.catalogDb);
    await recoverItemActionRuntime(yoshiko.catalogDb, yoshiko.client);
    await recoverPendingRollDeliveries(yoshiko.catalogDb, yoshiko.client);
    await recoverForcedEscapes(yoshiko.catalogDb, yoshiko.client);
    await recoverOpenEscapes(yoshiko.catalogDb, yoshiko.client);
    // Mystery recovery acknowledges the character reveal before direct Chit
    // rewards may publish; vault recovery also enforces that durable gate.
    await recoverMysteryRuntime({ db: yoshiko.catalogDb, client: yoshiko.client, imagePicker: yoshiko.imagePicker });
    await recoverVaultSessions(yoshiko.catalogDb, yoshiko.client);
    recoverSelectedAffectionRewards(yoshiko.catalogDb);
    await recoverVaultRewards(yoshiko.catalogDb, yoshiko.client);
    cleanupExpiredItems(yoshiko.catalogDb);
    catalogCache.get(); // Prepare search data before accepting the first game command.
    gameRuntimeReady = true;
    console.log('Character game ready.');
    let vaultRecoveryRunning = false;
    const vaultRecovery = setInterval(async () => {
        if (vaultRecoveryRunning) return;
        vaultRecoveryRunning = true;
        try {
            await recoverPendingRollDeliveries(yoshiko.catalogDb, yoshiko.client);
            await recoverForcedEscapes(yoshiko.catalogDb, yoshiko.client);
            await recoverOpenEscapes(yoshiko.catalogDb, yoshiko.client);
            // Include terminal mysteries with an outstanding compensated reveal.
            await recoverMysteryRuntime({ db: yoshiko.catalogDb, client: yoshiko.client, imagePicker: yoshiko.imagePicker });
            await recoverVaultSessions(yoshiko.catalogDb, yoshiko.client);
            recoverSelectedAffectionRewards(yoshiko.catalogDb);
            await recoverVaultRewards(yoshiko.catalogDb, yoshiko.client);
            cleanupExpiredItems(yoshiko.catalogDb);
        }
        catch (error) { console.error('Vault recovery failed:', error); }
        finally { vaultRecoveryRunning = false; }
    }, 15_000);
    vaultRecovery.unref();
    startBirthdayScheduler(yoshiko.client, new BirthdayStore());

    //while (setRun === "1") {
        const channel = await yoshiko.client.channels.fetch(yoshiko.config.channelId);
        const vc = yoshiko.client.channels.cache.get("1058299700006109280")
        //const pingChannel = "1284763165116076094"
        let userId = readFileSync("./data/user_id.txt", "utf-8").trim();
        let randomTimes = 0;

        //Read map from file
        let memberCounterMap = new Map(JSON.parse(readFileSync("./data/counter.txt", "utf-8")));
        const randomInterval = 100;
        setInterval(() => {
            //Check for run operation code
            const setRun = readFileSync('./data/set_run.txt', 'utf-8');
            // Check for minimum number of members in VC
            const minimumMembers = parseInt(readFileSync('./data/set_minimum_members.txt', 'utf-8'));

            if (setRun === "1") {
                //Get list of members in voice channel, excluding the bot
                let vcMembersId = vc.members.map(member => member.id === "610040267755749404" ? null : member.id);
                //Delete null in array
                vcMembersId.forEach((member) => {
                    if (member === null) {
                        vcMembersId.splice(vcMembersId.indexOf(member), 1);
                    }
                });
                //Check if VC is empty
                if (vcMembersId.length < minimumMembers) { // Bot is the only one in VC
                    writeFileSync('./data/set_run.txt', "0");
                    channel.send(`⏹️ Stopped due to VC has less than **${minimumMembers}** members.`);
                }
                let numOfMembers = vcMembersId.length;

                //Random algorithm
                const random = Math.floor(Math.random() * (1000 + 1));
                randomTimes++;

                /*if (setRun === 0) {
                    counter = 0
                } else {
                    counter = parseInt(readFileSync("./data/counter.txt", "utf-8"));
                }*/
                //Finding 727
                if (random === 727) {
                    //Get random member in vc, excluding the bot
                    let randomMember = vcMembersId[Math.floor(Math.random() * numOfMembers)];
                    //Get random person in vc
                    if (memberCounterMap.has(randomMember)) {
                        memberCounterMap.set(randomMember, memberCounterMap.get(randomMember) + 1);
                    } else {
                        memberCounterMap.set(randomMember, 1);
                    }
                    userId = randomMember;
                    const embed = {
                        color: 0xffff7d,
                        description: `<@${userId}> da bi ping ${memberCounterMap.get(randomMember)} lan\n727 da duoc tim thay sau ${randomTimes} lan (${(randomTimes / 10).toFixed(2)} giay)`,
                    };

                    channel.send({content: `<@${userId}>`, embeds: [embed]});
                    // Write current member counter map to counter.txt
                    writeFileSync("./data/counter.txt", JSON.stringify(Array.from(memberCounterMap.entries())));
                    randomTimes = 0;

            }


            }
        }, randomInterval);
    //}
    //Update daily stats for every user each 5 minutes
    //checkTimeouts(300);
});


let activeLandmines = new Map();
const LANDMINE_LENGTH = 60 * 1000 * 5;
const LANDMINE_CHANNELS = ["1058299699460833301"];
let currentMessageCount = 0;

yoshiko.client.on(Events.MessageCreate, async (message) => {
    if (!gameRuntimeReady) return;
        if (message.author.bot) {
            return;
        }
        if (!message.guild) {
            return;
        }

        const prefix = getGuildPrefix(client.catalogDb, message.guild.id, config.prefix);
        const args = message.content.trim().split(/ +/g);
        const gameCommand = args[0].startsWith(prefix) ? args[0].slice(prefix.length).toLowerCase() : '';
        const isMarriage = /^(mm|mymarry)([a-z]*)$/.test(gameCommand);
        const franchiseModifiers = parseFranchiseCommand(gameCommand);
        const topModifiers = parseTopCommand(gameCommand);
        if (isMarriage || franchiseModifiers || topModifiers || ['rewards', 'affection', 'aff', 'soulmate', 'sm', 'help', 'char', 'im', 'ima', 'imar', 'divorce', 'w', 'h', 'mu', 'ru', 'daily', 'inv', 'itemlist', 'il', 'use', 'me', 'trade', 'give', 'cancel', 'top', 'topo', 'ts', 'tsl', 'topserv', 'wish', 'wl', 'wishlist'].includes(gameCommand)) {
            args[0] = gameCommand;
            if (isCatalogDraining(client.catalogDb) && isNewGameActionCommand(gameCommand)) {
                await message.reply('Character game is draining for maintenance. Existing actions may finish; new actions are paused.').catch(console.error);
                return;
            }
            try {
                const commandModule = isMarriage ? './commands/mm.js'
                    : franchiseModifiers ? './commands/ima.js'
                    : topModifiers ? './commands/top.js'
                    : ['affection','aff'].includes(gameCommand) ? './commands/affection.js'
                    : ['soulmate','sm'].includes(gameCommand) ? './commands/soulmate.js' : `./commands/${gameCommand}.js`;
                const command = await import(commandModule);
                await command.run({ yoshiko, message, args, prefix });
            } catch (error) {
                console.error('Character game command failed:', error);
                await message.reply('Character game command failed. Please try again later.').catch(console.error);
            }
            return;
        }

        if (!message.content.startsWith(prefix)) {
            try {
                if (await onMysteryAnswer(client.catalogDb, message)) return;
            } catch (error) {
                console.error('Mystery answer failed:', error);
            }
            try {
                if (await onTradeAnswer(client.catalogDb, message)) return;
            } catch (error) {
                console.error('Trade answer failed:', error);
            }
        }

        const now = Date.now();
        const userId = message.author.id;

        const expiresAt = activeLandmines.get(userId);

        if (activeLandmines.has(userId)) {
            if (!LANDMINE_CHANNELS.includes(message.channel.id)) {
                return;
            }
            if (expiresAt) {
                if (expiresAt < now) {
                    activeLandmines.delete(userId);
                } else {
                    await sendLandmine(message);
                    return;
                }
            }
        }

        currentMessageCount++;
        if (landmineRuntime.pity > 0 && currentMessageCount >= landmineRuntime.pity) {
            currentMessageCount = 0;
            activeLandmines.set(userId, now + LANDMINE_LENGTH);

            await message.channel.send({
                content: `thang ngu <@${userId}> da dap min trong 5 phut`,
            });

            await sendLandmine(message);
            return;
        }

    if (Math.random() < landmineRuntime.chance) {
        activeLandmines.set(userId, now + LANDMINE_LENGTH);

        await message.channel.send({
            content: `thang ngu <@${userId}> da dap min trong 5 phut`,
        });

        await sendLandmine(message);
        return;
    }

        if (!args[0].startsWith(prefix)) {
            return;
        } // W!CHOOSERANDOM A

        args[0] = args[0].slice(prefix.length).toLowerCase();
        const ctx = { yoshiko, message, args, prefix };

        const commands = readdirSync("./commands").map((command) => command.split(".").shift());
        if (!commands.includes(args[0])) {
            return;
        }

        import(`./commands/${args[0]}.js`).then((command) => {
            command.run(ctx);
        });
    },
);

yoshiko.commands = new Collection();
const commandFiles = readdirSync("./commands/utility").filter((file) => file.endsWith(".js"));
for (const file of commandFiles) {
    const command = await import(`./commands/utility/${file}`);
    if ('data' in command && 'execute' in command) {
        yoshiko.commands.set(command.data.name, command);
    } else {
        console.error(`Command ${file} is missing data or execute method`);
    }
}

yoshiko.client.on(Events.InteractionCreate, async (interaction) => {
    if (!gameRuntimeReady) return;
    // Collector-only dialogs are process-local. The collector handles live ones;
    // after restart/cutover provide an explicit expired response, never replay.
    if (/^(?:char|wish|divorce|xfer|affection|soulmate|rewards|rewardreplace):/.test(interaction.customId ?? '')) {
        const timer = setTimeout(() => {
            if (!interaction.replied && !interaction.deferred) interaction.reply({ content: 'This character-game dialog expired. Run the command again.', ephemeral: true }).catch(console.error);
        }, 500);
        timer.unref();
        return;
    }
    if (interaction.isButton() && interaction.customId.startsWith('mystery:')) {
        try {
            await onMysteryButton(yoshiko.catalogDb, interaction);
        } catch (error) {
            console.error('Mystery button failed:', error);
            if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: 'Mystery choice failed. Please try again later.', ephemeral: true }).catch(console.error);
        }
        return;
    }
    if (interaction.customId?.startsWith('item:')) {
        try {
            await onItemActionInteraction(yoshiko.catalogDb, interaction);
        } catch (error) {
            console.error('Item action failed:', error);
            if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: 'Item action failed. Please retry.', ephemeral: true }).catch(console.error);
        }
        return;
    }
    if (interaction.customId?.startsWith('vault:')) {
        try {
            await onVaultInteraction(yoshiko.catalogDb, interaction);
        } catch (error) {
            console.error('Vault button failed:', error);
            if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: 'Vault choice failed. Please try again later.', ephemeral: true }).catch(console.error);
        }
        return;
    }
    if (interaction.customId?.startsWith('inv:use:')) {
        try {
            await onInventoryButton(yoshiko.catalogDb, interaction);
        } catch (error) {
            console.error('Inventory button failed:', error);
            if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: 'Inventory action failed. Please try again later.', ephemeral: true }).catch(console.error);
        }
        return;
    }
    if (interaction.isButton() && ['roll:report', 'roll:gender-report'].includes(interaction.customId)) {
        try {
            await onRollReport(yoshiko.catalogDb, interaction);
        } catch (error) {
            console.error('Roll report failed:', error);
            if (!interaction.replied) await interaction.reply({ content: 'Report failed. Please try again later.', ephemeral: true }).catch(console.error);
        }
        return;
    }
    const birthdayButton = interaction.isButton() && interaction.customId.startsWith("birthday:");
    if (!birthdayButton && !interaction.isChatInputCommand()) return;
    const command = yoshiko.commands.get(birthdayButton ? "birthday" : interaction.commandName);
    if (!command) return;

    try {
        if (birthdayButton) {
            await command.handleButton(interaction);
        } else {
            await command.execute(yoshiko.client, interaction);
        }
    } catch (error) {
        console.error(error);
        if (interaction.replied || interaction.deferred) {
            await interaction.followUp({ content: 'There was an error while executing this command!', ephemeral: true });
        } else {
            await interaction.reply({ content: 'There was an error while executing this command!', ephemeral: true });
        }
    }
});

// Construct and prepare an instance of the REST module
const rest = new REST().setToken(config.token);

// Register utility commands in every server the bot serves.
const utilityCommandBody = yoshiko.commands.map((command) => command.data.toJSON());
async function registerUtilityCommands(guildId) {
    try {
        await rest.put(
            Routes.applicationGuildCommands(config.clientId, guildId),
            { body: utilityCommandBody },
        );
        console.log(`Reloaded application (/) commands for guild ${guildId}.`);
    } catch (error) {
        console.error(`Could not register application (/) commands for guild ${guildId}:`, error);
    }
}

yoshiko.client.once(Events.ClientReady, async (readyClient) => {
    await Promise.all([...readyClient.guilds.cache.keys()].map(registerUtilityCommands));
});
yoshiko.client.on(Events.GuildCreate, (guild) => {
    void registerUtilityCommands(guild.id);
});
yoshiko.client.login(config.token).catch((err) => console.error(err));

//FINISHED: DEPLOYED FIRST SLASH COMMAND, TODO: DEPLOY LOGIN SLASH COMMAND WITH OPTIONS, HANDLING WRONG TOKENS AND UIDS.
