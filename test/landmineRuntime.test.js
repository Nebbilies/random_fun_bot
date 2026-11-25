import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("missing landmine config is created, while existing settings survive startup", async () => {
  const directory = mkdtempSync(join(tmpdir(), "landmine-config-"));
  const previous = process.cwd();
  try {
    process.chdir(directory);
    const first = await import("../lib/landmineRuntime.js?missing-config");
    assert.deepEqual(
      JSON.parse(readFileSync("data/landmine-config.json", "utf8")),
      { landmineRate: 0.036, landminePity: 0 },
    );
    first.landmineRuntime.setRate(8);
    first.landmineRuntime.setPity(3);
    const second = await import("../lib/landmineRuntime.js?existing-config");
    assert.equal(second.landmineRuntime.chance, 0.08);
    assert.equal(second.landmineRuntime.pity, 3);
    writeFileSync(
      "data/landmine-config.json",
      '{"landmineRate":2,"landminePity":1}',
    );
    second.landmineRuntime.reload();
    assert.equal(second.landmineRuntime.chance, 0.02);
  } finally {
    process.chdir(previous);
    rmSync(directory, { recursive: true, force: true });
  }
});
