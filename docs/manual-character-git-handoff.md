# Git and pipeline handoff after manual cutover

The manual v12 cutover is already complete. The subsequent Git/CI handoff publishes the reviewed release and aligns repository history with the running files. It must not repeat UUID conversion or reinstall a rehearsal database over current gameplay.

## Runtime and startup contract

- `package.json` pins Node **22.23.2** using the installed Volta project feature. Running the deploy script from `/home/ubuntu/random_fun_bot` therefore selects the correct Node even if the user's global default is 22.14.0. The bot's service-only executable pin remains compatible with the same version.
- Deployment accepts a deliberately inactive service as well as an active one. Failed, activating, deactivating or unknown states require investigation before code/dependency replacement.
- The bot emits `Character game ready.` after Discord readiness and supported durable recovery, immediately after game ingress is enabled.
- Deployment checks that marker against the newly started service PID and restart time, with stable PID/restart checks for at least 30 seconds. Readiness has a 60-second observation window. A running process without the marker cannot produce a successful deployment result.
- The deployment account must be able to read the service journal. Lack of journal access is reported as a readiness failure rather than silently claiming success.

## Repository reconciliation

1. Commit and push only reviewed release-related changes on the approved feature branch. Keep unrelated glossary and item-design work uncommitted.
2. Require the branch's full CI, catalog type check and isolated deployment-safety checks to pass before promotion.
3. Preserve the live source overlay separately and record any additional VPS edits before reconciling Git. Preserve staged birthdays, untracked/ignored runtime data, credentials and the live v12 database.
4. Keep the combined Check and deploy workflow disabled across the merge. CI must finish on the PR before disabling it again; merging must not invoke the deployment script.
5. Align repository history separately from live file installation. Preserve the source overlay and use a temporary Git index to verify exactly which source files differ before any selective source reconciliation. Never reset or clean `data/`, credentials or unrelated files. Do not touch the live database or its WAL/SHM sidecars.
6. This one-time Git alignment is not a deployment: do not run `scripts/deploy.sh`, stop or restart services, replace dependencies, change maintenance mode, or reapply conversion artifacts. Additional pipeline-only source changes may remain documented as not loaded by the current process until a separately approved deployment. Record the resulting commit and remaining file differences, and verify service PID/start time and database state remain unchanged.

The paragraph above describes the original one-time handoff. The user subsequently authorized coordinated bot and portal restarts on deployment. The portal is now managed by `random-fun-bot-portal.service`; CI must preflight and stop both services before replacing code/dependencies, then restart and verify both. Do not kill screen sessions or unrelated portal processes. If another process owns the portal listener, investigate rather than claiming a successful deployment. Runtime data, credentials, and the current database remain outside source reconciliation; never restore an older snapshot to make deployment pass.

## Verification

Existing fixtures cover runtime-data preservation, dependency-install failure, stale queued deployments, dirty-code refusal and competing deployment locks. Additional fixtures cover deliberately stopped services, unexpectedly failed services and missing Discord/game readiness. The real VPS project runtime and started-service journal are checked during the handoff.
