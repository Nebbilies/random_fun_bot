import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { syncItemDiscovery } from "../lib/itemDiscovery.js";

try {
  const { values } = parseArgs({
    options: {
      guild: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      db: { type: "string", default: "data/bot.sqlite" },
    },
    allowPositionals: false,
  });
  if (values.guild !== undefined && !/^\d+$/.test(values.guild)) {
    throw new Error("--guild must be a Discord guild ID");
  }
  const db = new DatabaseSync(resolve(values.db), {
    readOnly: values["dry-run"],
  });
  try {
    const result = syncItemDiscovery(db, {
      guildId: values.guild,
      dryRun: values["dry-run"],
    });
    console.log(
      JSON.stringify({ guildId: values.guild ?? null, ...result }, null, 2),
    );
  } finally {
    db.close();
  }
} catch (error) {
  console.error(`Item discovery sync failed: ${error.message}`);
  process.exitCode = 1;
}
