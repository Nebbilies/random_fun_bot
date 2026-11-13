# Threadbreaker dialog search

## Behavior

- Search franchises opens a Discord modal from the current confirmation message.
- Submit 2–100 characters to filter names and aliases through the existing matcher.
- Submitting a query or using Clear search resets the page and selected franchise. A fresh selection is required before confirmation.
- Empty results retain Search franchises, Clear search and Cancel, so the command does not need to restart.
- Search is available after selecting a franchise as well as while browsing. Clear search is disabled when there is no active query.
- Existing holder, guild, channel, message, expiry and busy checks remain in force. Each opened modal has a saved interaction ID and source-message binding; a newer modal, cleared search, rebound message or terminal/expired action invalidates the old submission.
- Opening a modal does not hold the per-action busy lock while the user types. Queries run on submission rather than on keystrokes.
- Search state uses the existing durable action JSON; no new schema or dependencies are required.

## Cache

Bot startup and item dialogs use the same `getCatalogCache(db)` instance per open database. The underlying existing cache checks durable revisions and rebuilds its prepared search indices when the catalog changes. This avoids a second full index and repeated alias normalization in the dialog. No per-query cache accumulates user inputs.

## Validation

- Full suite: 1,850 passed, one skipped, zero failed (1,851 total).
- Catalog type checking and `git diff --check`: passed.
- Focused interaction coverage includes alias search, pagination, clear/reset, no matches, old-modal rejection, foreign users, expired actions, missing modal message metadata, invalid query lengths and unchanged inventory.
- Shared-cache coverage verifies object reuse and catalog-revision invalidation; startup and identity snapshot checks passed.
- Independently exercised the production handlers against a disposable version-12 UUID-schema database with 10,000 synthetic franchises. Verified serialized modal bounds, alias filtering, selecting a result, clearing back to the full catalog, no item charge spent, no ownership changes, and reuse of the startup snapshot.
- Synthetic local timings: cold snapshot load 24.83 ms; warm cache access 0.124 ms on average across 100 accesses; exact search 1.19 ms; alias search 0.58 ms; typo search 16.93 ms; no-match search 11.75 ms. These are observations on this machine, not production limits or comprehensive load testing.
- Discord delivery was recorded locally; no live server messages were sent. Live Discord client rendering and network permissions remain unverified.
