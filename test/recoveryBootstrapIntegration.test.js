import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { accumulateRecoveryCounts } from '../lib/recoveryObservation.js';

const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

test('real ClientReady startup keeps ingress closed until recovery and search preparation complete', async () => {
  const start = source.indexOf('    finishDiscordLogin?.();');
  const end = source.indexOf('    let vaultRecoveryRunning', start);
  assert.ok(start >= 0 && end > start);
  const recovery = deferred();
  const order = [];
  const startup = { run: async (name, work) => { order.push(name); return work(); },
    runSync: (name, work) => { order.push(name); return work(); }, finish: stats => order.push(stats) };
  const run = new Function('startup', 'runGameRecovery', 'yoshiko', 'catalogCache', 'recoveryOperations',
    'finishDiscordLogin', `return (async () => { let gameRuntimeReady = false;
      ${source.slice(start, end)}
      return gameRuntimeReady;
    })();`);
  let ready = false;
  const work = run(startup, () => recovery.promise, {}, { get() { order.push('cache-built'); } }, {},
    () => order.push('discord-ready')).then(value => { ready = value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['discord-ready', 'post-client-ready']);
  assert.equal(ready, false);
  recovery.resolve({ candidates: 10 });
  await work;
  assert.equal(ready, true);
  assert.deepEqual(order, ['discord-ready', 'post-client-ready', 'search-cache', 'cache-built', { candidates: 10 }]);
});

test('real periodic callback does not overlap and releases its guard after failure', async t => {
  const start = source.indexOf('    let vaultRecoveryRunning');
  const end = source.indexOf('    vaultRecovery.unref();', start);
  assert.ok(start >= 0 && end > start);
  const held = deferred();
  let callback, calls = 0;
  t.mock.method(console, 'error', () => {});
  const install = new Function('setInterval', 'createRecoveryObserver', 'runGameRecovery', 'yoshiko',
    'recoveryOperations', 'performance', 'recoveryError', 'accumulateRecoveryCounts', source.slice(start, end));
  install(fn => { callback = fn; return {}; }, () => ({ finish() {} }), async () => {
    calls++;
    if (calls === 1) { await held.promise; throw new Error('simulated failure'); }
    return {};
  }, {}, {}, { now: () => 0 }, () => ({}), accumulateRecoveryCounts);
  const first = callback();
  await callback();
  assert.equal(calls, 1);
  held.resolve();
  await first;
  await callback();
  assert.equal(calls, 2);
});

test('periodic heartbeat accumulates earlier work and resets interval totals after reporting', async () => {
  const start = source.indexOf('    let vaultRecoveryRunning');
  const end = source.indexOf('    vaultRecovery.unref();', start);
  let callback, now = 0, calls = 0;
  const reports = [];
  const install = new Function('setInterval', 'createRecoveryObserver', 'runGameRecovery', 'yoshiko',
    'recoveryOperations', 'performance', 'recoveryError', 'accumulateRecoveryCounts', source.slice(start, end));
  install(fn => { callback = fn; return {}; }, () => ({ finish: (...args) => reports.push(args) }),
    async () => ++calls === 1 ? { rewardEdits: 3, candidates: 10 } : { rewardEdits: 0, candidates: 10 },
    {}, {}, { now: () => now }, () => ({}), accumulateRecoveryCounts);
  now = 15_000;
  await callback();
  assert.equal(reports.length, 0);
  now = 300_000;
  await callback();
  assert.deepEqual(reports[0], [{ rewardEdits: 3, candidates: 20 }, { cycles: 2, elapsedMs: 300_000 }]);
  now = 600_000;
  await callback();
  assert.deepEqual(reports[1], [{ rewardEdits: 0, candidates: 10 }, { cycles: 1, elapsedMs: 300_000 }]);
});
