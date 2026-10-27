# Fortune startup contention — deployment incident

## Observed failure

GitHub deployment run `40554317142` passed its check job and failed the deploy stability guard after installing merged release `b7fafad`.

VPS journal identified the immediate cause:

```text
Error: database is locked
  at upgradeFortuneCatalog (.../lib/vaultFortuneUpgrade.js:15)
  at ensureFortuneCatalog
  at openCatalog
```

The bot and portal start together. The portal started successfully; the bot's `BEGIN IMMEDIATE` exceeded its five-second default wait. This caused one systemd restart, which the deployment guard correctly rejected as instability. The production journal subsequently reported `Character game ready.`; both services were active and portal `/login` returned HTTP 200. Read-only inspection was used; no service restart, live migration, database reset or rollback was performed by the agent.

## Fix scope

Routine additive schema migration remains automatic. The fix gives concurrent writable starts a migration-specific wait of at least 60 seconds, while preserving longer caller timeout policy, restoring the original timeout afterward, and rechecking schema after acquiring the lock. This addresses the reproduced five-second failure, but is not a measured upper bound on production validation time or total startup duration. It does not waive unknown-schema validation, retry arbitrary application writes, or weaken the deployment health guard.

The regression holds a real migration write lock for 5.5 seconds and exercises the actual migration service with zero- and five-second connection policies. Prior concurrency coverage released its lock after 50 milliseconds and therefore missed this incident. Existing normal/strict writable opening tests cover startup integration.

Verification: 13 migration tests passed; full suite 1,180 passed, 1 skipped, 0 failed; catalog typecheck passed. Independent review approved the narrow fix. No deployment health checks were relaxed; near-limit contention could still exhaust the separate readiness budget and requires investigation rather than falsely reporting success.
