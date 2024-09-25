import userDailies from '../../lib/userDailies.js';
import { SlashCommandBuilder } from 'discord.js';
import {readFileSync, writeFileSync} from "fs";

export const data = new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Setup your ltoken_v2, ltuid_v2')
    .addStringOption(option =>
        option.setName('ltoken_v2')
            .setRequired(true)
            //.setMinLength(225)
            //.setMaxLength(225)
            .setDescription('Input your ltoken_v2')
    )
    .addStringOption(option =>
        option.setName('ltuid_v2')
            .setRequired(true)
            .setDescription('Input your ltuid_v2')
    )
    //add ltmid_v2
    .addStringOption(option =>
        option.setName('ltmid_v2')
            .setRequired(true)
            .setDescription('Input your ltmid_v2')
    );

export async function execute(interaction) {
    const ltoken_v2 = interaction.options.getString('ltoken_v2');
    const ltuid_v2 = interaction.options.getString('ltuid_v2');
    const ltmid_v2 = interaction.options.getString('ltmid_v2');
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
    dailies[userIndex].ltoken_v2 = ltoken_v2;
    dailies[userIndex].ltuid_v2 = ltuid_v2;
    dailies[userIndex].ltmid_v2 = ltmid_v2;

    writeFileSync('./data/user_dailies.txt', JSON.stringify(dailies, null, 2));
    await interaction.reply({content: ':white_check_mark: **Update Successful.**', ephemeral: true});
}

