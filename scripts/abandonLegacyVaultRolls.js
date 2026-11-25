import {
  ABANDONMENT_HELP,
  parseVaultAbandonmentArgs,
  runVaultAbandonment,
} from "../lib/legacyVaultAbandonmentOperation.js";
try {
  const options = parseVaultAbandonmentArgs(process.argv.slice(2));
  if (options.help) process.stdout.write(ABANDONMENT_HELP);
  else
    process.stdout.write(
      `${JSON.stringify(await runVaultAbandonment(options), null, 2)}\n`,
    );
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
