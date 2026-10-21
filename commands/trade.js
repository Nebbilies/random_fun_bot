import { startTrade } from '../lib/tradeRuntime.js';

/**
 * !trade @user — offer one of your characters and pick one of theirs.
 * @param {any} ctx
 */
export async function run(ctx) {
  await startTrade(ctx);
}
