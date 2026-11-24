import { runGameRecovery as defaultRecovery } from '../lib/gameRecovery.js';
import { createRecoveryObserver as defaultObserver, recoveryError, accumulateRecoveryCounts } from '../lib/recoveryObservation.js';
import { performance as clock } from 'node:perf_hooks';
import { nextSeasonDeadline, runSeasonWork } from '../features/seasons/seasonRuntime.js';
import { hasSeasonSchema } from '../lib/seasonSchema.js';
/** @param {any} context @param {any} [options] */
export function startRecoveryWorker({ yoshiko, recoveryOperations }, options = {}) {
    const schedule = options.schedule ?? setInterval;
    const performance = options.performance ?? clock;
    const runGameRecovery = options.runRecovery ?? defaultRecovery;
    const createRecoveryObserver = options.createObserver ?? defaultObserver;
    let vaultRecoveryRunning = false;
    let lastRecoveryReport = performance.now();
    let recoveryTotals = {};
    let recoveryCycles = 0;
    let deadlineTimer;
    function armSeasonDeadline() {
        clearTimeout(deadlineTimer);
        const now = Date.now();
        const deadline = nextSeasonDeadline(yoshiko.catalogDb,now);
        if (deadline === null || deadline-now>2_147_483_647) return;
        deadlineTimer = setTimeout(tick,deadline-now);
        deadlineTimer.unref();
    }
    async function tick() {
        if (vaultRecoveryRunning)
            return;
        vaultRecoveryRunning = true;
        const observer = createRecoveryObserver({ mode: 'periodic', verbose: false });
        try {
            if (hasSeasonSchema(yoshiko.catalogDb)) {
                await runSeasonWork({db:yoshiko.catalogDb,client:yoshiko.client,prefix:yoshiko.config?.prefix})
                    .catch(error => console.error('Season recovery failed:', recoveryError(error)));
            }
            const counts = await runGameRecovery({ db: yoshiko.catalogDb, client: yoshiko.client,
                imagePicker: yoshiko.imagePicker, observer, operations: recoveryOperations });
            accumulateRecoveryCounts(recoveryTotals, counts);
            recoveryCycles++;
            // Interval totals include every completed pass; timings describe the
            // latest pass only. Delivery failures surface immediately.
            if (counts.deferred || performance.now() - lastRecoveryReport >= 300000) {
                observer.finish(recoveryTotals, { cycles: recoveryCycles,
                    elapsedMs: Math.round(performance.now() - lastRecoveryReport) });
                lastRecoveryReport = performance.now();
                recoveryTotals = {};
                recoveryCycles = 0;
            }
        }
        catch (error) {
            console.error('Vault recovery failed:', recoveryError(error));
        }
        finally {
            vaultRecoveryRunning = false;
            armSeasonDeadline();
        }
    }
    const vaultRecovery = schedule(tick, 15000);
    vaultRecovery.unref();
    armSeasonDeadline();
    return vaultRecovery;
}
