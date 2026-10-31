# Phase 2 validation

Date: 2026-10-31. Branch: `feat/items-phase-2`. Implemented the approved design and plan, including the interview changes to passive Chit timing, direct item reward and removal of unavailable-prize-only compensation.

## Final results

- `npm test`: **1,445 passed, 0 failed, 1 skipped** (1,446 tests total), approximately 101 seconds. Final run after all production review fixes; local ignored log `phase2-final-tests.log`.
- `npm run typecheck:catalog`: **passed** after the review fixes.
- `git diff --check`: **passed**; Git emits only existing LF/CRLF conversion warnings.
- Initial focused baseline before implementation: **66 passed, 0 failed**.
- Final Chronicle/ownership/upgrade targeted checkpoint: **96 passed**.
- Chit review targeted suites: **174 passed**; expanded corruption/recovery suite: **105 passed**.

Tests use temporary/in-memory SQLite and fake Discord transport. No production database opened or migrated, no bot started, no live Discord actions, no remote push or PR.

## Coverage

- Token-aware claim eligibility with no side effects; genuine winner resolution versus losing Doors; saved once-only Chit outcome/cost and absence of later activation.
- Independent Chit tier weights, invalid draws, empty-pool safeguard, usable inventory restrictions, direct neutral reward/overflow and no vault modifiers.
- Character reveal acknowledgement before intentional winner ping; active/terminal acknowledgement corruption blocks preflight; terminal recovery does not redraw or re-award. Explicit reward-source collisions reject before vault reconciliation mutates sessions.
- Chronicle stable-ID former-owner selector, paging, strict per-kind controls, owner/guild/channel/canonical-message bindings, no eligible target/cancel/expiry/stale refusal, captured window and latest loss revalidation, fresh ownership, competing confirmations, rollback, file reopen and failed-announcement recovery.
- Nonempty normal claim allowances/events and Crown/Pinata/Ring/Double Date records stay byte-for-byte unchanged by a successful Chronicle.
- Final-v12 UUID history tests cover divorce, gifts, trades, theft, escape takeover versus current-owner reclaim, Blood Pact, Hostage exchange/gamble, Masquerade and Kaimetsu, including late-failure rollbacks and exact operation timestamps. Archived identities and guild isolation covered.
- Exact additive schema upgrade, no history backfill, conversion ordering, partial-schema refusal, dry-run rollback, source FK/uniqueness/nullability, nested savepoint rollback and idle clock checks.
- Portal registry/config validation, dynamic descriptions and configured charges; item-list standalone heading, mixed tiers, discovery masking, paging/filter/disabled render and text budget.

## Independent review fixes

1. Joined operation-clock scopes now use savepoints so caught failures cannot leave partial ownership/history writes committable.
2. Reward provenance primary keys explicitly reject NULL, preserving the intended reward FK invariant.
3. SQL milliseconds are rounded; fallback-clock tests compare against SQLite's clock rather than assuming identical V8/SQLite wall-clock precision on Windows.
4. Chronicle refuses unsupported history storage without a SQL exception or source hold. Item action controls accept only verbs produced for their action kind.
5. Activated Chit suppresses old pre-reveal announcement pings; the final direct reward still intentionally pings the winner after reveal.
6. Terminal paid reveal metadata is validated before skip logic, preventing silently stranded announcements.
7. Same-ID cross-source reward collisions fail closed; validated Chit provenance is excluded from legacy-vault ambiguity heuristics.
8. Existing Fortune test expectations account for the newly available Common reward alternative without changing Fortune behavior.

## Remaining limits

- Ownership losses before feature installation are intentionally unavailable.
- SQLite gameplay effects are transactional/idempotent, but Discord send-success/ack-loss can still duplicate presentation or a ping after nonce deduplication expires. It cannot duplicate costs or inventory awards.
- Live Discord rendering/delivery and production upgrade were not exercised. Follow normal backup/deployment practices; writable startup upgrades recognized exact predecessor schemas. Older binaries may reject the extended schema.
- One test was skipped by the suite's existing conditions; no skips were added to bypass failures.

Unrelated pre-existing glossary changes and local promotion/item-expansion/presentation documents remain uncommitted. Only the three Phase 2 glossary terms were staged from the mixed glossary diff.
