# Item expiry design

Status: design accepted for implementation; implemented on `feat/item-expiry` (verification in progress).

## Confirmed behavior

- Every inventory entry receives a fixed expiry deadline when it is successfully acquired. Real-world time continues while the owner or bot is offline.
- Configuration changes affect future acquisitions only; existing deadlines stay unchanged.
- Entries already owned at rollout receive a full lifetime starting at rollout, not their historical acquisition date.
- Expiry removes the held item and stops its passive benefits. It does not undo successfully activated effects: those retain their own durations or permanent outcomes.
- All remaining charges share the entry's original deadline. Spending a charge does not refresh it.
- Initial lifetimes by rarity tier:
  - Common: 2 days.
  - Rare: 4 days.
  - Epic: 7 days.
  - Legendary: 14 days.
  - ???: 30 days.
- Settings follow existing global defaults with per-server overrides in the configuration portal.
- Each tier requires a positive lifetime. There are no non-expiring tiers or individual-item exemptions; administrator grants obey the same rule.

## Use-start boundary

- Expiry gates starting a valid item use, whether via `!use` or an inventory Use button. Invalid or rejected attempts do not reserve an item. For interactive items, accepting a supported use command for an available source and creating its bounded selection/confirmation session is the start; choosing targets is part of that already-started use, not a second expiry gate. Merely viewing inventory or opening help does not start a use.
- A use successfully started before the deadline may complete after it under its normal confirmation/delivery timeout. Do not recheck inventory expiry to reject its confirmation or interrupt its delivery.
- Armed Fortune's Recast remains armed after the inventory deadline and may finish its existing lifecycle.
- Passive items may trigger only before their deadline. An effect already triggered may finish afterward.
- Starting a use protects that action only, not all remaining charges. Unused charges disappear at expiry; the in-progress use may still finish.
- Cancellation, timeout, or refund after the original deadline does not revive a usable inventory entry.
- Pending vault rewards start their lifetime only upon successful inventory delivery, not while waiting for a decision or free slot.

## Inventory, selection, and presentation

- Expired entries immediately disappear from inventory and cease occupying capacity. Internal records needed by an already-started action may remain until it resolves, without representing a held inventory item.
- Expiry remains effective after bot downtime; usability and capacity must not depend on a cleanup timer having run.
- Inventory entries show compact remaining lifetime, for example `(2d 16h)`. Smaller units should be used when needed so a still-usable entry is not misleadingly shown as expired.
- The item catalog shows current configured rarity lifetimes; owned entries show their own fixed remaining lifetimes.
- Name-based `!use` selects the soonest-expiring available matching entry. A specific inventory button still selects that exact entry.
- Expiry sends no unsolicited DMs or channel messages. Stale controls and attempts to use an expired selected entry explain that it has expired.

## Portal controls

- Each rarity lifetime is configured in whole days, from 1 through 365 inclusive.
- Controls clearly state that changes apply to newly acquired items only.
- Existing global inheritance, per-server overrides, authorization, and revision-conflict behavior remain in place.

## Confirmation

All interview branches are settled. The user authorized implementation of the resulting plan on a `feat/` branch.

## Grounded integration notes

- Inventory entries are individual rows, not stacks (`lib/itemStorage.js`).
- Passive consumers and Fortune availability checks have paths outside ordinary use dispatch; enforcing expiry only in `!use` is insufficient.
- Fortune and Hostage flows can hold inventory entries while effects or delivery are pending. Fortune persistence references inventory entries, so deletion must respect recovery and held-state relationships.
- Snapshot/schema and migration contracts enumerate inventory fields and must evolve with persistence changes.
- Existing portal millisecond-duration validation assumes timer limits of approximately 24.9 days. The confirmed 30-day tier needs deadline-based duration validation rather than that timer limit.
