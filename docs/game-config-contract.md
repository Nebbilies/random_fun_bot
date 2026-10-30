# Shared game configuration contract

Shared persistence and runtime contract for the Configuration portal.

## API: lib/gameConfig.js

- `getGameConfig(db?, guildId?)`: fresh nested resolved object: built-ins < global < guild. Missing db returns built-ins. Old databases without configuration tables use built-ins plus legacy rates/limits. No cache.
- `getConfigView(db?, guildId?)`: `{ guildId, revision, effective, defaults, sources, overrides, registry, sections }`. Sources is a flat dotted-key map (`builtin`, `global`, `guild`). Overrides contains flat explicit values for the selected scope. Revision is one integer across all scopes: any save invalidates stale views.
- `saveConfigSection(db, { guildId = null, section, values = {}, reset = [], expectedRevision, activateSchedule = false })`: atomic partial section update. Values is a flat map of FULL dotted registry keys; arrays are whole values. Reset is an array of full dotted keys to remove; `reset: true` clears the whole section. Missing expectedRevision is rejected. Returns refreshed view. Global scope is null, not a magic guild ID.
- Schedule saves/resets require `activateSchedule: true`: this separate explicit activation starts fresh affected allowance cycles. Never deletes daily records, marriages, items, or buffs.
- Errors carry code `CONFIG_VALIDATION`, `CONFIG_STALE`, `CONFIG_ACTIVATION_REQUIRED`, or `CONFIG_STORAGE`. Global saves validate every inherited guild combination before committing.
- `initGameConfig(db)`: idempotent migration helper, imports old guild rates and roll caps once.

## Schema: lib/gameConfigSchema.js

Exports `GAME_CONFIG_DEFAULTS`, `GAME_CONFIG_REGISTRY` (flat allowlist: key, section, default, type, guild, activationRequired, numeric min/max or array maxLength), `GAME_CONFIG_SECTIONS`, `validateConfigValue`, `validateGameConfig`, `flattenConfig`, `setConfigPath`.

All keys permit global and guild scope. Sections are top-level groups. No arbitrary keys, code, secrets, audit history, or live state. Timer durations/intervals use milliseconds; `itemExpiryDays.{common,rare,epic,legendary,???}` instead uses whole days (1–365 inclusive), with defaults 2/4/7/14/30. These fixed inventory deadlines are not Node timers, so 30 and 365 days are valid. Lifetime edits apply to newly acquired items only; existing deadlines and charges never refresh. The section supports the same global/guild inheritance and reset behavior as other rules. Timezone is fixed UTC offset minutes (current UTC+7, no DST). Weights are relative, not probabilities. Starting charges affect new entries only. Runtime must snapshot rules for active buffs/events/actions. Capacity reductions preserve existing entries and earned expansions. Treasure Hunt exists but is absent from current selectable roster, so defaults disabled. Internal event safety ceiling is not editable.

## Operator workflow and deployment

Run the existing combined review portal (`npm run catalog:review`) and open **Configuration** (`/config`). Keep it on localhost, reach it through an SSH tunnel, or put an authenticated reverse proxy in front of it. The portal does not supply authentication; never expose an unauthenticated listener publicly.

Choose global defaults or enter a Discord server ID, edit one section, then review and confirm the changes. Percent fields use percentages; structured odds tables use JSON fractions. The page shows each effective setting's source. Resetting deletes an explicit override and restores inheritance, rather than copying today's inherited value. A stale revision returns HTTP 409: reload and reapply the intended edits. Saving a section reloads the page's settings and discards unsaved edits in other sections, as stated in the review dialog.

Schedules have a separate activation endpoint and confirmation warning. Roll and claim allowance cycles restart only when their schedule actually changes. Daily eligibility already promised to a player remains intact. New item entries use configured charges; existing charges and active session snapshots do not change. Game controls retain one-off grants and resets, and legacy Discord administrative setters remain available.

Validation rejects unknown keys, invalid inherited combinations, empty positive-weight reward/event pools, malformed mystery curves, and durations exceeding Node's timer range. Configuration revisions are concurrency tokens, not an audit log; no administrator attribution or change history is stored.

## Full built-in default map

```json
{
  "rolls": {
    "maxRolls": 7,
    "prankRate": 0.01
  },
  "schedules": {
    "rollIntervalMs": 3600000,
    "claimIntervalMs": 10800000,
    "dailyIntervalMs": 86400000,
    "timezoneOffsetMinutes": 420
  },
  "windows": {
    "claimMs": 60000,
    "escapeProtectionMs": 60000,
    "escapeClaimMs": 60000,
    "reportMs": 3600000
  },
  "mystery": {
    "enabled": true,
    "oddsAnchors": [
      {
        "rank": 20,
        "chance": 1
      },
      {
        "rank": 50,
        "chance": 0.8
      },
      {
        "rank": 100,
        "chance": 0.6
      },
      {
        "rank": 200,
        "chance": 0.4
      },
      {
        "rank": 500,
        "chance": 0.2
      },
      {
        "rank": 1000,
        "chance": 0.05
      },
      {
        "rank": 4000,
        "chance": 0.005
      },
      {
        "rank": 15000,
        "chance": 0.001
      }
    ],
    "introDelayMs": 5000,
    "winnerDelayMs": 3000,
    "wrongChoiceDelayMs": 2000,
    "answerCooldownMs": 3000
  },
  "mysteryEvents": {
    "doors": {
      "enabled": true,
      "weight": 1,
      "durationMs": 30000
    },
    "clue_reveal": {
      "enabled": true,
      "weight": 1,
      "durationMs": 90000,
      "clueIntervalMs": 18000,
      "tagMinRank": 50,
      "genreCount": 2,
      "tagCount": 2,
      "typoShortLength": 5,
      "typoLongLength": 10,
      "shortTypos": 0,
      "mediumTypos": 1,
      "longTypos": 2
    },
    "treasure_hunt": {
      "enabled": false,
      "weight": 1,
      "durationMs": 120000,
      "clueTimesMs": [
        0,
        40000,
        80000
      ]
    },
    "greed_chamber": {
      "enabled": true,
      "weight": 1,
      "rounds": 5,
      "totals": [
        1,
        3,
        6,
        10,
        15
      ],
      "collapseChances": [
        0.1,
        0.2,
        0.3,
        0.45,
        0.67
      ]
    },
    "deadlock": {
      "enabled": true,
      "weight": 1,
      "rounds": 3
    },
    "roundTiming": {
      "firstRoundMs": 30000,
      "laterRoundMs": 20000,
      "resultMs": 8000
    }
  },
  "vault": {
    "enabled": true,
    "dropRate": 0.01,
    "openTimeoutMs": 60000,
    "tierWeights": {
      "common": 60,
      "rare": 20,
      "epic": 15,
      "legendary": 5
    }
  },
  "itemExpiryDays": {
    "common": 2,
    "rare": 4,
    "epic": 7,
    "legendary": 14,
    "???": 30
  },
  "capacity": {
    "inventoryBase": 5,
    "inventoryMax": 8,
    "wishlist": 7
  },
  "trades": {
    "stepTimeoutMs": 180000
  },
  "controls": {
    "lifetimeMs": 3600000
  },
  "itemActions": {
    "confirmationMs": 60000,
    "hostageDecisionMs": 60000,
    "doubleDecisionMs": 30000,
    "doubleWinChance": 0.5,
    "hostageDivorceChance": 0.5,
    "alchemistCost": 3,
    "alchemistRewardWeights": {
      "rare": 70,
      "epic": 25,
      "legendary": 5
    },
    "doubleRewardWeights": {
      "epic": 80,
      "legendary": 20
    },
    "chaosMinRankMultiplier": 0.5,
    "chaosMaxRankMultiplier": 2,
    "masqueradeMinRankMultiplier": 0.4,
    "masqueradeMaxRankMultiplier": 2,
    "masqueradeTopRank": 100
  },
  "items": {
    "hourglass_of_haste": {
      "rewardEligible": true,
      "startingCharges": 1
    },
    "love_letter": {
      "rewardEligible": true,
      "startingCharges": 1
    },
    "bag_of_holding": {
      "rewardEligible": true,
      "startingCharges": 1
    },
    "four_leaf_clover": {
      "rewardEligible": true,
      "startingCharges": 1
    },
    "rolling_fever": {
      "rewardEligible": true,
      "startingCharges": 1
    },
    "adrenaline_rush": {
      "rewardEligible": true,
      "startingCharges": 1
    },
    "double_date": {
      "rewardEligible": true,
      "startingCharges": 1
    },
    "engagement_ring": {
      "rewardEligible": true,
      "startingCharges": 1
    },
    "pinata": {
      "rewardEligible": true,
      "startingCharges": 1
    },
    "golden_hour": {
      "rewardEligible": true,
      "startingCharges": 1
    },
    "crown_of_the_sovereign": {
      "rewardEligible": true,
      "startingCharges": 1
    },
    "pickpockets_hook": {
      "rewardEligible": true,
      "startingCharges": 1
    },
    "master_key": {
      "rewardEligible": true,
      "startingCharges": 1
    },
    "aegis_of_fidelity": {
      "rewardEligible": true,
      "startingCharges": 1
    },
    "wish_upon_a_star": {
      "rewardEligible": true,
      "startingCharges": 1
    },
    "franchise_passport": {
      "rewardEligible": true,
      "startingCharges": 1
    },
    "blood_pact": {
      "rewardEligible": true,
      "startingCharges": 1
    },
    "golden_whistle": {
      "rewardEligible": true,
      "startingCharges": 3
    },
    "mirror_shield": {
      "rewardEligible": true,
      "startingCharges": 1
    },
    "binoculars": {
      "rewardEligible": true,
      "startingCharges": 1
    },
    "sirens_call": {
      "rewardEligible": true,
      "startingCharges": 1
    },
    "alchemist": {
      "rewardEligible": true,
      "startingCharges": 1
    },
    "chaos_exchange": {
      "rewardEligible": true,
      "startingCharges": 1
    },
    "counterfeit_crown": {
      "rewardEligible": true,
      "startingCharges": 1
    },
    "double_or_nothing": {
      "rewardEligible": true,
      "startingCharges": 1
    },
    "heart_for_a_heart": {
      "rewardEligible": true,
      "startingCharges": 1
    },
    "hostage_note": {
      "rewardEligible": true,
      "startingCharges": 1
    },
    "severed_fate": {
      "rewardEligible": true,
      "startingCharges": 1
    },
    "grand_masquerade": {
      "rewardEligible": true,
      "startingCharges": 1
    }
  },
  "itemEffects": {
    "bag_of_holding": {
      "capacityIncrease": 1
    },
    "four_leaf_clover": {
      "rolls": 5,
      "minFavourites": 1000,
      "maxRank": 1000
    },
    "rolling_fever": {
      "rolls": 10,
      "favouritesThreshold": 1000,
      "refundRolls": 2
    },
    "adrenaline_rush": {
      "durationMs": 3600000,
      "allowanceMultiplier": 2
    },
    "double_date": {
      "durationMs": 600000
    },
    "engagement_ring": {
      "claims": 1,
      "cooldownMultiplier": 0.5
    },
    "pinata": {
      "rolls": 10,
      "claimTokens": 1,
      "minFavourites": 1000,
      "maxRank": 1000
    },
    "crown_of_the_sovereign": {
      "claimTokens": 3
    },
    "pickpockets_hook": {
      "protectionMs": 86400000
    },
    "master_key": {
      "protectionMs": 86400000
    },
    "wish_upon_a_star": {
      "topCount": 3
    },
    "franchise_passport": {
      "rolls": 5
    },
    "blood_pact": {
      "sacrificeCount": 3
    }
  }
}
```

Catalog migration is v10; old read-only schemas remain readable via fallback. Adds nullable character_rolls.rules_json for rule snapshots and daily_roll_claims.reset_at to preserve daily deadlines on schedule changes. Legacy administrative table writes are bridged by SQLite triggers and invalidate revisions.
