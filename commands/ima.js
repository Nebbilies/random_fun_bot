import { runFranchiseCommand } from './utils/franchiseCommand.js';

export async function run(ctx) {
  await runFranchiseCommand({ ...ctx, showRank: false });
}
