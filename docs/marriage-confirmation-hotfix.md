# Marriage confirmation latency hotfix

## Cause

The reaction handler committed ownership before force-fetching the roll message,
editing its presentation, and finally announcing the marriage. Its cache check
recognized embeds but not Components V2, so cached V2 cards still incurred a
Discord REST fetch. Slow card edits also delayed confirmation, including queued
escape-card refreshes.

Read-only VPS diagnosis against deployed commit `48a068c` found four matched
ordinary marriage announcements arriving 1.09–6.86 seconds after the stored
marriage timestamp. Card edits completed 0.64–6.43 seconds after that timestamp.
An isolated copy of the live database completed 12 successful claim logic
replays in a rollback transaction with a mean of 5.5 ms and maximum of 21.5 ms.
These replay timings exclude live commit/lock contention; production timestamps
show that the observed multi-second delay occurred after ownership was saved.
The diagnosis did not distinguish Discord processing, REST queuing, and network
latency within the card-update interval.

## Change

Start the independently error-handled marriage announcement immediately after
the successful claim, before awaiting any escape refresh or fetch/edit. Still
await both feedback paths before normal handler completion. Use cached embed or
Components V2 data when available; retain the fetch fallback for uncached cards.
Ownership, claim costs, announcement text/mention restrictions, report controls,
card accent updates, and serialized escape-card edits are unchanged.

## Regression coverage

`test/rollCommands.test.js` exercises the real reaction handler and SQLite claim
path with controllably blocked transport promises. It verifies confirmation
while fetch/edit is pending, cached V2 fetch avoidance, uncached fallback,
report-component preservation, and independent fetch/edit/send failures.
`test/characterEscapes.test.js` checks confirmation while an earlier public-card
edit remains blocked, while retaining the final married-card ordering assertion.

Validation uses Node 22.23.2: `npm test`, `npm run typecheck:catalog`,
`git diff --check`, `bash -n scripts/deploy.sh`, and `bash test/deploy.sh`.
No database migration or configuration change is required.
