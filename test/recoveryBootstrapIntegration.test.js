import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareGameRuntime } from "../app/bootstrap.js";
import { startRecoveryWorker } from "../app/recoveryWorker.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("real ClientReady startup keeps ingress closed until recovery and search preparation complete", async () => {
  const recovery = deferred();
  const order = [];
  const startup = {
    run: async (name, work) => {
      order.push(name);
      return work();
    },
    runSync: (name, work) => {
      order.push(name);
      return work();
    },
    finish: (stats) => order.push(stats),
  };
  let ready = false;
  const work = prepareGameRuntime({
    startup,
    yoshiko: {},
    recoveryOperations: {},
    catalogCache: {
      get() {
        order.push("cache-built");
      },
      warmRollPools() {
        order.push("roll-pools-built");
      },
    },
    runRecovery: () => recovery.promise,
    finishDiscordLogin: () => order.push("discord-ready"),
    setReady: () => {
      ready = true;
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["discord-ready", "post-client-ready"]);
  assert.equal(ready, false);
  recovery.resolve({ candidates: 10 });
  await work;
  assert.equal(ready, true);
  assert.deepEqual(order, [
    "discord-ready",
    "post-client-ready",
    "search-cache",
    "cache-built",
    "roll-pools-built",
    { candidates: 10 },
  ]);
});

test("real periodic callback does not overlap and releases its guard after failure", async (t) => {
  const held = deferred();
  let callback,
    calls = 0;
  t.mock.method(console, "error", () => {});
  startRecoveryWorker(
    { yoshiko: {}, recoveryOperations: {} },
    {
      schedule: (fn) => {
        callback = fn;
        return { unref() {} };
      },
      createObserver: () => ({ finish() {} }),
      runRecovery: async () => {
        calls++;
        if (calls === 1) {
          await held.promise;
          throw new Error("simulated failure");
        }
        return {};
      },
      performance: { now: () => 0 },
    },
  );
  const first = callback();
  await callback();
  assert.equal(calls, 1);
  held.resolve();
  await first;
  await callback();
  assert.equal(calls, 2);
});

test("periodic heartbeat accumulates earlier work and resets interval totals after reporting", async () => {
  let callback,
    now = 0,
    calls = 0;
  const reports = [];
  startRecoveryWorker(
    { yoshiko: {}, recoveryOperations: {} },
    {
      schedule: (fn) => {
        callback = fn;
        return { unref() {} };
      },
      createObserver: () => ({ finish: (...args) => reports.push(args) }),
      runRecovery: async () =>
        ++calls === 1
          ? { rewardEdits: 3, candidates: 10 }
          : { rewardEdits: 0, candidates: 10 },
      performance: { now: () => now },
    },
  );
  now = 15_000;
  await callback();
  assert.equal(reports.length, 0);
  now = 300_000;
  await callback();
  assert.deepEqual(reports[0], [
    { rewardEdits: 3, candidates: 20 },
    { cycles: 2, elapsedMs: 300_000 },
  ]);
  now = 600_000;
  await callback();
  assert.deepEqual(reports[1], [
    { rewardEdits: 0, candidates: 10 },
    { cycles: 1, elapsedMs: 300_000 },
  ]);
});
