import { startTrade } from '../lib/tradeRuntime.js';

/**
 * !me @user — offer one of your characters and pick one of theirs.
 * @param {any} ctx
 */
export async function run(ctx) {
  await startTrade(ctx);
}
