import { sendLandmine } from "../../commands/utils/send-landmine.js";
import { landmineRuntime } from "../../lib/landmineRuntime.js";
export function createLandmineHandler() {
  let activeLandmines = new Map();
  const LANDMINE_LENGTH = 60 * 1000 * 5;
  const LANDMINE_CHANNELS = ["1058299699460833301"];
  let currentMessageCount = 0;
  return async function handleLandmine(message) {
    const now = Date.now();
    const userId = message.author.id;
    const expiresAt = activeLandmines.get(userId);
    if (activeLandmines.has(userId)) {
      if (!LANDMINE_CHANNELS.includes(message.channel.id)) {
        return true;
      }
      if (expiresAt) {
        if (expiresAt < now) {
          activeLandmines.delete(userId);
        } else {
          await sendLandmine(message);
          return true;
        }
      }
    }
    currentMessageCount++;
    if (
      landmineRuntime.pity > 0 &&
      currentMessageCount >= landmineRuntime.pity
    ) {
      currentMessageCount = 0;
      activeLandmines.set(userId, now + LANDMINE_LENGTH);
      await message.channel.send({
        content: `thang ngu <@${userId}> da dap min trong 5 phut`,
      });
      await sendLandmine(message);
      return true;
    }
    if (Math.random() < landmineRuntime.chance) {
      activeLandmines.set(userId, now + LANDMINE_LENGTH);
      await message.channel.send({
        content: `thang ngu <@${userId}> da dap min trong 5 phut`,
      });
      await sendLandmine(message);
      return true;
    }
    return false;
  };
}
