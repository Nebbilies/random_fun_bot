import { listWishes } from "./wish.js";

export async function run(ctx) {
  await listWishes(ctx);
}
