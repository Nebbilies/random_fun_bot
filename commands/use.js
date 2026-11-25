import { activateItem } from "../lib/itemActivation.js";

// Preserve existing direct-effect callers while activation orchestration lives in lib.
export { executeItemUse, executeItemUseById } from "../lib/itemActivation.js";

export async function run(ctx) {
  const { message, args, yoshiko } = ctx;
  if (args.length < 2) {
    await message.reply(
      "Please specify an item to use! Type `!inv` to see your items, or `!use <item> [args]`.",
    );
    return;
  }
  // Consume only the recognized Fortune name; existing argument-based items
  // retain their original query/target parsing.
  const fortuneName =
    /^fortune['’]?s?$/i.test(args[1]) && /^(lens|recast)$/i.test(args[2] ?? "");
  await activateItem({
    db: yoshiko.catalogDb,
    message,
    itemQuery: fortuneName ? `fortunes_${args[2].toLowerCase()}` : args[1],
    args: args.slice(fortuneName ? 3 : 2),
    options: ctx.options ?? {},
  });
}
