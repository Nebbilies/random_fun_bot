import {readFileSync, writeFileSync} from "fs";

export const run = async (ctx) => {
    let memberCounterMap = new Map(JSON.parse(readFileSync("./data/counter.txt", "utf-8")));
    //Loop for each entry in the map, sort by value, then slice the first 10 entries and map them to a string
    const embed = {
        color: 0xffff7d,
        description: `\n${Array.from(memberCounterMap.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([key, value], index) => `${index + 1}. <@${key}>: ${value} ${value === 1 ? "ping" : "pings"}`).join("\n")}`
    };
    ctx.message.channel.send({ embeds: [ embed ] })
}