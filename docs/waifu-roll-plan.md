# Waifu roll implementation plan

Status: Phase 3 complete and author self-review approved. User approved Phases 4–6, separate commits, and a final push.

Approved design: [waifu-roll-design.md](waifu-roll-design.md).

## Scope and safeguards

Implement only the agreed `w`/`h` rolls and heart-based claims. Use existing prefixes, SQLite, image selection, report storage, marriage ownership, and Discord Components V2. No new dependencies, slash commands, or live bot deployment. The user later authorized commits and a final push.

Preserve existing working-tree changes. Commit only this task's files. Use temporary databases and mocked Discord APIs for development. Do not open the live database through the migrating writer or use it as a test fixture. Before a later live upgrade, back up the database using a SQLite-consistent backup.

## Phase 4: Simple TDD

First run the existing relevant tests and type check to establish a baseline. Record existing failures separately. For each behavior group below, add focused failing tests, observe the intended failure, then implement that group in Phase 5. Missing-module failures alone do not prove behavior: establish the smallest interface needed to reach meaningful assertions.

### Storage and rules tests

Add `test/characterRolls.test.js` using the existing temporary SQLite fixture pattern, an injected clock, and controlled random selection.

1. Upgrade a version-4 fixture with characters, marriages, prefixes, and reports to version 5 without changing existing data. Reopening is idempotent; unsupported future versions still fail. Test migration failure rollback.
2. Verify female/male pools and inclusion of other, blank, null, and unknown genders in both. Normalize case and whitespace. Exclude owned characters per guild. Validate equal-choice selection through deterministic random indexes, not flaky frequency sampling.
3. Verify shared seven-roll allowance, eighth-roll denial, per-user/per-guild isolation, hourly replenishment, and no carryover. Empty pools spend nothing; reserved rolls remain spent after delivery failure. Duplicate command message IDs never spend twice.
4. Verify claim resets at Vietnam midnight and every three hours, including UTC date boundaries. A cross-reset claim uses the current period. At the exact expiry timestamp a roll cannot be claimed.
5. Verify one marriage for competing users, one claim for competing characters, rollback on insertion failure, repeated reaction safety, unknown characters, and closure of all duplicate cards. Divorce does not refund a claim or revive closed cards.
6. Reopen the database to prove quotas, message mappings, deadlines, and notice deduplication persist. Cleanup removes only records past report lifetime and their notices, leaving ownership and allowances intact.

### Discord adapter tests

Add `test/rollCommands.test.js` with mocked messages, reactions, interactions, and image picker.

1. Both command entry points use the same service and route the proper gender pool.
2. Assert exact card fields, image when available, one Report tag button, and the seeded heart. No anime, aliases, source links, navigation, or claim buttons.
3. Assert publication deadline, registration before heart seeding, missing-image fallback, charged send/reaction failures, and closed failed deliveries. A marriage completed while heart seeding is pending must not be undone by its later failure.
4. Assert only eligible heart events reach the claim transaction; ignore bots, unrelated messages, other emoji, and expired cards. Use uncached/partial messages without requiring a per-message collector. Avoid network awaits before ownership arbitration when persisted event identity is sufficient.
5. Assert the success announcement and restricted mentions. Announcement failure leaves marriage and quota committed. Exhausted claims yield one reset notice per user/roll, including after recovery.
6. Assert recovery uses original deadlines and does not scan existing reaction users. Fresh reactions on persisted rolls work after restart; old reaction lists do not award claims.
7. Assert Report tag uses the saved character mapping, replies privately, remains available after claim expiry, and rejects controls beyond one hour.

## Phase 5: File changes

| File                                                                | Change                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/catalogDb.js`                                                  | Increase schema version to 5 in writer and read-only guards. Add allowance, roll, and notice tables plus lookup/cleanup indexes within the existing migration transaction. Keep migrations from earlier supported versions working.                            |
| `lib/characterRolls.js` (new)                                       | Implement UTC+7 period arithmetic, allowance lookup, atomic random selection and roll reservation, publication/failure transitions, claim transaction, notice deduplication, and bounded opportunistic cleanup. Inject time/randomness where needed for tests. |
| `lib/characterRollRuntime.js` (new)                                 | Own compact card rendering, image lookup, delivery, shared reaction handling, report-button handling, and recovery registration. Keep Discord awaits outside rule transactions.                                                                                |
| `commands/w.js` and `commands/h.js` (new)                           | Thin entry points selecting female or male pools and delegating to the shared runtime.                                                                                                                                                                         |
| `index.js`                                                          | Route `w` and `h` with existing game commands before random side effects. Enable reaction intent/partials, register the shared reaction handler once, and route roll report buttons before the existing interaction early return.                              |
| `test/characterRolls.test.js` and `test/rollCommands.test.js` (new) | Cover the behavior groups above.                                                                                                                                                                                                                               |
| Existing schema-version assertions in `test/`                       | Update only assertions affected by version 5; retain old-version migration coverage. Locate all assertions before changing them.                                                                                                                               |
| `tsconfig.catalog.json`                                             | Include new rule/runtime modules, command entry points, and focused tests. Do not broaden this into unrelated type cleanup.                                                                                                                                    |
| `docs/character-marriage.md`                                        | Document roll commands, pools, resets, claims, delivery failures, and restart behavior; replace the obsolete statement that the roll flow is future work.                                                                                                      |

Implement in dependency order: storage/periods, reservations, atomic claims, delivery/cards, reaction/recovery/report handling, command wiring, then documentation. Reuse `marryCharacter` inside the new transaction without adding quotas to the generic ownership helper. Existing lookup cards, divorce, and marriage lists require no behavioral changes.

### Transaction and event details

- Select a uniformly random eligible row using an eligible count and a stdlib random index within the reservation transaction. Query current catalog data rather than the startup search index. Keep the random choice deterministic in tests.
- Reserve before image lookup or sending. Associate the originating command message ID with the reservation to suppress duplicate execution.
- Save published message identity and a deadline of publication time plus 60 seconds before seeding the heart. Recovery never extends it.
- Process a reaction's persisted guild/channel/message/user identity synchronously through the claim transaction before sending responses. Capture one clock value for that transaction.
- Insert ownership, spend the current claim, and close duplicate windows atomically. Losing reactions and stale cards cannot spend claims.
- Ignore pending or failed deliveries during claims. Close any abandoned unpublished reservation during recovery without refunding its roll.
- Report controls last one hour from publication. Persist notice markers before notification attempts. Keep cleanup bounded and avoid adding a reset scheduler.
- Preserve the approved crash limitations: an unregistered sent card may be unclaimable, and a committed marriage may lack its announcement. Do not add an outbox or retry service without a new requirement.

## Phase 6: Verify and stop

1. Run new rule and adapter tests alongside existing character catalog, identity, marriage, prefix, and command tests.
2. Run `node --test`, `npm run typecheck:catalog`, and `git diff --check`. Separate pre-existing failures from regressions; do not repair unrelated work silently.
3. Review changed files for transaction boundaries, mention restrictions, exact reset times, no new dependencies, and preservation of unrelated edits.
4. Report tests run, results, and remaining live verification limits. Live Discord checks require an available authorized test bot/server; do not start the production bot merely to complete verification.
5. When such an environment is available, verify rendered card, heart permissions, two-user claim competition, custom prefix, a restart inside the 60-second window, offline reaction exclusion, and report controls. If unavailable, mark these checks unperformed rather than claiming they passed.

Stop once the agreed behavior and regression checks pass. No extra trade, rarity, status, or administrative commands.

## Author self-review

Approved: the plan maps every approved rule to a responsible file and observable test, uses existing primitives, keeps network operations outside transactions, preserves user data, and avoids unrelated work. The migration uses temporary fixtures; no live data migration is part of development. Production code remains gated on authorization for the next phases. Unexpected defects or degradation discovered during implementation must be reported immediately for the user's decision.
