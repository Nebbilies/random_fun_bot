import assert from "node:assert/strict";
import { test } from "node:test";
import { createRecoveryObserver } from "../lib/recoveryObservation.js";
import { runGameRecovery } from "../lib/gameRecovery.js";

function gate() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test("startup recovery completes reveal/session/materialization before exactly one scheduled reward sweep", async () => {
  const calls = [],
    held = gate();
  const names = [
    "recoverBinocularsUses",
    "recoverItemActionRuntime",
    "recoverPendingRollDeliveries",
    "recoverForcedEscapes",
    "recoverOpenEscapes",
    "recoverMysteryRuntime",
    "recoverVaultSessions",
    "recoverSelectedAffectionRewards",
    "recoverVaultRewards",
    "cleanupExpiredItems",
  ];
  const operations = Object.fromEntries(
    names.map((name) => [
      name,
      async (...args) => {
        calls.push(name);
        if (name === "recoverMysteryRuntime") await held.promise;
        if (name === "recoverVaultSessions")
          assert.equal(args[2].recoverRewards, false);
        if (name === "recoverVaultRewards") args[2].stats.candidates = 10;
      },
    ]),
  );
  let done = false;
  const work = runGameRecovery({
    db: {},
    client: {},
    startup: true,
    operations,
  }).then((stats) => {
    done = true;
    return stats;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, names.slice(0, 6));
  assert.equal(done, false);
  held.release();
  assert.equal((await work).candidates, 10);
  assert.deepEqual(calls, names);
});

test("periodic recovery uses the same ordering without repeating startup-only item actions", async () => {
  const calls = [];
  const names = [
    "recoverPendingRollDeliveries",
    "recoverForcedEscapes",
    "recoverOpenEscapes",
    "recoverMysteryRuntime",
    "recoverVaultSessions",
    "recoverSelectedAffectionRewards",
    "recoverVaultRewards",
    "cleanupExpiredItems",
  ];
  const operations = Object.fromEntries(
    names.map((name) => [name, async () => calls.push(name)]),
  );
  await runGameRecovery({ db: {}, client: {}, operations });
  assert.deepEqual(calls, names);
});

test("recovery stage failures propagate and never run later stages", async () => {
  const error = new Error("do not continue");
  await assert.rejects(
    runGameRecovery({
      db: {},
      client: {},
      operations: {
        recoverPendingRollDeliveries() {
          throw error;
        },
        recoverForcedEscapes() {
          assert.fail("must not run after failure");
        },
      },
    }),
    (value) => value === error,
  );
});

test("monotonic stage logging starts before work, finishes after settlement and keeps secrets out", async () => {
  let now = 100;
  const logs = [],
    held = gate();
  const observer = createRecoveryObserver({
    now: () => now,
    log: (line) => logs.push(JSON.parse(line)),
    id: "startup-test",
  });
  const finish = observer.begin("discord-login");
  now += 53;
  finish();
  const work = observer.run("vault-rewards", () => held.promise);
  assert.deepEqual(
    logs.map((r) => r.event),
    ["stage-start", "stage-finish", "stage-start"],
  );
  now += 99;
  held.release();
  await work;
  assert.equal(logs.at(-1).elapsedMs, 99);
  assert.equal(
    observer.runSync("catalog-open", () => 42),
    42,
  );
  const error = Object.assign(
    new Error("token=secret https://discord.example/private"),
    { code: "SQLITE_BUSY", status: 503, token: "secret" },
  );
  await assert.rejects(
    observer.run("failed-stage", async () => {
      throw error;
    }),
    (value) => value === error,
  );
  assert.deepEqual(logs.at(-1).error, { code: "SQLITE_BUSY", status: 503 });
  observer.finish({ candidates: 10, token: "secret", userId: "private-user" });
  assert.equal(logs.at(-1).elapsedMs, 152);
  assert.deepEqual(logs.at(-1).counts, { candidates: 10 });
  assert.doesNotMatch(JSON.stringify(logs), /secret|private-user|https:/);
});

test("synchronous guards and logger failures preserve original recovery results and failures", async () => {
  const logs = [];
  const observer = createRecoveryObserver({
    log: (line) => logs.push(JSON.parse(line)),
  });
  const error = new Error("unknown schema");
  assert.throws(
    () =>
      observer.runSync("restart-validation", () => {
        throw error;
      }),
    (value) => value === error,
  );
  assert.equal(logs.at(-1).event, "stage-failure");
  const brokenLogger = createRecoveryObserver({
    log() {
      throw new Error("logger unavailable");
    },
  });
  assert.equal(
    brokenLogger.runSync("catalog-open", () => 123),
    123,
  );
  assert.equal(await brokenLogger.run("recovery", async () => 456), 456);
  await assert.rejects(
    brokenLogger.run("recovery", async () => {
      throw error;
    }),
    (value) => value === error,
  );
});

test("periodic observer can suppress per-stage noise while reporting a cycle summary", async () => {
  const logs = [];
  const observer = createRecoveryObserver({
    mode: "periodic",
    verbose: false,
    log: (line) => logs.push(JSON.parse(line)),
  });
  await observer.run("vault-rewards", async () => {});
  assert.equal(logs.length, 0);
  observer.finish({ rewardEdits: 0 });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].mode, "periodic");
});
