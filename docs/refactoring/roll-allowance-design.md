# Roll allowances and cooldowns: design

Date: 2026-11-11. Baseline: `79995d1`.
Status: user-approved design; self-reviewed.

## Objective and scope

Extract allowances from the character roll implementation so status commands, daily refills, and administrative adjustments have a cohesive home. Preserve existing behavior, public imports, and transaction ownership. Roll lifecycle, Discord runtime, mystery events, rewards, schemas, dependencies, and unrelated type fixes remain outside this stage.

## Options and decision

A full roll rewrite would mix allowance storage with delivery, ownership, randomness, and recovery changes. Global service/repository folders would separate related feature changes. The selected design uses `features/rolls/rollAllowanceService.js` and `rollAllowanceRepository.js`, following the feature structure established by trading.

The service owns reset calculations, capacities, daily eligibility, normal versus bypass claim eligibility, maximum-roll settings, and global adjustments. The repository owns SQLite reads/writes and does not begin, commit, or roll back transactions. Existing configuration, affection, buff, and transaction helpers remain shared dependencies.

`lib/characterRolls.js` re-exports the existing public allowance functions and imports transaction-neutral helpers for the lifecycle it still owns. New modules never import that compatibility module. Reservation, refund, and successful-claim SQL delegates to the repository at the existing execution points; branch decisions, randomness, and buff consumption stay in the lifecycle.

Commands `ru`, `mu`, `daily`, and administrative `set-roll` import the service directly without changing input parsing or responses. Other consumers may retain existing imports. New modules join the existing catalog typecheck graph without broadening to unrelated app adapters.

## Contracts and edge cases

- Preserve distinct roll-period and claim-period arithmetic, default reset arguments, timezone offsets, and exact boundary comparisons.
- Preserve stored daily eligibility through schedule activation and the legacy fallback for missing reset timestamps.
- Keep affection bonuses after Adrenaline Rush multiplication, normal claim status separate from token bypass eligibility, and claim inspection free of writes.
- Retain ring reductions, depleted/expired/future buff filtering, global adjustment counts, and clamping when capacity falls below recorded usage.
- Public daily/global operations retain their transactions. Lifecycle helper calls use the existing transaction and connection, including all allowance debit/refund/claim writes.
- Duplicate invocations do not debit twice. Failed lifecycle settlement rolls back allowance writes with ownership, roll state, and buff changes.

## Approved verification seams

Exercise public allowance functions through both new and compatibility imports, and real reservation/claim workflows against SQLite. Retain existing command, affection, buff, legacy-schema, and final-schema integration suites. Use explicit timestamps and deterministic randomness. No live bot login or production database is needed.

## Self-review

Self-approved: responsibilities are cohesive, shared code is reused, compatibility paths remain intact, and tests target behavior and transaction atomicity. The user approved this design and these seams before the implementation plan.
