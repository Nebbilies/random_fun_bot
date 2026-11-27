import { runGameRecovery as defaultRecovery } from "../lib/gameRecovery.js";
import {
  createRecoveryObserver as defaultObserver,
  recoveryError,
  accumulateRecoveryCounts,
} from "../lib/recoveryObservation.js";
import { performance as clock } from "node:perf_hooks";
import {
  hasDueSeasonWork,
  nextSeasonDeadline,
  runSeasonWork,
} from "../features/seasons/seasonRuntime.js";
import { hasSeasonSchema } from "../lib/seasonSchema.js";
import { hasWeeklyEventSchema } from "../lib/weeklyEventSchema.js";
import { runWeeklyWork } from "../features/weeklyEvents/weeklyRuntime.js";
/** @param {any} context @param {any} [options] */
export function startRecoveryWorker(
  { yoshiko, recoveryOperations },
  options = {},
) {
  const schedule = options.schedule ?? setInterval;
  const performance = options.performance ?? clock;
  const runGameRecovery = options.runRecovery ?? defaultRecovery;
  const createRecoveryObserver = options.createObserver ?? defaultObserver;
  let vaultRecoveryRunning = false;
  let publicationRunning = false;
  const publicationCursor = { unpublished: "", published: "" };
  let lastPublicationReport = -Infinity;
  let lastRecoveryReport = performance.now();
  let recoveryTotals = {};
  let recoveryCycles = 0;
  let deadlineTimer;
  let seasonPass;
  function armSeasonDeadline() {
    clearTimeout(deadlineTimer);
    const now = Date.now();
    const deadline = nextSeasonDeadline(yoshiko.catalogDb, now);
    if (deadline === null || deadline - now > 2_147_483_647) return;
    deadlineTimer = setTimeout(pollSeason, deadline - now);
    deadlineTimer.unref();
  }
  function recoverSeason(maintenance) {
    if (seasonPass) return seasonPass;
    seasonPass = runSeasonWork({
      db: yoshiko.catalogDb,
      client: yoshiko.client,
      prefix: yoshiko.config?.prefix,
      maintenance,
    })
      .catch((error) =>
        console.error("Season recovery failed:", recoveryError(error)),
      )
      .finally(() => {
        seasonPass = undefined;
        armSeasonDeadline();
      });
    return seasonPass;
  }
  function pollSeason() {
    try {
      if (!seasonPass && hasDueSeasonWork(yoshiko.catalogDb))
        return recoverSeason(false);
    } catch (error) {
      console.error("Season recovery failed:", recoveryError(error));
    }
  }
  async function publishCards() {
    if (publicationRunning) return;
    publicationRunning = true;
    const observer = createRecoveryObserver({
      mode: "vault-publication",
      verbose: false,
    });
    const stats = {};
    try {
      await observer.run("vault-publication", () =>
        recoveryOperations.publishVaultRewardBatch(
          yoshiko.catalogDb,
          yoshiko.client,
          publicationCursor,
          { stats },
        ),
      );
      const now = performance.now();
      if (
        stats.candidates &&
        (stats.deferred ||
          stats.rewardSends ||
          stats.rewardEdits ||
          now - lastPublicationReport >= 300000)
      ) {
        observer.finish(stats);
        lastPublicationReport = now;
      }
    } catch (error) {
      console.error("Vault publication failed:", recoveryError(error));
    } finally {
      publicationRunning = false;
    }
  }
  async function tick() {
    if (vaultRecoveryRunning) return;
    vaultRecoveryRunning = true;
    const observer = createRecoveryObserver({
      mode: "periodic",
      verbose: false,
    });
    try {
      if (hasSeasonSchema(yoshiko.catalogDb)) {
        await recoverSeason(true);
      }
      if (hasWeeklyEventSchema(yoshiko.catalogDb)) {
        await runWeeklyWork({
          db: yoshiko.catalogDb,
          client: yoshiko.client,
        }).catch((error) =>
          console.error("Weekly Event recovery failed:", recoveryError(error)),
        );
      }
      const counts = await runGameRecovery({
        db: yoshiko.catalogDb,
        client: yoshiko.client,
        imagePicker: yoshiko.imagePicker,
        observer,
        operations: recoveryOperations,
      });
      void publishCards();
      accumulateRecoveryCounts(recoveryTotals, counts);
      recoveryCycles++;
      // Interval totals include every completed pass; timings describe the
      // latest pass only. Delivery failures surface immediately.
      if (counts.deferred || performance.now() - lastRecoveryReport >= 300000) {
        observer.finish(recoveryTotals, {
          cycles: recoveryCycles,
          elapsedMs: Math.round(performance.now() - lastRecoveryReport),
        });
        lastRecoveryReport = performance.now();
        recoveryTotals = {};
        recoveryCycles = 0;
      }
    } catch (error) {
      console.error("Vault recovery failed:", recoveryError(error));
    } finally {
      vaultRecoveryRunning = false;
    }
  }
  const vaultRecovery = schedule(tick, 15000);
  vaultRecovery.unref();
  if (hasSeasonSchema(yoshiko.catalogDb)) {
    schedule(pollSeason, 1000).unref();
    armSeasonDeadline();
  }
  return vaultRecovery;
}
