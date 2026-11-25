import config from "./config.js";
import { startBot } from "./app/bootstrap.js";

export const yoshiko = await startBot(config);
