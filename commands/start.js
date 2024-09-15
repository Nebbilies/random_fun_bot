import {readFileSync, writeFileSync} from "fs";

export const run = async (ctx) => {
    const setRun = readFileSync('./data/set_run.txt').toString();
    if (setRun === "1") {
        ctx.message.reply("Already running.")
    } else {
        writeFileSync('./data/set_run.txt', "1")
        ctx.message.reply("Starting...")
    }
}