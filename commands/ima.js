import { runFranchiseCommand } from './utils/franchiseCommand.js';
import { parseFranchiseCommand } from '../lib/franchiseModifiers.js';

export async function run(ctx) {
  await runFranchiseCommand({ ...ctx, ...parseFranchiseCommand(ctx.args[0]) });
}
