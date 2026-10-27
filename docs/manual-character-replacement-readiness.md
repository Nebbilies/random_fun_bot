# Manual-character replacement readiness

This is the pre-deployment readiness record. The later authorized deployment and current service/access details are recorded in [production deployment — 2026-10-27](./manual-character-deployment-2026-10-27.md).

The confirmed design and implementation plan remain authoritative. This record covers completion and verification on `feat/manual-character-catalog`; it is not a deployment approval or a commit record.

## Completion changes

- Retained the existing UUID catalog, ranking, source-link, franchise and portal architecture.
- Consolidated preview confirmation, retry binding, transactions, revision publication, audit and result persistence into `lib/catalogMutationProtocol.js`. Domain validation and effects remain in the three existing services.
- Reject timestamps beyond JavaScript's representable Date range consistently before creating previews or publishing changes.
- Removed full constraint-copy verification from known writable startup/conversion connections. Exact schema, native integrity, foreign keys, references and ranks remain checked. Read-only connections retain independent replay: a regression probe on the supported runtime demonstrated that native integrity checking can miss stored CHECK violations there. The public validator defaults to independent replay.
- Expanded real Chrome acceptance on both portal entry points for desktop admin and mobile-width moderator: rendered login/logout, create/search/edit, duplicates and reasoned overrides, stale input retention, double submission/exact retry, repositioning, source verification/conflicts/failures, and explicit likes-source adoption.
- Recorded integrated runtime recovery under its [separate acceptance scope](./runtime-recovery-acceptance.md).

## Verification so far

- Final local suite: **1,093 passed, one platform-dependent test skipped**; catalog type checking passed. The full isolated Linux suite passed 1,092 tests with one skipped; the final two-ID reconciliation extension separately passed all 18 safety tests on Linux and locally.
- Both independent standards and spec reviews found no actionable regression in the completion changes.
- Expanded Chrome matrix: all four entry-point/role scenarios passed. Source verification uses deterministic test responses; external images are blocked. This is viewport emulation, not physical-phone testing.
- Synthetic 10,000-character writable reopen: 149.989 ms in this local sample, compared with the prior recorded 2,369.354 ms. This is not a hosting guarantee.
- Linux deployment syntax and all six isolated deployment-safety fixtures passed. Shell scripts use LF, enforced by `.gitattributes`, so Windows-packaged source remains runnable in Bash.
- The originally supplied 2026-10-26 backup passed conversion rollback, committed disposable conversion, exact retained-table/reference checks, tied order, normal writable/read-only reopen, original-backup restore and manual-character gameplay smoke. It contains 15,000 characters, 492 ownership records and 27 wishes. Local measured conversion was 15.135 seconds; writable reopen was 1.128 seconds.

## Current-data rehearsal

The stopped VPS database contains newer writes than the supplied backup and retains a nonempty WAL. The older backup must not replace it. A fresh read-only SQLite backup including WAL was created at `/home/ubuntu/backups/replacement-rehearsal-tJMiTO/source.sqlite`; its SHA-256 is `b2e3f6d0e639e31f6ed86413ca2821d2d3d2a17a32fe8c54f2572d0fa3efb186`. It contains 499 ownership records and 27 wishes.

**Current-data rehearsal passed on the VPS under Node v22.23.2.** Its evidence is in `/home/ubuntu/backups/replacement-rehearsal-tJMiTO/verification-7tHnDo/verification.json`, with transaction evidence alongside it in `conversion.jsonl`.

- Restored the untouched fresh backup independently and verified it using the actual pre-conversion application code and Node v22.14.0. The restore retained all 499 ownership records and 27 wishes.
- Applied the existing ordinary escape-expiry API to expired roll 17379 on a disposable clone. Its outcome became `expired`; ownership, allowances and inventory remained byte-for-byte equivalent at the row level. The normal maintenance settlement then closed 61 expired ordinary claims and retained the determined overflow reward.
- After separate explicit human approval, abandoned vault prompts 17317 and 17358 without refunds or replacement rewards on another clone. Their rows/bindings remain preserved with external evidence in `abandonment.jsonl`. The earlier six approved IDs were already terminal in this fresh snapshot and were not modified by this operation.
- Verified rollback-only conversion leaves schema, rows and sequences unchanged. Committed conversion was performed only on a separately named working copy with a persisted drain gate.
- Verified all retained tables against the reconciled source, using the one identity mapping and reviewed historical JSON adapters. This includes all 15,000 character identities, 499 ownership records, 27 wishes, 13,166 tag decisions, 263 mystery-session records, 68 inventory entries and 175 vault-reward records. Exact tied ranks, likes, source references and sequence high-water marks were preserved.
- Normal writable/read-only opens passed. Runtime preflight reports zero blockers and one supported retained overflow reward. No Discord login or external delivery was attempted during rehearsal.
- On a further clone, manual creation, exact confirmation retry, search, marriage, wishing and gifting passed. No acceptance fixture was added to the pristine conversion artifact.
- Both the fresh source and reconciled input checksums remained unchanged after verification. No historical attribution was invented.

| VPS operation | Measured time |
| --- | ---: |
| Rollback conversion rehearsal | 113.094 s |
| Committed working-copy conversion | 133.467 s |
| Normal writable reopen | 10.007 s |
| Character-index load | 0.362 s |
| Normal read-only reopen with independent verification | 26.649 s |

These are measured single runs under hosting load. Allow a maintenance window of at least 10 minutes for a fresh conversion, verification, runtime selection and restart smoke checks; this includes a buffer beyond the measured conversion/open times. If cutover is deferred or any writer resumes, take a new consistent backup and revalidate its state instead of installing this older snapshot.

The pristine converted artifact is `/home/ubuntu/backups/replacement-rehearsal-tJMiTO/verification-7tHnDo/conversion.sqlite`. It retains the maintenance drain gate. `gameplay-smoke.sqlite` is deliberately separate and must never be installed as production data.

## Deployment boundary

The VPS service is stopped and remains on pre-conversion commit `432f107be7cfe8102c37ce399b6d1ae823b50f1f`. Its default Node is v22.14.0; v22.23.2 is already installed at `/home/ubuntu/.volta/tools/image/node/22.23.2/bin/node` and must be selected for replacement. Both portal accounts and the configured public origin were validated with the candidate without displaying credential material.

Source and test staging is outside the live checkout. Staging uses a credential-free bot configuration. The candidate is based on `b5724e37953a81144acf54c99d0e0b35fdb0049c` plus the reviewed uncommitted completion changes; the source archive and SHA-256 file manifest identify that overlay. The conversion CLI records the base commit, so retain the overlay manifest with its evidence rather than claiming the base commit alone contains these fixes.

**Ready for controlled cutover; not deployed.** No local commit, push, live conversion, service restart or traffic cutover has been performed. Preserve unrelated local glossary/item work, the VPS birthday/debt files, existing bot configuration and environment credentials. A cutover decision must select the reviewed code artifact, use the pristine converted database only after verifying the stopped source remains current, select Node v22.23.2, and perform startup/portal/Discord smoke checks before clearing the persisted drain gate. Retain the independent v10 restore, compatible old code/runtime and both untouched backups for rollback.
