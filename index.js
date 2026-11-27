import config from "./config.js";
import { startBot } from "./app/bootstrap.js";

if (!config.token)
  throw new Error("Set DISCORD_BOT_TOKEN before starting the bot.");

export const yoshiko = await startBot(config);
