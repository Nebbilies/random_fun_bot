import { parseVaultRetirementArgs, runVaultRetirement, RETIREMENT_HELP } from '../lib/legacyVaultRetirement.js';
try {
  const options = parseVaultRetirementArgs(process.argv.slice(2));
  if (options.help) process.stdout.write(RETIREMENT_HELP);
  else process.stdout.write(`${JSON.stringify(await runVaultRetirement(options), null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
