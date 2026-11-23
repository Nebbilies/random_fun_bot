import { startTrade } from '../lib/tradeRuntime.js';

/**
 * !trade @user — exchange characters with another player.
 * @param {any} ctx
 */
export async function run(ctx) {
  await startTrade(ctx);
}
