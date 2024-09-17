import { readFileSync, writeFileSync } from "fs";
import { ButtonBuilder, ButtonStyle, ActionRowBuilder } from "discord.js";

class userDailies {
    constructor(id) {
        this.id = id;
        this.hsr = -1;
        this.ba = -1;
        this.zzz = -1;
        this.gi = -1;
        this.giTimeout = null;
        this.hsrTimeout = null;
        this.zzzTimeout = null;
        this.baTimeout = null;
    }
}

//Energy recharge rates (minutes) and energy cap
const baERR = 6; const baCAP = 240;
const giERR = 8; const giCAP = 200;
const hsrERR = 6; const hsrCAP = 240;
const zzzERR = 6; const zzzCAP = 240;


export const run = async (ctx) => {
    //Read dailies from file, check if file is empty, if yes, generate an array of userDailies objects
    let dailies = readFileSync('./data/user_dailies.txt', 'utf-8');
    if (dailies === '') {
        dailies = [];
    }
    else {
        dailies = JSON.parse(dailies);
    }

    //Check if message author exists in array, if not make new
    let userExist = false;
    let userIndex = -1;
    for (let i = 0; i < dailies.length; i++) {
        if (dailies[i].id === ctx.message.author.id) {
            userExist = true;
            userIndex = i;
            break;
        }
    }
    if (!userExist) {
        const newUser = new userDailies(ctx.message.author.id);
        dailies.push(newUser);
        userIndex = dailies.length - 1;
    }

    //Create buttons
    const giButton = new ButtonBuilder()
        .setCustomId('giButton')
        .setLabel('Genshin Impact')
        .setEmoji("<:gi:1285548706690764830>")
        .setStyle('Primary')

    const hsrButton = new ButtonBuilder()
        .setCustomId('hsrButton')
        .setEmoji('<:hsr:1285538992237969471>')
        .setLabel('Honkai: Star Rail')
        .setStyle('Primary')

    const zzzButton = new ButtonBuilder()
        .setCustomId('zzzButton')
        .setEmoji('<:zenless:1285539968487395338>')
        .setLabel('Zenless Zone Zero')
        .setStyle('Primary')

    const baButton = new ButtonBuilder()
        .setCustomId('baButton')
        .setEmoji('<:ba:1285539663620210739>')
        .setLabel('Blue Archive')
        .setStyle('Primary')

    //Layer buttons to rows
    const buttonRow1 = new ActionRowBuilder().addComponents(giButton, hsrButton);
    const buttonRow2 = new ActionRowBuilder().addComponents(zzzButton, baButton);
    //const reply = await ctx.message.reply({ content: 'test', components: [buttonRow1, buttonRow2]})

    //Add a filter, only allow the author to interact with the buttons
    const filter = (interaction) => interaction.user.id === ctx.message.author.id;

    //Create embed
    const embed = {
        title: "Your Daily Resets",
        color: 0xffff7d,
        description: `\n <:gi:1285548706690764830> **Genshin Impact**: ${dailies[userIndex].gi === -1 ? 'Not Set' : "<t:" + dailies[userIndex].gi + ">"} \n
        <:hsr:1285538992237969471> **Honkai: Star Rail**: ${dailies[userIndex].hsr === -1 ? 'Not Set' : "<t:" + dailies[userIndex].hsr + ">"} \n
        <:zenless:1285539968487395338> **Zenless Zone Zero**: ${dailies[userIndex].zzz === -1 ? 'Not Set' : "<t:" + dailies[userIndex].zzz + ">"} \n
        <:ba:1285539663620210739> **Blue Archive**: ${dailies[userIndex].ba === -1 ? 'Not Set' : "<t:" + dailies[userIndex].ba + ">"} \n \n
        `,
        footer: {text: "Set your dailies by choosing the buttons."},
    };
    const reply = await ctx.message.reply({ embeds: [embed], components: [buttonRow1, buttonRow2]});



    //Create a collector
    const buttonCollector = reply.createMessageComponentCollector({
        filter: filter,
        time: 15000,
    })
    //On button press
    buttonCollector.on('collect', async (interaction) => {
        let gameChosen;
        let gameCap;
        switch (interaction.customId) {
            case 'giButton':
                gameChosen = 'Genshin Impact';
                gameCap = giCAP;
                break;
            case 'hsrButton':
                gameChosen = 'Honkai: Star Rail';
                gameCap = hsrCAP;
                break;
            case 'zzzButton':
                gameChosen = 'Zenless Zone Zero';
                gameCap = zzzCAP;
                break;
            case 'baButton':
                gameChosen = 'Blue Archive';
                gameCap = baCAP;
                break;
        }
        await ctx.message.channel.send(`<@${ctx.message.author.id}> :thought_balloon: Input your current remaining energy for **${gameChosen}** (0-${gameCap - 1}):`);
        const messageCollector = ctx.message.channel.createMessageCollector({
            filter: m => m.author.id === ctx.message.author.id && !isNaN(parseInt(m.content)) && parseInt(m.content) >= 0 && parseInt(m.content) <= gameCap - 1,
            time: 30000,
            max: 1
        });
        messageCollector.on('collect', async (m) => {
            switch (interaction.customId) {
                case 'giButton':
                    dailies[userIndex].gi = Math.floor(m.createdTimestamp/1000) + ((giCAP - parseInt(m.content)) * giERR * 60);
                    ctx.message.channel.send(`:white_check_mark: Successfully set **${gameChosen}** daily reset time set to <t:${dailies[userIndex].gi}>.`);
                    //TODO: Ping to remind user 5 minutes before reset, reset timeout if user sets new time, timeoutid is game + userid
                    /*dailies[userIndex].giTimeout ? clearTimeout(dailies[userIndex].giTimeout) : null;
                    dailies[userIndex].giTimeout = setTimeout(() => {
                        ctx.message.channel.send(`<@${ctx.message.author.id}> :alarm_clock: **${gameChosen}** daily reset in 5 minutes!`);
                    }, (dailies[userIndex].gi - Math.floor(m.createdTimestamp/1000) - 300) * 1000);*/
                    break;
                case 'hsrButton':
                    dailies[userIndex].hsr = Math.floor(m.createdTimestamp/1000) + ((hsrCAP - parseInt(m.content)) * hsrERR * 60);
                    ctx.message.channel.send(`:white_check_mark: Successfully set **${gameChosen}** daily reset time set to <t:${dailies[userIndex].hsr}>.`);
                    //same as above
                    /*dailies[userIndex].hsrTimeout ? clearTimeout(dailies[userIndex].hsrTimeout) : null;
                    dailies[userIndex].hsrTimeout = setTimeout(() => {
                        ctx.message.channel.send(`<@${ctx.message.author.id}> :alarm_clock: **${gameChosen}** daily reset in 5 minutes!`);
                    }, (dailies[userIndex].hsr - Math.floor(m.createdTimestamp/1000) - 300) * 1000);*/
                    break;
                case 'zzzButton':
                    dailies[userIndex].zzz = Math.floor(m.createdTimestamp/1000) + ((zzzCAP - parseInt(m.content)) * zzzERR * 60);
                    ctx.message.channel.send(`:white_check_mark: Successfully set **${gameChosen}** daily reset time set to <t:${dailies[userIndex].zzz}>.`);
                    /*dailies[userIndex].zzzTimeout ? clearTimeout(dailies[userIndex].zzzTimeout) : null;
                    dailies[userIndex].zzzTimeout = setTimeout(() => {
                        ctx.message.channel.send(`<@${ctx.message.author.id}> :alarm_clock: **${gameChosen}** daily reset in 5 minutes!`);
                    }, (dailies[userIndex].zzz - Math.floor(m.createdTimestamp/1000) - 300) * 1000);*/
                    break;
                case 'baButton':
                    dailies[userIndex].ba = Math.floor(m.createdTimestamp/1000) + ((baCAP - parseInt(m.content)) * baERR * 60);
                    ctx.message.channel.send(`:white_check_mark: Successfully set **${gameChosen}** daily reset time set to <t:${dailies[userIndex].ba}>.`);
                    /*dailies[userIndex].baTimeout ? clearTimeout(dailies[userIndex].baTimeout) : null;
                    dailies[userIndex].baTimeout = setTimeout(() => {
                        ctx.message.channel.send(`<@${ctx.message.author.id}> :alarm_clock: **${gameChosen}** daily reset in 5 minutes!`);
                    }, (dailies[userIndex].ba - Math.floor(m.createdTimestamp/1000) - 300) * 1000);*/
                    break;
            }
            writeFileSync('./data/user_dailies.txt', JSON.stringify(dailies, null, 2));
            return;
        });

        messageCollector.on('end', async (collected, reason) => {
            if (reason === 'time') {
                ctx.message.channel.send(`:x: Time's up! Please try again.`);
            }
        });
    });

    buttonCollector.on('end', async (collected, reason) => {
        if (reason === 'time') {
            giButton.setDisabled(true);
            hsrButton.setDisabled(true);
            zzzButton.setDisabled(true);
            baButton.setDisabled(true);
            reply.edit({ components: [buttonRow1, buttonRow2] })
        }
    });
}