import { startGift } from '../lib/tradeRuntime.js';

/**
 * !give @user — hand one of your characters over to another player.
 * @param {any} ctx
 */
export async function run(ctx) {
  await startGift(ctx);
}
