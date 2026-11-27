# Configurable affection gains

Status: Phase 2 approved by the user.

## Portal settings

Add an **Affection** section to Configuration. Use the existing global defaults, per-server overrides, inheritance, and review-before-save flow.

| Base award                                        | Default |
| ------------------------------------------------- | ------: |
| Roll a character you own                          |     100 |
| Shared main franchise with 2–5 characters         |      12 |
| Shared main franchise with 6–10 characters        |      10 |
| Shared main franchise with at least 11 characters |       5 |
| Reclaim your escaping character                   |      20 |
| Another owner reclaims a character you rolled     |       5 |

Allow whole numbers from 0 through 2,100. Keep the existing main-franchise size boundaries and use the lowest configured value among all matching franchises, including zero. A zero result earns no related affection. Zero also disables either reclaim award or the own-character appearance award. When two appearance rules target the same character, award the higher applicable value once. Keep the existing Unbroken Bond and Weekly Event calculations, milestones, perks, and 2,100 per-character cap.

## When changes apply

Capture the effective appearance values when a roll is reserved and use those values when its appearance award settles. A reclaim uses the effective values when it succeeds, alongside the existing ownership and soulmate checks. Replaying an award returns its original receipt. Keep historical appearance snapshots on their saved earning rules, including the old genre rule, and keep historical base-8 roller reclaim receipts intact.

Resolving appearance values at delivery would let a portal change affect an already reserved roll. Capturing the values with its existing eligibility snapshot preserves the offer through retries and restart. Reclaims already determine eligibility when they succeed, so save their actual base with the awarded receipt.

## Catalog migration and verification

The existing SQLite award table accepts only the old base values and caps a single earned award at 200. The current +100 own-character award can reach 260 with Unbroken Bond and the Weekly Event prize. Change the authoritative award schema to accept configurable bases and actual gains up to the existing character cap. Use the existing catalog migration lock and preserve award row IDs, receipts, season tracking, and the current-season view. Accept the exact predecessor schema during upgrade. Version new appearance snapshot data so startup validation can check each award against its captured values and still read old snapshots.

Verify every portal value, override and reset, a disabled source, an in-flight roll, a reclaim under the new settings, and replay under a different configuration. Verify migration on a disposable existing catalog and test a combined Bond and Weekly Event award above the old single-award limit.

## Phase 2 self-review

Checked this proposal against the existing [configuration registry](../lib/gameConfigSchema.js), [appearance and reclaim writers](../lib/characterAffection.js), [saved snapshot validation](../lib/affectionSnapshot.js), and [award table constraints](../lib/affectionSchema.js). Six editable amounts cover the requested base gains. A portal edit requires no immediate change to saved scores, milestones, or in-flight appearance awards.
