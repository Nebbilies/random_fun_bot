import { runRoll } from "../lib/characterRollRuntime.js";

export async function run(ctx) {
  await runRoll(ctx, "w");
}
