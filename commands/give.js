import { startGift } from '../lib/tradeRuntime.js';

/**
 * !give @user — offer characters to another player.
 * @param {any} ctx
 */
export async function run(ctx) {
  await startGift(ctx);
}
