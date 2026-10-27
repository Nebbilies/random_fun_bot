# Manual-character production deployment — 2026-10-27

The user explicitly approved deployment and startup after reviewing the replacement-readiness evidence. The initial deployment completed without commits or pushes. The bot started under Node v22.23.2; game maintenance was cleared at approximately **16:22 Asia/Saigon**. The user subsequently took over portal startup and authorized the Git/CI handoff described in [Git and pipeline handoff](./manual-character-git-handoff.md).

## Installed release

- Local branch: `feat/manual-character-catalog`.
- Candidate base: `b5724e37953a81144acf54c99d0e0b35fdb0049c`, plus the reviewed uncommitted completion changes.
- Source archive SHA-256: `b7b77a95f1492d468deb4aac7f75a30448d18162e7df6a2aa648ad57e9e9b672`.
- Source manifest SHA-256: `2539c1adfec1ab3bac2520e5c46389dc8c9f3998082082e3566cd525b0f673e6`.
- Every installed candidate file was checked against the manifest. The archive's disposable verification fixture under `data/` was excluded from production installation.
- The final consistent cutover backup exactly matched the rehearsed fresh snapshot: `b2e3f6d0e639e31f6ed86413ca2821d2d3d2a17a32fe8c54f2572d0fa3efb186`.
- Installed database schema: authoritative v12. Before game ingress resumed, checks retained 15,000 characters, 499 ownership records, 27 wishes, 13,166 tag decisions and 68 inventory entries. The runtime guard reported no blockers.

The verified reconciliations were carried forward: ordinary expired escape 17379 kept its owner/costs, 61 expired ordinary claims closed, and only approved current-snapshot vaults 17317 and 17358 were abandoned without compensation. The pending determined overflow reward was preserved for its supported recovery path.

## Services and access

- `random-fun-bot.service` runs the installed bot. `/etc/systemd/system/random-fun-bot.service.d/50-catalog-runtime.conf` pins its executable to `/home/ubuntu/.volta/tools/image/node/22.23.2/bin/node`.
- `random-fun-bot-portal.service` initially ran the authenticated portal privately, then was stopped for manual portal operation. On the subsequent pipeline-repair inspection it was already active again and was the sole portal process listening on **127.0.0.1:25565**. The user has now authorized restarting this service alongside the bot during deployment. Screen session `1418464.web_run` is not the current portal process owner; deployment must not terminate unrelated screen sessions.
- The VPS's global/default Node remains v22.14.0. Other applications were not moved to a new runtime.
- The previous public HTTP portal process was stopped before database replacement. Password authentication is now reached through encrypted SSH forwarding rather than exposed public HTTP.
- The local SSH tunnel created for initial verification was released. Current portal exposure is managed by the user. The tunnel command below remains an option only if a private VPS listener is running.
- Portal credentials, bot configuration, service-account credentials, birthdays, debt data and landmine settings were preserved during source installation. Portal authentication loaded the existing environment settings.
- AniList source verification retains its explicit server permission gate; no source permission was invented and no import was run during deployment.

To recreate the private tunnel from PowerShell if the current connection closes:

```powershell
& 'C:\Windows\System32\OpenSSH\ssh.exe' -N -T `
  -L '127.0.0.1:25565:127.0.0.1:25565' `
  -o BatchMode=yes -o StrictHostKeyChecking=yes -o ExitOnForwardFailure=yes `
  -i (Join-Path $env:USERPROFILE '.ssh/id_rsa') ubuntu@138.2.90.168
```

## Health and verification

Before resuming traffic, both services were active with stable process IDs and zero restarts. The service executable paths were verified as Node v22.23.2. Discord ClientReady and utility-command registration were observed, with no startup error messages. No artificial test messages were posted to Discord.

The real portal returned login HTML, redirected an anonymous catalog-page request to login, and rejected an anonymous API request with 401. The same checks passed through the local encrypted tunnel. Rendered role/workflow acceptance was already covered by the four real Chrome scenarios recorded in the readiness report.

The final local regression suite passed 1,093 tests with one platform-permission skip; type checking passed. Linux full-suite, final bounded-reconciliation tests and deployment-safety fixtures passed during staging. Independent standards/spec/safety review found no actionable blocker.

## Evidence and rollback boundary

Private evidence root: `/home/ubuntu/backups/replacement-rehearsal-tJMiTO/cutover-Tkeq4g`.

This includes the final untouched source snapshot, original database and any remaining SQLite sidecars, original source archive, introduced-file list, original service definition, preserved credential/configuration copies, installation checksums, prestart checks and startup observations. The earlier independent v10 restore and both original backups remain available in the parent rehearsal/backup directories. Protect these artifacts as sensitive.

**Traffic has resumed. Do not overwrite the live database with the old backup without reviewing newer writes.** A rollback now requires stopping both services and reconciling any post-cutover gameplay. Restore compatible old code/runtime and a whole consistent database together; do not attempt a generic UUID downgrade or delete rows to bypass guards.

At the initial deployment, the VPS Git checkout retained its original base commit with the source overlay as working-tree changes. The user subsequently authorized publishing the completion changes and reconciling that checkout. Preserve the original overlay backup and runtime data during this handoff; do not overwrite the database or apply a blanket reset to make CI pass.
