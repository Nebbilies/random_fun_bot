import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONVERSION_HELP,
  parseConversionArgs,
  runCatalogConversion,
} from "../lib/catalogConversionOperation.js";

export function main(args = process.argv.slice(2)) {
  const options = parseConversionArgs(args);
  if (options.help) {
    console.log(CONVERSION_HELP);
    return;
  }
  const report = runCatalogConversion(options);
  console.log(JSON.stringify(report, null, 2));
  if (report.blockers?.length) process.exitCode = 1;
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
      console.error(JSON.stringify(error.operationReport, null, 2));
    process.exitCode = 1;
  }
}
