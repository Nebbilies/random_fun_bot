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

## Independent runtime and browser walkthrough

Repeated validation without using the test suite, against a fresh version-12 database with UUID character identities and directly curated franchise membership. Used the production management server, Chrome, prefix activation, component interaction router, and durable delivery entry point.

- Browser displays a 50% default.
- Browser bounds are 0â€“100 percent.
- Browser save persists 27.5% as 0.275.
- Browser reload restores saved percentage.
- Item description reflects saved percentage.
- Configuration page has no JavaScript errors.
- Prefix activation reserves a confirmation action.
- Franchise selection persists through the interaction handler.
- Confirmation commits exactly two visited characters.
- Locked rank 3 is skipped and rank 2 compares against original owner of rank 4.
- Only rank 4 is divorced; survivor, protected character, and later owner remain married.
- Successful activation spends its charge.
- Interrupted delivery leaves a durable pending verdict.
- Database reopen resumes delivery without applying the new 100% setting.
- Final message is exactly the requested chain ending.
- No unvisited character card is delivered.
- Real three-second waits exercised; Discord transport was local, not a live server.

Found and corrected a portal display precision issue: saving 27.5% previously reloaded as 27.500000000000004%. The repeated browser walkthrough now displays exactly 27.5%. No page JavaScript errors occurred.

The production Discord handlers were exercised with a local transport recorder; no real server messages or ownership were changed. This validates application behavior and serialized component output, not Discord network permissions or acceptance. Separate-message crash duplication remains the documented presentation limit.
