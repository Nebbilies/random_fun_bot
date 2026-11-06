# Affection production repair — 2026-11-06

## Incident and cause

After an own-character appearance earned 100 affection and three normal milestone items, subsequent character rolls failed before reservation with:

> Invalid legacy vault abandonment evidence: Vault has reward evidence or ambiguous same-channel reward

The live database contained two historically abandoned vault rolls and three new affection milestone rewards in the same channel. Direct milestone rewards intentionally have no source message. The historical abandonment validator recognized mystery consolation provenance, but not affection milestone or Echo provenance, and therefore treated the new rewards as ambiguous historical vault evidence. Every roll runs that validator during cleanup. The same problem also blocked restart readiness.

Production timestamps showed the three milestone reward announcements arrived approximately 26.5–29 seconds after creation. Own-character delivery committed the items immediately but left their announcements to the periodic recovery cycle, which runs every 15 seconds after other recovery work.

## Changes

- `lib/legacyVaultAbandonment.js`: recognize affection milestone and Echo rewards only after the existing full source/grant/copy/outcome validator verifies their provenance. Preserve exact historical evidence checks, real message-token collision checks, and failure on missing or corrupt provenance.
- `lib/vaultRuntime.js`: expose the existing queued reward-publishing loop for reuse without running a global reconciliation scan.
- `lib/rollDelivery.js`: publish committed own-character milestone rewards immediately after affection feedback. Failed announcements remain recoverable. Other roll types retain their existing path so reward I/O cannot delay claim reactions or Golden Whistle handling.
- Regression tests cover actual own-character earning, subsequent rolls, restart readiness, Echo provenance, corrupt/missing provenance, historical token collisions, immediate reward announcements, retry idempotence, and partial transport failure.

No schema changes, manual data repairs, reward reissues, or database rollbacks were required.

## Verification

- Before the fix, the focused synthetic own-character regression failed with the exact production exception.
- Before the announcement fix, the synthetic live-delivery regression sent one card instead of the expected character card plus three reward cards.
- Full local suite: 1,680 tests, 1,679 passed, zero failed, one existing skip, under Node v24.19.0.
- Isolated VPS staging suite under production Node v22.23.2: 62 focused tests passed. Staging tests used synthetic databases, not production data.
- Catalog type checking and `git diff --check` passed.
- Patched historical validator read the live database in read-only mode: two historical vaults validated, zero blockers.
- Full live read-only restart preflight passed before both service restarts.
- The user confirmed `!w` worked after the cleanup repair.
- Immediate announcement behavior is covered by regression tests; a new real Discord milestone remains a separate live acceptance observation.

## Deployment and source status

The user authorized VPS diagnosis and production actions for this session. Both initial repairs were installed directly over SSH and activated by restarting `random-fun-bot.service`, based on main commit `f5b0ad8`. At that point nothing was committed or pushed.

The user subsequently requested the UI changes below, a local commit containing both the original repairs and UI changes, and reconciliation of the VPS checkout. That commit is transferred to the VPS through a Git bundle, without pushing to origin. Only the known hotfix file changes are backed up and replaced during the fast-forward; unrelated data, environment files, and existing local documents are preserved. Both checkouts should then identify the same local commit, with no tracked code changes blocking the normal deployment script. Origin remains unchanged until a separate push.

The first repair's original validator backup is `/tmp/random-fun-legacyVaultAbandonment-before-20261106.js` on the VPS. The second installation's backups are under `/tmp/random-fun-affection-before-reward-fix-fhvRjY`; that backup already includes the cleanup repair. The uploaded source/test bundle is `/tmp/random-fun-affection-hotfix-20261106.tar`. Temporary-directory backups may not survive machine cleanup or reboot.

Existing unrelated local documents and production data were preserved. SSH host verification remained enabled. A temporary SSH-compatible copy of the authorized PuTTY key was used without displaying private key contents and removed after the session's production checks.

## UI follow-up

Own-character cards display `❤️ An appearance from your harem` without the redundant claim instruction. Affection feedback uses separate lines: `❤️ **+100** affection` and, when applicable, `**3** normal milestones **unlocked**`. The character name and running affection total are omitted from this feedback; a short Soulmate label distinguishes an award for a different character. Mystery reveals reuse the same format. The redundant character-name footer was also removed from roll cards; the title remains.

The actual own-character delivery regression verifies the appearance line, multiline feedback, absence of the old claim instruction and running total, and a single character-name occurrence.
