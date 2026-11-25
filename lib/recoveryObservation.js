import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";

// Attempts unless named otherwise. Do not accept arbitrary records (reward IDs,
// player data and Discord error objects must never reach structured telemetry).
const COUNT_KEYS = new Set([
  "candidates",
  "channelFetches",
  "sourceFetches",
  "sourceEdits",
  "sourceSends",
  "rewardFetches",
  "rewardSends",
  "rewardEdits",
  "rewardUnchanged",
  "gated",
  "missing",
  "rebindings",
  "deferred",
]);
function counts(value = {}) {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([key, n]) =>
        COUNT_KEYS.has(key) &&
        typeof n === "number" &&
        Number.isFinite(n) &&
        n >= 0,
    ),
  );
}
export function accumulateRecoveryCounts(total, next) {
  for (const [key, n] of Object.entries(counts(next)))
    total[key] = (total[key] ?? 0) + n;
  return total;
}

export function recoveryError(error) {
  return {
    ...(typeof error?.code === "string" && /^[A-Z_0-9]{1,40}$/.test(error.code)
      ? { code: error.code }
      : {}),
    ...(Number.isInteger(error?.code) ? { code: error.code } : {}),
    ...(Number.isInteger(error?.status) ? { status: error.status } : {}),
  };
}

/** Monotonic timings; logging never alters recovery or exposes arbitrary errors.
 * @param {{now?: () => number, log?: (line: string) => void, id?: string, mode?: string, verbose?: boolean}} [options]
 */
export function createRecoveryObserver({
  now = () => performance.now(),
  log = (line) => console.log(line),
  id = randomUUID(),
  mode = "startup",
  verbose = true,
} = {}) {
  const started = now();
  const stages = {};
  const elapsed = (since) =>
    Math.max(0, Math.round((now() - since) * 100) / 100);
  const emit = (record) => {
    try {
      log(JSON.stringify({ scope: "game-recovery", id, mode, ...record }));
    } catch {
      /* Logging must not acknowledge, fail or mask recovery. */
    }
  };
  function begin(stage) {
    const at = now();
    if (verbose) emit({ event: "stage-start", stage });
    let finished = false;
    return (error = undefined) => {
      if (finished) return;
      finished = true;
      const elapsedMs = elapsed(at);
      stages[stage] = elapsedMs;
      if (verbose || error)
        emit({
          event: error ? "stage-failure" : "stage-finish",
          stage,
          elapsedMs,
          ...(error ? { error: recoveryError(error) } : {}),
        });
    };
  }
  function runSync(stage, work) {
    const finish = begin(stage);
    try {
      const result = work();
      finish();
      return result;
    } catch (error) {
      finish(error);
      throw error;
    }
  }
  async function run(stage, work) {
    const finish = begin(stage);
    try {
      const result = await work();
      finish();
      return result;
    } catch (error) {
      finish(error);
      throw error;
    }
  }
  return {
    begin,
    run,
    runSync,
    finish: (stats = {}, interval = undefined) =>
      emit({
        event: "cycle-finish",
        elapsedMs: elapsed(started),
        stages: { ...stages },
        counts: counts(stats),
        ...(interval ? { interval } : {}),
      }),
  };
}
