import { runGameRecovery as defaultRecovery } from '../lib/gameRecovery.js';
import { createRecoveryObserver as defaultObserver, recoveryError, accumulateRecoveryCounts } from '../lib/recoveryObservation.js';
import { performance as clock } from 'node:perf_hooks';
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
    const vaultRecovery = schedule(async () => {
        if (vaultRecoveryRunning)
            return;
        vaultRecoveryRunning = true;
        const observer = createRecoveryObserver({ mode: 'periodic', verbose: false });
        try {
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
        }
    }, 15000);
    vaultRecovery.unref();
    return vaultRecovery;
}
