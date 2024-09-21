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

    //Get user's game info
    let giInfo = await getGenshinInfo(ltoken_v2, ltuid_v2);
    let hsrInfo = await getHsrInfo(ltoken_v2, ltuid_v2);
    let zzzInfo = await getZzzInfo(ltoken_v2, ltuid_v2);

    //Check if user has set up their ltoken_v2 and ltuid_v2
    if (dailies[userIndex].ltoken_v2 === '' || dailies[userIndex].ltuid_v2 === '') {
        await interaction.reply({content: ':x: **Please set up your ltoken_v2 and ltuid_v2 (/setup) first.**', ephemeral: true});
        return;
    }

    //Check if user's token and id is invalid
    if (giInfo === -1 || hsrInfo === -1 || zzzInfo === -1) {
        await interaction.reply({content: ':x: **Invalid ltoken_v2 or ltuid_v2.**', ephemeral: true});
        return;
    }

    //Display time left for each game. Set timeout when energy is 5 mins (300 secs) away from full.
    let giTimeLeft = -1;
    let hsrTimeLeft = -1;
    let zzzTimeLeft = -1;

    if (giInfo !== -1 && giInfo !== null) {
        giTimeLeft = parseInt(giInfo.data.resin_recovery_time);
    }
    if (hsrInfo !== -1 && hsrInfo !== null) {
        hsrTimeLeft = parseInt(hsrInfo.data.stamina_recover_time);
    }
    if (zzzInfo !== -1 && zzzInfo !== null) {
        zzzTimeLeft = parseInt(zzzInfo.data.energy.restore);
    }

    const embed = new Embed({
        title: "Your Daily Resets",
        color: 0xffff7d,
        description: `\n <:gi:1285548706690764830> **Genshin Impact**: ${giTimeLeft === -1 ? 'Not Set' : giTimeLeft === 0 ? 'Full' : `<t:${ Math.floor(Date.now() / 1000) + giTimeLeft}>`} \n
        <:hsr:1285538992237969471> **Honkai: Star Rail**: ${hsrTimeLeft === -1 ? 'Not Set' : hsrTimeLeft === 0 ? 'Full' : `<t:${ Math.floor(Date.now() / 1000) + hsrTimeLeft}>`} \n
        <:zenless:1285539968487395338> **Zenless Zone Zero**: ${zzzTimeLeft === -1 ? 'Not Set' : zzzTimeLeft === 0 ? 'Full' : `<t:${ Math.floor(Date.now() / 1000) + zzzTimeLeft}>`} \n
        `,
    })
    await interaction.reply({content: `Now with **LIVE FETCHING** from **HOYOLAB** <:lai:1261757509312446517> <:lai:1261757509312446517> <:lai:1261757509312446517>
bot will break sometimes so sorry if it does <:ba:1285539663620210739>`, embeds: [embed]});
}

