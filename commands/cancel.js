import { cancelTransfer } from "../lib/tradeRuntime.js";

/**
 * !cancel — decline the trade or gift you are part of.
 * @param {any} ctx
 */
export async function run(ctx) {
  await cancelTransfer(ctx);
}
