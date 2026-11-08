# Startup recovery efficiency and readiness — draft plan

Status: **implemented on the branch below; see [validation and implementation notes](./startup-recovery-efficiency-validation.md)**. Production rollout, service restarts, branch publication, and dependency-backup cleanup remain separate approval boundaries.

Branch: `fix/startup-recovery-efficiency`

Baseline: `668708db96cbb19c4f5e9fa0a3e958405a44c52a`.

## 1. Problem and observed evidence

The deployment installs the tested commit and restarts both services before checking application readiness. The latest two inspected deployments installed successfully, but their readiness checks expired before the bot completed startup. Failure intentionally does not roll back code or the database.

| Release | Services restarted (UTC) | Discord ClientReady | Game ready | Total startup |
| --- | --- | --- | --- | --- |
| Inbox removal `747b010` | 2026-11-07 15:54:21 | 15:55:17 | 15:56:11 | 110 s |
| Glass Bridge fix `668708d` | 2026-11-07 17:51:42 | 17:52:35 | 17:54:14 | 152 s |

For GitHub run [42398044590](https://github.com/Nebbilies/random_fun_bot/actions/runs/42398044590), deployment exited at 17:52:56 UTC, 78 seconds before game readiness. The `check` job passed. Subsequent read-only inspection found both services active, zero restarts, the expected commit installed, and portal responses `/login` 200, `/catalog` 303 to login, `/api/status` 401. The exact deployment readiness probe passed after startup completed.

Production observations also included 10 pending, bound, already-published overflow rewards, memory swapping, and substantial I/O pressure. These are a workload snapshot and possible contributors, not proof of which startup stage consumed the time. No per-stage timing exists today. The earlier startup-lock incident in `docs/fortune-startup-contention.md` is a distinct failure mode; do not infer that it recurred here.

## 2. Goals and non-goals

### Goals

1. Measure the critical startup path, including the interval before Discord ClientReady.
2. Perform one explicit scheduled reward reconciliation/publication sweep per startup or periodic cycle, after required reveal recovery and affection materialization.
3. Avoid editing a reward card when its actual presentation already matches the latest committed state.
4. Preserve durable recovery, exact outcomes, ownership checks, deadlines, canonical bindings, and interaction responsiveness.
5. Make deployment readiness accommodate the measured startup while still failing for non-readiness or unstable services.

### Non-goals

- Removing overflow records, changing reward expiry, restoring `!rewards`, or changing inventory policy.
- Marking the game ready early, bypassing catalog/restart guards, or treating Discord ClientReady as application readiness.
- Blind parallelization of recovery stages, broad DB/schema changes, a persistent render queue, or generalized orchestration infrastructure.
- Automatic production restart, rollout, backlog deletion, dependency-backup cleanup, or database repair.
- Claiming a startup speedup before measuring it.

## 3. Current call paths and constraints

- `index.js`: opens the catalog and runs the final-schema restart guard before Discord login. The ClientReady handler then serially awaits item actions, roll delivery, escape recovery, mysteries, vault sessions, and vault rewards. Affection materialization, item cleanup, and search preparation occur before `gameRuntimeReady` and the exact `Character game ready.` marker.
- `lib/vaultRuntime.js::recoverVaultSessions()`: recovers sessions and also invokes `recoverVaultRewards()` internally. `index.js` calls reward recovery again after `recoverSelectedAffectionRewards()`. The periodic callback repeats this arrangement.
- `lib/mysteryRuntime.js` also invokes reward recovery in compensated reveal paths. Those calls have reveal/publication semantics and are **not** automatically redundant.
- `lib/vaultRewards.js::listPendingVaultRewards()`: includes decision, overflow, and Recast states even after publication acknowledgement. Keep this recovery coverage; publication is not acquisition.
- `lib/vaultRuntime.js::deliverRewardMessage()`: fetches/recreates canonical cards and calls `writeLatestReward()`, which currently performs an edit before checking whether DB-derived presentation changed during the await.
- `withVaultWrite()` serializes canonical writers, while DB-only reconciliation can still update state during transport awaits. Preserve its catch-up behavior.
- Other callers and tests rely on `recoverVaultSessions()` also repairing rewards. Preserve compatibility explicitly rather than silently removing that behavior.
- `scripts/deploy.sh`: 12 attempts, each sleeping five seconds, with exact new-PID/start-window readiness checks, PID/restart stability checks, and portal probes. Current shell fixtures model immediately ready or never ready, not delayed readiness.

## 4. Implementation sequence

### Phase A — Instrumentation and baseline

Implement first so later changes have attributable measurements.

1. Add small monotonic timing wrappers around catalog open, final-schema restart validation, Discord login-to-ClientReady, each awaited startup recovery stage, affection materialization, expiry cleanup, and cache preparation. Do not reorder work.
2. Emit structured stage-start, stage-finish, and stage-failure records with a startup correlation ID, stage name, elapsed milliseconds, and aggregate counts where available. A stage-start record is necessary to identify a hang that never finishes. Preserve thrown errors and current safety behavior.
3. Add optional aggregate recovery statistics without changing existing public return shapes: candidates, channels/messages fetched, cards sent, cards edited, unchanged cards skipped, gated publications, definitive deletions/rebindings, and deferred transport errors. Separate source-card operations from reward-card operations. Define whether counters mean attempted or successful operations and label accordingly.
4. Do not log tokens, interaction webhook URLs, message bodies, private reward choices, player identifiers, or full Discord error objects. Log allowlisted error code/status and stage context only for new instrumentation.
5. Periodic recovery: report cycle totals at controlled volume; avoid an unconditional verbose log per unchanged reward every 15 seconds. Keep startup and periodic measurements distinguishable.
6. Baseline with synthetic fixtures of 0, 1, 10, and 100 pending rewards and controlled transport latency. Count operations, not only wall time. A production baseline requires separately approved deployment of instrumentation and read-only observation of a real startup; do not restart production solely to gather timings without approval.

Acceptance: tests show timing logs neither acknowledge work early nor swallow errors; all stages keep their current order. Report pre-ClientReady and post-ClientReady intervals separately.

### Phase B — One explicit scheduled reward sweep

1. Add a backward-compatible, named option to `recoverVaultSessions()` to skip its trailing reward sweep; default remains the existing combined behavior for standalone callers.
2. In the startup and periodic coordinators only, opt out of that inner sweep. Preserve this order:
   - recover pending roll deliveries and escapes;
   - recover mysteries, including required reveal acknowledgement;
   - recover vault sessions without the extra reward sweep;
   - materialize selected affection rewards;
   - reconcile/publish rewards once at the coordinator's final reward stage.
3. Keep direct publication at earning/settlement seams and mystery compensation calls unless tests establish a particular call is redundant. The acceptance target is one **explicit scheduled sweep**, not an unsupported promise that no nested reveal path ever publishes rewards.
4. Preserve the periodic non-overlap flag and startup-before-periodic behavior. No new concurrent recovery workers.
5. Test the actual coordinator seam with injected recovery functions or an appropriately narrow extracted helper, rather than relying solely on source-text assertions. Do not broaden refactoring beyond what is needed to exercise ordering and call counts.

Acceptance: default `recoverVaultSessions()` callers retain reward recovery; startup/periodic scheduled passes do not scan rewards twice; newly materialized affection rewards publish in the same cycle; reveal gates remain enforced.

### Phase C — Suppress unchanged canonical-card edits

1. Build a canonical comparison of the actual fetched Discord message and desired reward payload. Compare controlled content, embeds, Components V2 structure, flags as relevant to display mode, and all interactive control fields. Normalize builder objects versus API objects and omit irrelevant server-generated fields. Retain meaningful ordering, custom IDs, option values, disabled states, styles, links, and item presentation.
2. Use an authoritative fetch for the reward message (`force: true` where supported); a potentially stale client cache must not be treated as proof of current presentation. Continue verification on each scan in this phase. Lower-frequency fetches are a separate future proposal.
3. Scope no-op suppression to recovery/publication transport. Do **not** skip the first `interaction.update()`/reply merely because its payload matches: acknowledging a live interaction is mandatory.
4. Inside `withVaultWrite()`, read current reward state, prepare desired presentation, fetch/compare, edit only if different, and recheck committed state before acknowledging publication. If DB-only reconciliation changes presentation during an await, catch up to the newest state using the existing bounded-by-state-progress semantics; do not acknowledge an obsolete view.
5. After a verified no-op, still perform required lifecycle bookkeeping: pending Lens presentation acknowledgement, publication acknowledgement when missing, and decision/Recast timer scheduling. Avoid rewriting an already-recorded acknowledgement solely for metrics unless existing semantics require it.
6. A newly sent card can use its confirmed send response as presentation evidence, subject to canonical binding and latest-state rechecks. Preserve stable nonces and response-loss deduplication.
7. Missing canonical message (`10008`): recreate/rebind through the existing compare-and-bind mechanism. Old-card controls must become invalid. Transient fetch failures: defer without replacement, publication acknowledgement, grants, or outcome changes.
8. Preserve and separately verify source A/B/C disablement, historical same-message bindings, mention safety, guild discovery-dependent presentation, and overflow inventory-choice availability. Inventory contents can change the desired card even if the reward record is unchanged.
9. Do not narrow pending selection based only on `delivered_at`; that would lose deletion repair and pending decision/overflow/Recast recovery.

Acceptance: a second unchanged recovery scan performs verification but **zero reward-card edits/sends**, while stale cards, changed inventory options, new discovery presentation, deleted messages, and overdue decisions still repair correctly. No skipped live-interaction acknowledgements.

### Phase D — Deployment readiness budget and diagnostics (adjacent, separate commit)

This addresses false deployment failures, not recovery performance itself.

1. Replace the attempt-count assumption with a bounded, monotonic elapsed-time readiness budget of 300 seconds after service restart, including probe time. Retain five-second polling and at least 30 seconds of process stability before success. Account for bounded commands that can finish just after the deadline; do not promise a hard wall-clock bound tighter than subprocess timeouts.
2. Keep exact game-ready/new-PID/start-window checks, both service PID/restart checks, portal status/redirect/authentication checks, fail-closed behavior, and no automatic rollback.
3. On timeout, report that installation/restart completed but readiness was not verified, the installed SHA, elapsed time, stable/unstable state, and recovery-file path. Avoid misleading claims that no deployment occurred.
4. Extend `test/deploy.sh` with a virtual monotonic clock: mocked sleep advances elapsed time, journal readiness appears at a configured delay, and probes can consume time. Cover 152-second readiness success, over-budget/never-ready failure, PID changes, restart changes, and portal failure. Preserve all existing deployment safety tests.
5. Do not lower startup validation standards to make CI green. If measured startup exceeds 300 seconds, diagnose the stage rather than automatically increasing the budget again.

## 5. Regression matrix

| Case | Required result |
| --- | --- |
| Zero pending work | One scheduled sweep; no unnecessary transport |
| Ten unchanged overflow cards, repeated scan and DB reopen | Verify all; no duplicate grants/sends; second scan has zero reward-card edits |
| Same reward, changed inventory/replacement availability | Card updates correctly |
| Same reward, changed discovered-item presentation | Card updates correctly |
| Overdue Keep or presented Recast | Original outcome/deadline semantics; correct latest card and timers |
| Unacknowledged but already-correct card | Complete publication/Lens bookkeeping without unnecessary edit |
| Live interaction with identical payload | Interaction still acknowledged exactly once |
| Recovery queued behind user settlement | Latest settled state wins; no stale overwrite |
| DB reconciliation changes state during fetch/edit | Catch up before publication acknowledgement |
| Definitively deleted reward card | One replacement with canonical rebind; old card rejected; replacement settles once |
| Transient fetch/edit failure or inaccessible channel | No false deletion/rebinding or replay; later cycle repairs |
| Send succeeded but response lost | Stable nonce deduplicates; no second acquisition |
| Affection milestone, Echo, mystery consolation | Receipts and independent copies preserved; reveal-before-reward ordering retained |
| Historical same-message binding | Remains usable and safe |
| Standalone session recovery | Existing combined session/reward behavior preserved |
| Slow startup readiness at 152 s | Deployment passes only after real readiness and stability |
| Readiness never arrives / unstable PID / portal unhealthy | Deployment fails with accurate post-install diagnostics |

Primary suites: `test/vaultSessionRecovery.test.js`, `test/vaultRewards.test.js`, `test/paidVaultRecovery.test.js`, `test/fortuneRuntime.test.js`, `test/affectionRewards.test.js`, `test/affectionRuntimeIntegration.test.js`, `test/mysteryRuntimeRecovery.test.js`, `test/catalogRuntimeRestart.test.js`, `test/botBootstrap.test.js`, and `test/deploy.sh`.

## 6. Validation and evidence

- Add failing regression tests before each behavioral optimization; show their failure against the baseline.
- Run the focused suites after each phase, then `npm test`, `npm run typecheck:catalog`, `bash -n scripts/deploy.sh`, `bash test/deploy.sh`, and `git diff --check`.
- Compare synthetic operation counts before/after with fixed time/RNG and identical backlogs. Inject transport delay rather than depending on public Discord rate limits.
- Independent review should check stale-cache comparison, mandatory interaction acknowledgement, latest-state publication, reveal ordering, default caller compatibility, and readiness fail-closed behavior.
- Following separately approved rollout, verify installed SHA, stable PIDs/restart counters, portal auth probes, exact game-ready marker, stage timings, deferred-error counts, and recovery-cycle edit counts. Do not send artificial gameplay traffic or inspect secret-bearing logs.
- Success is fewer unnecessary operations with unchanged semantics; do not set an arbitrary startup-speed guarantee from one production sample.

## 7. Delivery boundaries and approval

Suggested reviewable commits: (1) timings/counters, (2) duplicate scheduled-sweep removal, (3) unchanged-card suppression and race/deletion regressions, (4) deployment readiness budget/test improvements. Keep the readiness commit independent so it can ship without waiting for transport optimization if approved.

No schema migration is planned. A source rollback must not restore old database snapshots or undo gameplay earned after rollout. Before rollback, assess compatibility and active sessions; use normal deployment safeguards.

Retained dependency backups (~998 MB at inspection) are an operational follow-up, **not part of this change**. Inventory retained deployment directories and establish retention/recovery requirements before any separately approved cleanup.

The user approved implementation after this plan was drafted. Pushing this branch or deploying/restarting production still requires separate approval. Existing unrelated working-tree files must remain out of plan/implementation commits.
