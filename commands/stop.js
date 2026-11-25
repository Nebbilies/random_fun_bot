import { readFileSync, writeFileSync } from "fs";

export const run = async (ctx) => {
  const setRun = readFileSync("./data/set_run.txt").toString();
  if (setRun === "0") {
    ctx.message.reply("Not running.");
  } else {
    writeFileSync("./data/set_run.txt", "0");
    ctx.message.reply("Stopped.");
  }
};
