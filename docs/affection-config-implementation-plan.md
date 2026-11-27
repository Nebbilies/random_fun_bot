# Configurable affection implementation plan

Status: Phase 3 approved by the user.

Work on `feature/affection-config` from the [approved design](affection-config-design.md). Write a failing test for each slice before changing production code.

## 1. Add the portal controls

- In `lib/gameConfigSchema.js`, register `affection.ownAppearance` (100), `affection.sharedFranchiseSmall` (12), `affection.sharedFranchiseMedium` (10), `affection.sharedFranchiseLarge` (5), `affection.ownerReclaim` (20), and `affection.rollerReclaim` (5). Validate every setting as an integer from 0 to 2,100. Use the existing global defaults, per-server inheritance, edit review, reset, and revision handling in `lib/gameConfig.js`.
- In `web/assets/reviewConfig.js`, label the franchise tiers with their fixed size ranges and identify the two reclaim recipients. Show that zero disables the award. Use the existing form and API. Test the portal section, valid and invalid saves, server overrides, and resets.

## 2. Migrate the award table

- In `lib/affectionSchema.js` and `lib/catalogFinalSchema.js`, keep the exact predecessor definition for validation and older migrations. Define the configured award table with the existing columns, keys, and foreign keys. Bound base and credited amount by the existing 2,100 per-character cap. Retain the existing `total` constraint.
- In `lib/catalogDb.js`, run the additive upgrade after the existing catalog, season, and Weekly Event upgrades. Recheck under the catalog write lock. Validate the predecessor and its award rows before replacing the table. Copy all rows with explicit columns and original row IDs. Reinstall the award table's season guards, receipt triggers, and current-season view from `lib/seasonSchema.js` in the same transaction. Keep the existing `season_receipts` rows intact and validate the final catalog before commit.
- Cover fresh creation, writable upgrade, read-only access to the exact predecessor, restart, concurrent opens, and injected rollback. Verify that historical base-8 receipts and their season bindings survive the upgrade.

## 3. Apply and replay configurable gains

- In `lib/characterAffection.js`, resolve effective configuration for each new roll reservation. Use `lib/affectionRules.js` for the fixed 2–5, 6–10, and 11+ tiers. Capture the four appearance amounts with the existing eligibility and Bond decision in a new snapshot version. Settle completed rolls from the saved candidates and score only the actual credited gain for Weekly Events.
- In `lib/affectionSnapshot.js`, validate the new snapshot amounts and derive the expected candidates from its saved rules. Keep the historical rules for existing snapshot versions and the same version-1 genre behavior. Test a portal edit between reservation and delivery and a restart with a pending roll.
- Resolve owner and roller reclaim amounts when ownership is successfully retained and use the existing eligible soulmate check for the roller. Return an existing receipt before reading new rules. For new awards, skip zero values before drawing Bond or creating a receipt. Retain exact source, server, player, and character checks and accept the saved in-range base on replay. Test configured reclaims, zero values, a replay after changing the setting, and the old base-8 receipt.
- Test that a combined +100 base, Unbroken Bond, and +30% Weekly Event prize credits 260 when there is room. Also verify that an award near 2,100 credits only the remaining amount and still grants the correct milestones.

## 4. Verify

- Run focused portal, catalog migration, affection roll and reclaim, season, and Weekly Event tests. Exercise the actual Affection form against a disposable catalog.
- Run `npm test`, `npm run typecheck:catalog`, the repository Prettier check, and `git diff --check`.

## Shared-franchise scoring

Keep the existing minimum-award rule. When several main franchises match, pick the lowest configured award, including zero. With the defaults, the largest matching franchise gives the lowest award. If an admin changes the order of the awards, the minimum still comes from the configured amounts. Test a zero alongside a positive match and a larger franchise configured to award more than a smaller match.

## Phase 3 self-review

Checked the current portal registry and forms, immutable roll snapshots, both reclaim writers, authoritative award DDL, legacy upgrade coverage, and season receipt tracking. The migration and tests cover the existing awards and the new settings through normal entry points.
