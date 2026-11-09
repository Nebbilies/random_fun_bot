# Threadbreaker implementation plan

Status: Approved for implementation by the user. Item description emphasis: **highest rank *number***.

Approved design: [Franchise divorce chain](franchise-divorce-chain-design.md).

## Scope and stop condition

Implement Threadbreaker through existing inventory, prefix-command, durable action, ownership, and Components V2 systems. Add no dependencies. Stop when the approved gameplay and reveal flow work, focused regression checks pass, and verification results are recorded. Create focused commits on feat/threadbreaker as authorized; do not deploy.

## Proposed public test boundaries

Use existing exported interfaces and public gameplay reads rather than testing private helpers.

1. **Item definitions and acquisition:** `getItemDefinition`, resolved reward pools, item discovery/list/help outputs. Catches registration, rarity, one-charge defaults, reward eligibility, and player instructions. Does not establish chain correctness or actual reward frequencies through statistical sampling.
2. **Durable gameplay actions:** `createItemAction`, `updateItemSelection`, `activateItemAction`, and existing ownership/inventory/action reads. Catches the chain rules, protection policy, charge conservation, rollback, and replay/reopen behavior. Does not validate Discord rendering or delivery timing.
3. **Prefix/inventory runtime and Discord reveal:** `activateItem`, `startItemAction`, `onItemActionInteraction`, and the reveal publisher through fake Discord messages/channels and an injected wait function. Catches franchise selection, authorization, concise confirmation, message order/edits, three-second waits, delivery recovery, and unrelated-action progress. Does not establish live Discord availability or exact-once message delivery across a crash.
4. **Existing identity snapshot/migration interfaces:** exercise the new durable action shapes through exported validation/settlement entry points. Catches unsupported action kinds, character references, and reveal cursors. Does not add a new migration or change historical ownership policy.
5. **Existing configuration and portal boundary:** use exported config read/write/validation interfaces and the portal's existing percentage controls. Catches the 50% default, 0–100% validation, global/guild overrides, save/reload behavior, and description updates. Does not change portal authentication or introduce new endpoints.

## Red/green implementation slices

For each slice, add one meaningful failing behavior test, run it to establish the intended failure, then implement only that behavior and rerun. Repeat for remaining scenarios. Do not write a batch of speculative tests before implementation.

### 1. Register and expose the item

- Add `lib/items/threadbreaker.js` with ID `threadbreaker`, name Threadbreaker, Legendary rarity, one starting charge, and durable action type.
- Register/export it in `lib/items/index.js`; use the existing roster and runtime configuration defaults rather than introducing redundant per-item settings.
- Add `threadbreaker` to the explicit item configuration registry in `lib/gameConfigSchema.js`, and add `itemEffects.threadbreaker.divorceChance` with default `0.5` in schema/runtime defaults. Reuse existing probability descriptors and the web portal's percentage renderer; verify it displays 50% and accepts 0–100%. Change `web/assets/reviewConfig.js` only if the existing generic renderer cannot handle the new descriptor.
- Add a resolved Threadbreaker summary in `lib/itemRoster.js` that displays the effective configured percentage, using the description in the design proposal.
- Update `commands/inv.js` help and item presentation as needed for franchise-targeted confirmation.
- Add a dated Threadbreaker entry in `lib/itemReleases.js` and update relevant roster/release expectations and `docs/item-release-changelog.md`.
- Verify normal Legendary reward eligibility, unchanged tier weights, discovery masking, and resolved charge defaults.

### 2. Resolve franchise selection and confirmation

- In `lib/itemActivation.js` and `lib/itemActionRuntime.js`, carry `!use threadbreaker <franchise>` into the durable action flow and support inventory activation without a preselected franchise.
- Reuse `lib/franchiseLookup.js` normalization/alias search and paginated select controls. Store the selected stable franchise ID. Require explicit choice for ambiguous matches.
- Add Threadbreaker to `ACTION_ITEMS` in `lib/itemActions.js`. Do not require a sacrificed character or other owners as inputs.
- Render only the approved brief confirmation. Keep holder/channel/message binding, expiry, cancellation, and source reservation behavior.
- Verify query selection, ambiguity, inventory selection, forged/wrong-user controls, cancellation, and empty eligibility without payment.

### 3. Settle the chain atomically

- Add the Threadbreaker branch to `lib/itemActions.js`; use `characterFranchiseRelation` for effective membership and published characters joined to this guild's marriages.
- At confirmation, remove permanent locks, sort by descending rank, snapshot original owners, then produce the visited sequence and stop on the first survival.
- Read the effective `divorceChance` at accepted confirmation and save it in the committed result. Use the existing injected random source for independent same-owner checks at that chance. Do not draw randomness for guaranteed divorces. Later configuration changes must not modify settled results.
- Delete exact snapshotted marriage records through the established ownership-loss path; retain original owner/rank and verdict data in the durable action result.
- Reuse charge/Item Conservation handling, atomic result persistence, and post-commit cleanup.
- Extend `lib/characterInteractionCancellation.js` with a narrow optional cause parameter defaulting to Kaimetsu. Threadbreaker passes its own cause and display name; existing Kaimetsu wording remains unchanged.
- Verify worked chain examples, default and overridden probability including 0%/100%, survival stop across owner boundaries, skipped locks/unowned characters, direct membership, all-owner scope, defense bypass, cleanup of divorced characters only, conservation, rollback, double confirmation, and reopened-database replay after configuration changes.

### 4. Reveal committed fates

- Add `lib/threadbreakerReveal.js`, reusing `lib/itemCharacterPresentation.js` card builders where compatible with saved original owner/rank.
- Send the Grand Masquerade-style activation heading, wait three seconds, send a suspense card, wait three seconds, and edit that card with its saved verdict.
- Wait three seconds before the next suspense card. After survival or exhaustion, send a separate message containing exactly `## The chain ended!`.
- Persist character index, stage, card message ID, and ending progress in the existing action JSON. Restore/recreate saved presentation stages after failure without gameplay mutation.
- Connect the publisher in `lib/itemActionRuntime.js`. Preserve earlier verdict cards, suppress mention notifications, and do not send unvisited characters or a duplicate full summary.
- Verify exact ordering and intervals with fake waits; cover survival, exhaustion, missing cards, delivery retry, and reopen/recovery. Use saved verdicts and original ranks/owners rather than deriving them from changed ownership.

### 5. Keep long reveals from blocking unrelated actions

- Narrowly adjust pending Threadbreaker delivery dispatch in `lib/itemActionRuntime.js` so its complete reveal is not awaited by the serial recovery sweep.
- Retain the existing per-action busy guard until publication settles, isolate failures, and leave failed deliveries pending for retry. Avoid overlapping publishers for the same action.
- Preserve existing behavior for unrelated item kinds unless the smallest safe integration requires a shared helper.
- Verify a blocked Threadbreaker wait does not prevent unrelated delivery, and repeated sweeps do not start a second publisher.

### 6. Support saved-state validators and finish verification

- Extend `lib/characterIdentitySnapshots.js` and `lib/characterMigrationSettlement.js` allowlists and payload validation for Threadbreaker selections, results, character references, reveal progress, and Hostage cancellation cause, wherever applicable.
- Add focused compatibility checks in the corresponding existing tests.
- Run focused Threadbreaker tests plus affected action/runtime, Kaimetsu, card/reveal, roster/release, conservation, and identity/migration tests.
- Include existing game-config/runtime and portal tests for probability validation, percent rendering, saving/reloading, and global/guild overrides.
- Run `npm test` and `npm run typecheck:catalog`. Record failures accurately; distinguish pre-existing failures if any occur. Do not broaden scope to repair unrelated issues without a decision.
- Update design status and a concise validation record with commands and results after verification.

## Risks and limits

- Long franchise chains can take minutes and create many character cards; this is the approved presentation. Independent dispatch prevents one reveal from holding up the recovery sweep.
- Separate sends have a crash window before their IDs/progress are saved. Reuse supported deduplication where available; gameplay remains replay-safe even if a presentation message is duplicated.
- Existing untracked documentation is present in the checkout. Preserve unrelated files and edits.
- No schema migration or new service is expected. If implementation exposes an unaccounted defect or degradation requiring a material design change, report it before proceeding with that change.

## Self-review

Phase 3 self-review: passed. Planned files match the inspected activation, action, reveal, cleanup, registration, and validation boundaries. The plan preserves the approved chain semantics and exact ending text, includes independent reveal scheduling, uses existing dependencies, and proposes behavioral tests at public boundaries. Implementation was authorized by the user and is complete. See threadbreaker-validation.md for results.
