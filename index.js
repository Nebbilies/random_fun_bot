import { readdirSync, readFileSync, writeFileSync } from "fs";
import { Client, Events, Collection, GatewayIntentBits, ButtonBuilder, ActionRowBuilder, ButtonStyle, ComponentType, REST, Routes } from "discord.js";
import commandCooldown from "discord-command-cooldown";
import config from "./config.js";
import checkTimeouts from "./lib/checkTimeouts.js";

const { CommandCooldown, msToMinutes } = commandCooldown;

// Create a new client instance
const intents = [ GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildVoiceStates ];
export const yoshiko = {
    client: new Client({ intents }),
    config,
    cooldowns: [],
};

const chooserandomCooldown = new CommandCooldown("chooserandom", 15 * 1000);
const lixiCooldown = new CommandCooldown("lixi", 15 * 1000);
yoshiko.cooldowns.push(chooserandomCooldown);
yoshiko.cooldowns.push(lixiCooldown);

// Code tu duoi ready tro di
yoshiko.client.once(Events.ClientReady, async (c) => {
    yoshiko.client.user.setActivity("Se hoat dong khi thay 727");
    console.log("dmLam");

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
    //Update daily stats for every user each 2 minutes
    let dailies = JSON.parse(readFileSync('./data/user_dailies.txt', 'utf-8'));
    setInterval(() => {
        checkTimeouts(dailies, 120)
    }, 120000);
});


yoshiko.client.on(Events.MessageCreate, async (message) => {
        if (message.author.bot) {
            return;
        }

        const args = message.content.trim().split(/ +/g);
        if (!args[0].startsWith(config.prefix)) {
            return;
        } // W!CHOOSERANDOM A

        args[0] = args[0].slice(config.prefix.length).toLowerCase();
        const ctx = { yoshiko, message, args };

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
    const command = await import(`./commands/utility/${file}`);;
    if ('data' in command & 'execute' in command) {
        yoshiko.commands.set(command.data.name, command);
    } else {
        console.error(`Command ${file} is missing data or execute method`);
    }
}

yoshiko.client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const command = yoshiko.commands.get(interaction.commandName);
    if (!command) return;

    try {
        await command.execute(interaction);
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

// Register all commands
(async () => {
    try {
        console.log('Started refreshing application (/) commands.');

        await rest.put(
            Routes.applicationCommands(config.clientId),
            { body: yoshiko.commands.map((command) => command.data.toJSON()) },
        );

        console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error(error);
    }
})();
yoshiko.client.login(config.token).catch((err) => console.error(err));

//FINISHED: DEPLOYED FIRST SLASH COMMAND, TODO: DEPLOY LOGIN SLASH COMMAND WITH OPTIONS, HANDLING WRONG TOKENS AND UIDS.
