import {readFileSync, writeFileSync} from "fs";



export const run = async (ctx) => {
    const currentMinimum = parseInt(readFileSync('./data/set_minimum_members.txt', 'utf-8'));
    //Reply
    const reply = await ctx.message.reply('<:fr:1146835427668541570> Please set the minimum number of members in VC... (min: 0, max: 50) \n' + `**Current is: ${currentMinimum}**`);
    //Filter: Author of the message, message is a number, maximum 50, minimum 0
    const filter = message =>
        !isNaN(parseInt(message.content)) && parseInt(message.content) < 50 && parseInt(message.content) >= 0;

    //Collector
    const collector = reply.channel.createMessageCollector({
        filter: filter,
        time: 15000,
        max: 1
    })

    //On successfully collected
    collector.on('collect', (message) => {
        reply.edit({content: `<:lai:1261757509312446517> Successfully set to **${message.content}**.`});
        writeFileSync('./data/set_minimum_members.txt', message.content);
    })
}