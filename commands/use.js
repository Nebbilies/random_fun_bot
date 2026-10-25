import { activateItem } from '../lib/itemActivation.js';

// Preserve existing direct-effect callers while activation orchestration lives in lib.
export { executeItemUse, executeItemUseById } from '../lib/itemActivation.js';

export async function run(ctx) {
  const { message, args, yoshiko } = ctx;
  if (args.length < 2) {
    await message.reply('Please specify an item to use! Type `!inv` to see your items, or `!use <item> [args]`.');
    return;
  }
  await activateItem({ db: yoshiko.catalogDb, message, itemQuery: args[1],
    args: args.slice(2), options: ctx.options ?? {} });
}
