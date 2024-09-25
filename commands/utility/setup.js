import userDailies from '../../lib/userDailies.js';
import { SlashCommandBuilder } from 'discord.js';
import {readFileSync, writeFileSync} from "fs";

export const data = new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Setup your cookie')
    .addStringOption(option =>
        option.setName('cookie')
            .setRequired(true)
            //.setMinLength(225)
            //.setMaxLength(225)
            .setDescription('Input your cookie')
    )
/*    .addStringOption(option =>
        option.setName('ltuid_v2')
            .setRequired(true)
            .setDescription('Input your ltuid_v2')
    )
    //add ltmid_v2
.addStringOption(option =>
    option.setName('account_mid_v2')
        .setRequired(true)
        .setDescription('Input your account_mid_v2')
)
.addStringOption(option =>
    option.setName('cookie_token_v2')
        .setRequired(true)
        .setDescription('Input your cookie_token_v2')
);*/


export async function execute(interaction) {
    //const ltoken_v2 = interaction.options.getString('ltoken_v2');
    //const ltuid_v2 = interaction.options.getString('ltuid_v2');
    /*const account_mid_v2 = interaction.options.getString('account_mid_v2');
    const cookie_token_v2 = interaction.options.getString('cookie_token_v2');*/
    const Cookie = interaction.options.getString('cookie');

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
    dailies[userIndex].Cookie = Cookie;


    writeFileSync('./data/user_dailies.txt', JSON.stringify(dailies, null, 2));
    await interaction.reply({content: ':white_check_mark: **Update Successful.**', ephemeral: true});
}

