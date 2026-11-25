import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RANKING_OPERATION_HELP,
  parseRankingOperationArgs,
  runRankingOperation,
} from "../lib/catalogRankingOperation.js";
export function main(args = process.argv.slice(2)) {
  const options = parseRankingOperationArgs(args);
  if (options.help) {
    console.log(RANKING_OPERATION_HELP);
    return;
  }
  const report = runRankingOperation(options);
  console.log(JSON.stringify(report, null, 2));
  return report;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    if (error.operationReport)
      console.error(JSON.stringify(error.operationReport));
    process.exitCode = 1;
  }
}
