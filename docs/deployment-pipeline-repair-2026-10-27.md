# Deployment pipeline repair — 2026-10-27

## Observed failures

GitHub run `40509576152` initially failed before downtime because the VPS checkout had an unstaged, older `GLOSSARY.md`. The modification was preserved under `/home/ubuntu/backups/deploy-dirty-glossary.ml2ypSbZ` before selectively restoring that file from HEAD. Staged birthdays and untracked runtime data were left untouched; the deployment dirty-code guard remains enabled.

The retried deployment fast-forwarded production to `3161b42` (PR #26) but the restarted bot failed its catalog recovery guard. Both approved legacy abandoned-vault rows, `17317` and `17358`, were absent. `cleanupRolls` could delete these aged `vault` rows after report expiry even though the durable abandonment contract requires their original exact bindings on every restart.

## Narrow recovery

The bot was stopped to halt its crash loop. The original rows in the cutover's `latest-source.sqlite` were compared to the live abandonment contract: both snapshots and recreated fingerprints matched exactly, and there were no live ID/command conflicts. A consistent live SQLite backup was made under `/home/ubuntu/backups/vault-evidence-repair-1793111622840` before restoring only those two historical rows in a transaction. No ownership, wishes, rewards, character records, or current roll outcomes were replaced. The unchanged restart guard then reported ready.

The cleanup fix was applied as a narrow production source patch before restarting: cleanup validates abandonment evidence before any deletion, preserves validated bound IDs, and fails closed on invalid evidence. Patch retained at `/home/ubuntu/backups/vault-cleanup-fix.kTbJQ9Qq.patch`. This intentional source overlay must be reconciled to the identical committed version before the next automatic deploy; do not remove the fix while the bot is running.

## Portal and verification

The portal was already owned by `random-fun-bot-portal.service`, with Node v22.23.2 listening on `127.0.0.1:25565`. The `1418464.web_run` screen session was not the portal process owner and was not terminated. Existing service public-origin configuration was preserved.

Both services were restarted after recovery. Verification observed bot `Character game ready.`, both services active with zero restarts, and anonymous loopback portal responses: `/login` 200, `/catalog` 303 to `/login`, `/api/status` 401. No authenticated credentials or response bodies are needed for these readiness checks.

## Pipeline changes

- Preflight stop/restart permissions and acceptable states for both services.
- Install dependencies before downtime; run the existing catalog restart guard read-only before stopping services.
- Stop both services before code/dependency replacement and restart both afterwards.
- Require stable PIDs/restart counters for both, bot Discord/game readiness, and bounded anonymous portal HTTP/auth checks.
- Retain all dirty-source, incoming-runtime-data, exact-SHA, locking, and fast-forward safeguards.
- Never automatically repair or waive catalog recovery blockers; historical recovery above was separately investigated against external evidence.
