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
import {loadCharacterIndex} from "./lib/gameCharacterLookup.js";
import {createCharacterImagePicker} from "./lib/characterImages.js";
import {onRollReaction, onRollReport, recoverRollRuntime} from "./lib/characterRollRuntime.js";
import {onMysteryAnswer, onMysteryButton, cancelMysteryRuntime} from "./lib/mysteryRuntime.js";
import {onVaultInteraction} from "./lib/vaultRuntime.js";
import {onInventoryButton} from "./commands/inv.js";

const { CommandCooldown, msToMinutes } = commandCooldown;

// Create a new client instance
const intents = [ GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessageReactions ];

const client = new Client({ intents, partials: [Partials.Message, Partials.Channel, Partials.Reaction] });
client.cooldowns = new Collection();
client.catalogDb = openCatalog();

export const yoshiko = {
    client: client,
    config,
    cooldowns: client.cooldowns,
    catalogDb: client.catalogDb,
    characterIndex: loadCharacterIndex(client.catalogDb),
    imagePicker: createCharacterImagePicker(),
    vaultEnabled: process.env.VAULT_ROLLS_DISABLED !== '1',
};
cancelMysteryRuntime(client.catalogDb);
recoverRollRuntime(client.catalogDb);

client.on(Events.MessageReactionAdd, (reaction, user) => {
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
        if (message.author.bot) {
            return;
        }
        if (!message.guild) {
            return;
        }

        const prefix = getGuildPrefix(client.catalogDb, message.guild.id, config.prefix);
        const args = message.content.trim().split(/ +/g);
        const gameCommand = args[0].startsWith(prefix) ? args[0].slice(prefix.length).toLowerCase() : '';
        if (['char', 'im', 'ima', 'imar', 'divorce', 'mm', 'mymarry', 'mmr', 'w', 'h', 'mu', 'ru', 'daily', 'inv', 'use'].includes(gameCommand)) {
            args[0] = gameCommand;
            try {
                const command = await import(`./commands/${gameCommand}.js`);
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
    if (interaction.isButton() && interaction.customId.startsWith('mystery:')) {
        try {
            await onMysteryButton(yoshiko.catalogDb, interaction);
        } catch (error) {
            console.error('Mystery button failed:', error);
            if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: 'Mystery choice failed. Please try again later.', ephemeral: true }).catch(console.error);
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
    if (interaction.isButton() && interaction.customId === 'roll:report') {
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
