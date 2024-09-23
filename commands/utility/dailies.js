import { SlashCommandBuilder, Embed } from 'discord.js';
import { readFileSync, writeFileSync } from 'fs';
import { getHsrInfo } from "../../lib/getHsrInfo.js";
import { getZzzInfo } from "../../lib/getZzzInfo.js";
import { getGenshinInfo } from "../../lib/getGenshinInfo.js";
import userDailies from "../../lib/userDailies.js";


export const data = new SlashCommandBuilder()
    .setName('dailies')
    .setDescription('Check your daily energy recharge.');


export async function execute(interaction) {
    await interaction.deferReply();
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
        if (dailies[i].id === interaction.user.id) {
            userExist = true;
            userIndex = i;
            break;
        }
    }
    if (!userExist) {
        const newUser = new userDailies(interaction.user.id);
        dailies.push(newUser);
        userIndex = dailies.length - 1;
    }
    //Get user's ltoken_v2 and ltuid_v2
    let ltuid_v2 = dailies[userIndex].ltuid_v2;
    let ltoken_v2 = dailies[userIndex].ltoken_v2;

    //Check if user has set up their ltoken_v2 and ltuid_v2
    if (ltuid_v2 === '' || ltoken_v2 === '') {
        await interaction.reply({content: ':x: **Please set up your ltoken_v2 and ltuid_v2 (/setup) first.**', ephemeral: true});
        return;
    }

    //Get user's game info
    let giInfo = await getGenshinInfo(ltoken_v2, ltuid_v2);
    let hsrInfo = await getHsrInfo(ltoken_v2, ltuid_v2);
    let zzzInfo = await getZzzInfo(ltoken_v2, ltuid_v2);

    //Check if user's token and id is invalid
    if (giInfo === -1 || hsrInfo === -1 || zzzInfo === -1) {
        await interaction.reply({content: ':x: **Invalid ltoken_v2 or ltuid_v2.**', ephemeral: true});
        return;
    }
    if (giInfo === -2 || hsrInfo === -2 || zzzInfo === -2) {
        await interaction.reply({content: ':x: **Data set to private by user, please re-check your HoYoLAB.**', ephemeral: true});
        return;
    }

    //Display time left for each game. Set timeout when energy is 5 mins (300 secs) away from full.
    let giTimeLeft = dailies[userIndex].gi;
    let hsrTimeLeft = dailies[userIndex].hsr;
    let zzzTimeLeft = dailies[userIndex].zzz;

    if (giInfo !== -1 && giInfo !== null && giInfo !== -2) {
        giTimeLeft = parseInt(giInfo.data.resin_recovery_time);
    }
    if (hsrInfo !== -1 && hsrInfo !== null && hsrInfo !== -2) {
        hsrTimeLeft = parseInt(hsrInfo.data.stamina_recover_time);
    }
    if (zzzInfo !== -1 && zzzInfo !== -2 && zzzInfo !== null) {
        zzzTimeLeft = parseInt(zzzInfo.data.energy.restore);
    }

    const embed = new Embed({
        title: "Your Daily Resets",
        color: 0xffff7d,
        description: `\n <:gi:1285548706690764830> **Genshin Impact**: ${giTimeLeft === -1 ? 'Not Set' : giTimeLeft === 0 ? 'Full' : `<t:${ Math.floor(Date.now() / 1000) + giTimeLeft}>`}, **${200 - Math.ceil(giTimeLeft / 480)}**/200 \n
        <:hsr:1285538992237969471> **Honkai: Star Rail**: ${hsrTimeLeft === -1 ? 'Not Set' : hsrTimeLeft === 0 ? 'Full' : `<t:${ Math.floor(Date.now() / 1000) + hsrTimeLeft}>`}, **${240 - Math.ceil(hsrTimeLeft / 360)}**/240 \n
        <:zenless:1285539968487395338> **Zenless Zone Zero**: ${zzzTimeLeft === -1 ? 'Not Set' : zzzTimeLeft === 0 ? 'Full' : `<t:${ Math.floor(Date.now() / 1000) + zzzTimeLeft}>`}, **${240 - Math.ceil(zzzTimeLeft / 360)}**/240 \n
        `,
    })
    await interaction.editReply({content: `Now with **LIVE FETCHING** from **HOYOLAB** <:lai:1261757509312446517> <:lai:1261757509312446517> <:lai:1261757509312446517>
bot will break sometimes so sorry if it does <:ba:1285539663620210739>`, embeds: [embed]});

    //Update user's time left
    dailies[userIndex].gi = giTimeLeft;
    dailies[userIndex].hsr = hsrTimeLeft;
    dailies[userIndex].zzz = zzzTimeLeft;
    writeFileSync('./data/user_dailies.txt', JSON.stringify(dailies, null, 2));
}

