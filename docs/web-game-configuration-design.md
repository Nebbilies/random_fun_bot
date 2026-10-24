# Web game configuration — design interview

Status: approved for implementation.
Branch: `feat/web-game-configuration`.

## Confirmed scope (round 1)

- Expose all gameplay and balance policy: rates, durations, cooldowns, limits, item starting charges and effects, rewards, and event rules.
- Exclude credentials and internal safety/protocol limits. Operational settings are not included in this scope.
- Support persistent global defaults and server overrides for settings that support server scope. Clearing an override restores inheritance.
- Show effective values and their origin: built-in default, global configuration, or server override.
- Changes require no restart and affect new actions, not already-running events or existing inventory charges.
- An event's rules remain stable for its lifetime. Newly issued items use configured starting charges; existing inventory entries retain their stored charges.
- Implement in focused commits on a feature branch and create a PR when complete.

## Confirmed editing and access policy (round 2)

- Atomic saves per related configuration section, with change review, server-side validation, and stale-revision rejection.
- Retain the trusted-operator portal deployment model (localhost/SSH tunnel or externally authenticated proxy). No new player-facing configuration command or public editing access. The existing portal does not authenticate users itself.
- Round 4 supersedes round 2's audit-history agreement: no change-history feature or actor attribution. Revision tracking remains required for stale-edit rejection.
- Resetting a server setting removes its override, restoring inheritance, with explicit confirmation.
- Preserve existing guild rates and roll caps; consolidate their web editors into Configuration. Existing Discord administrative setters remain supported and write to the same settings model.
- Keep one-off administrative actions (add rolls, reset claims, give item) in Game controls, separate from configuration.

## Confirmed coverage and transitions (round 3)

- Character game only. Exclude landmines, voice-channel lottery, birthdays, and legacy utility features.
- Include supported numeric rule parameters, probabilities, event/tier weights, mystery rank/chance curves, item strengths, starting charges, costs, and selection ranges. Exclude arbitrary formulas/code and structural redesigns of event mechanics.
- Runtime behavior and displayed rule descriptions must agree with effective settings.
- Roll/claim reset intervals and reset timezone are configurable. Schedule changes require separate explicit activation with warning and a fresh affected allowance cycle, not an incidental ordinary save. Do not erase marriages, items, or daily-claim records.
- Existing inventory entries retain remaining charges. Items activated after a change use new effect rules. Already-active buffs and multi-step sessions retain activation rules/deadlines.
- Capacity reductions preserve existing inventory/wishlist entries; additions are blocked until below the effective limit. Preserve earned inventory expansions.

## Confirmed availability and history (round 4)

- Allow disabling new mystery/vault rolls and individual mystery events; already-running sessions finish unchanged.
- When mysteries are enabled, require at least one eligible event with positive weight.
- Item reward eligibility is separate from rates: disabling eligibility stops new random drops, but existing copies remain usable and manual grants remain available.
- No change-history feature or administrator attribution (Q13 rejected, superseding the earlier history agreement). Keep configuration revision tracking for concurrency safety, not a history UI.

## Approval

The user approved implementation after round 4. Deliver focused commits on the feature branch, tests and documentation, and a pull request.

## Terminology

Use “game rules” for tunable gameplay policy, “global defaults” for policy shared unless overridden, and “server override” for an explicit server-specific replacement. Do not use “dynamic values” to include live player state, ownership, inventories, or secrets.
