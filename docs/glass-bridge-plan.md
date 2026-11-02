# Glass Bridge implementation plan

1. Add behavioral tests and a Glass Bridge event module for entry, public revisions, step outcomes, solo play and ties.
2. Integrate saved state, rolling deadlines, interaction routing and public cards with the existing coordinator and runtime. Preserve existing events' deadlines and restart recovery.
3. Add per-server enablement, weight and timing defaults to configuration and the review portal, retaining compatibility with existing settings.
4. Test the prize flow, missed inputs, late interactions, restarts, concurrent choices and games exceeding three minutes. Run focused and required project checks.

Author review: changing rolling deadlines requires atomic persistence with each step and an explicit bounded recovery guard; public list updates must preserve Discord component limits and avoid pings.

Implementation review: the event uses the existing versioned session snapshot, queued button handling, recovery bindings and claim/consolation flow. The deadline extension and state update share one compare-and-swap transaction. Configuration is exposed by the existing registry-driven portal. No dependencies or database schema changes are needed.

Verification observes behavior through the event module, coordinator and Discord runtime. New tests do not assert configurable timing or weight values. Coverage includes public revisions, locked entry, elimination, no-winner and solo outcomes, missed-choice tiebreaks, result display, database reopen, play beyond the old ceiling, runtime recovery and protected prize publication.

## Verification completed

- Full project test suite: 1,488 passed, one skipped, zero failures.
- Catalog TypeScript check and git diff whitespace check passed.
- Deployment script syntax and isolated deployment safety fixtures passed.
- Discord interactions were exercised through the existing runtime fixtures; no live Discord event or VPS deployment was performed.
