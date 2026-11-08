# Startup recovery efficiency — implementation and validation

Branch: `fix/startup-recovery-efficiency`. Implements the approved [plan](./startup-recovery-efficiency-plan.md). No production access, service restart, migration, dependency cleanup, or branch push was performed during implementation.

## Changes

### Startup and scheduled recovery

`lib/gameRecovery.js` is the ordered startup/periodic coordinator. Startup-only Binoculars and item-action recovery remain first; roll deliveries, escapes, mystery reveals, vault sessions, affection materialization, reward publication, and item cleanup retain their order. Vault-session recovery opts out of its internal trailing reward sweep; the coordinator performs one explicit final sweep. Standalone `recoverVaultSessions()` retains combined recovery by default.

`index.js` keeps ingress gated until the coordinator and search preparation finish. The exact `Character game ready.` marker is unchanged. The periodic callback still does not overlap, including after a failure.

### Observability

`lib/recoveryObservation.js` emits structured JSON with scope `game-recovery`, correlation ID, mode, stage, event, and monotonic elapsed time. Startup logs stage start/finish/failure for catalog open, restart validation, runtime detachment, Discord login-to-ClientReady, each recovery stage, and cache preparation. `post-client-ready` measures recovery as a group; `cycle-finish` includes total process-start observation time and all stage durations. It does not measure time spent loading static ES modules before observation begins.

New telemetry accepts only allowlisted aggregate numeric counts and error code/status; no reward bodies, guild/player IDs, interaction URLs, or error messages/stacks. Instrumentation failures cannot swallow or create recovery success/failure.

Periodic stage timings are collected quietly; a heartbeat emits at most every five minutes unless deferred deliveries occur. Heartbeat `counts` accumulate **all completed cycles** since the previous report; `interval` identifies cycle count and interval elapsed time. `elapsedMs` and `stages` describe the latest cycle, not the whole interval. A failed cycle reports its failing stage but is not counted as a completed cycle.

Counter semantics:

- Attempts: `channelFetches`, `sourceFetches`, `sourceSends`, `sourceEdits`, `rewardFetches`, `rewardSends`, `rewardEdits`.
- `candidates`: session plus reward candidates inspected by explicitly instrumented vault passes.
- Outcomes: `rewardUnchanged` (existing verified card required no edit), `gated` (reveal gate prevented publication), `missing` (canonical reward fetch returned 10008), `rebindings` (successful deleted-card replacement), `deferred` (transport/recovery attempt failed or canonical binding changed).
- Absent keys mean zero. Nested publication from other reveal/earning seams is not falsely counted as part of the explicit scheduled sweep.

### Presentation verification

Canonical reward recovery force-fetches Discord messages instead of trusting client cache. `lib/rewardPresentation.js` compares controlled display fields while normalizing builder/API object differences, server-assigned component IDs, and equivalent defaults. It retains meaningful controls, options, disabled states, styles, links, flags, and text.

Verified unchanged cards skip edits but retain publication/Lens bookkeeping and decision timers. A confirmed new send can supply presentation evidence without a redundant immediate edit. Stale content/embeds are explicitly cleared when repairing a Components V2 card. Source-card controls are inspected separately because attachment URLs resolve to CDN URLs after publication.

Per-vault write serialization and latest-state catch-up remain intact. Both successful fetches and deletion responses are checked against canonical-binding changes; old deletion evidence cannot replace a newer live card. Transient fetch failures do not authorize replacement. Stable publication nonces and reveal-before-reward gates remain unchanged. Live interactions still receive their mandatory acknowledgement even for identical payloads.

### Deployment readiness

`scripts/deploy.sh` uses Linux monotonic uptime with a 300-second budget after restart commands complete. Five-second polling and a minimum 30 seconds of stable observed PIDs/restart counters remain required, alongside exact game readiness and portal auth/status probes. Probe work counts against the budget; bounded subprocess work can finish after the deadline but cannot make a late verification pass.

Failures report that installation/restarts completed, installed SHA, elapsed budget, process stability, last readiness observations, and retained recovery files. There is no automatic rollback or relaxation of safety guards.

## Test evidence

- Coordinator/observation tests exercise held recovery, preserved stage order, single scheduled sweep, startup-only operations, failure propagation, safe timing logs, logger failures, and periodic accumulated counters.
- Bootstrap integration executes the actual startup/periodic callback fragments without a Discord client: readiness stays false until recovery/cache completion; concurrent periodic ticks skip; the guard releases after failure.
- Reward efficiency fixtures use final-schema temporary databases, fixed outcomes, controlled asynchronous transport turns, REST-shaped defaults, and reopened databases. For 0, 1, 10, and 100 overflow rewards, the verified second scan performs **0 sends and 0 edits**, with respectively 0, 1, 10, and 100 canonical reward fetches. Fetch reduction is intentionally not claimed.
- A differential run loaded the unchanged `c126693` vault runtime from Git alongside current code, using identical in-memory final catalogs and one `setImmediate` transport turn per fetch/edit. For 1/10/100 rewards, baseline first publication performed 1/10/100 sends **plus** 1/10/100 edits; current publication performed the same sends and **zero edits**. Baseline unchanged second scans performed 1/10/100 fetches and edits; current scans performed the same fetches and **zero edits**. Both versions performed zero operations for an empty backlog. This isolates operation savings without claiming production wall-clock latency.
- Reward regressions cover mandatory interaction acknowledgements, independent inventory/discovery invalidation, stale cached cards, definitive deletion/rebinding/old-card rejection, transient failures, overdue Keep, recovery behind settlement, binding changes on success and 10008, response-loss nonces, source control suppression with Discord wrappers/CDN data, historical same-message binding, and consolation reveal gating. Existing Fortune/affection/restart suites retain lifecycle coverage.
- Shell virtual-clock fixtures cover readiness at 152 seconds, never/late readiness, portal/auth failures, PID/restart instability, probe costs beyond budget, minimum elapsed stability, dirty source/runtime-data safety, and retained post-install recovery files.
- Independent reviews found and resolved heartbeat count loss, stale content/embed clearing, source attachment comparison, and canonical-rebinding races. Final review reported no actionable findings.

Final JavaScript validation: `npm test` — **1,809 passed, 1 skipped, 0 failed** (1,810 total); `npm run typecheck:catalog` — passed. Focused component normalization, coordinator, bootstrap, and reward efficiency regressions also passed. `bash -n scripts/deploy.sh`, `bash -n test/deploy.sh`, and `git diff --check` passed. The deployment implementer ran `bash test/deploy.sh` to completion successfully under Git Bash. A parent repeat independently passed delayed-readiness, budget/probe-cost, stability-duration, install/data-preservation, and never-ready cases, but was stopped after more than seven minutes of Windows process-spawn overhead; it is not counted as another complete shell-suite pass.

Production startup performance remains unmeasured for this implementation; observe the new stage logs during a separately approved rollout before attributing the incident to a particular stage or promising a speedup.
