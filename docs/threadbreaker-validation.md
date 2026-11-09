# Threadbreaker validation

Implemented on `feat/threadbreaker` on 2026-11-09.

- Full `npm test`: 1,765 passed, one skipped, zero failed (1,766 total).
- `npm run typecheck:catalog`: passed.
- `git diff --check`: passed.
- Focused tests cover descending chain traversal, same-owner survival stopping later owners, replay without rerolling, configured 0% and 100% behavior at confirmation, description emphasis and configured percentage, and three-second suspense/verdict ordering with the exact ending message.
- The existing configuration portal renders the new `itemEffects.threadbreaker.divorceChance` descriptor as a percentage; no separate route or UI is necessary. Default is 50%, with the existing inclusive 0–100% validation.
- Reveal progress persists the character index, stage, and message ID. Recovery uses committed verdicts; a long reveal runs independently of the recovery sweep with the existing per-action busy guard.
- No live Discord delivery was exercised. Discord sends can duplicate if the process fails after sending but before saving progress; gameplay and charge payment remain protected by the durable action boundary.
- Existing unrelated untracked documentation was preserved.
