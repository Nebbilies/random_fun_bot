# Double Date free-claim hotfix

Implemented on `feat/items-phase-2`, 2026-10-31.

## Corrected behavior

Default activation grants two free claims for ten minutes. Free claims bypass an existing normal cooldown and are consumed before Crown/Piñata tokens. They do not spend/reset the normal allowance or cooldown, consume Ring charges, or spend other claim tokens. Failed or rolled-back claims spend nothing. Both the count (`itemEffects.double_date.freeClaims`, default 2) and duration (`itemEffects.double_date.durationMs`, default 600000) are portal-configurable and captured at activation. Shared buff stacking rules remain unchanged.

Descriptions and activation feedback explicitly explain free claims, expiry, cooldown bypass and priority. Mystery winner eligibility includes usable Double Date, so Chit is not spent while a free claim is available.

Legacy timed Double Date entries had no counter. Their first successful claim initializes the saved free-claim count, falling back to two, then spends one atomically; inspection does not mutate them or extend their saved deadline.

## Cause and regression evidence

The old eligibility gate omitted Double Date, activation stored a null use counter, and consumption prioritized Crown over Double Date. The new actual claim-flow regression test failed before the fix on cooldown bypass and token priority. It passes after the fix.

- Focused eight-suite run: 100 passed.
- Independent review: no confirmed correctness findings; subsequent tests added Ring preservation, late rollback, Double Date mystery/Chit interaction and snapshot-field compatibility.
- Full suite at production-code completion: 1452 passed, 0 failed, 1 skipped. Additional test-only assertions afterward: 54 passed across Double Date, mystery and snapshot suites.
- `npm run typecheck:catalog`: passed.
- `git diff --check`: passed (line-ending warnings only).

No live database migration, bot startup or Discord action performed. No schema migration is needed; the existing persisted buff counter supplies the new entitlement.
