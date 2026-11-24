# Main franchise schema design

## Scope

Add `characters.main_franchise_id` as a nullable integer foreign key to `franchises.id`, indexed by `characters_by_main_franchise`. A character can have zero or one main franchise, and many characters can point to the same franchise. Existing rows and new characters start at `NULL`. The migration leaves existing rows without a designation and performs no backfill.

Use a foreign key on `characters` because the designation has one value per character. A flag on the membership table would need a uniqueness constraint and would only cover directly curated memberships. Keep `effective_character_franchises` as the source for franchise searches, grouping, and gameplay. This release supports storage and referential maintenance. Assignment and display controls belong to a separate change.

## Franchise lifecycle

- Use `ON DELETE SET NULL` so deleting a franchise clears affected designations, including when an unused automatic franchise is pruned.
- During a franchise merge, move main-franchise references from the source to the surviving franchise in the existing transaction, before deleting the source.
- Character creation uses the `NULL` default. Catalog refreshes of existing characters preserve any value already stored in the column.

## Catalog upgrade and deployment

- Keep `user_version=12` and recognize the exact layout immediately preceding this feature. Add the column and index in one SQLite transaction, recheck the layout after taking the write lock, and validate the result before commit. Reopening an already upgraded catalog requires no migration.
- Make fresh catalog creation, historical upgrade paths, and ranking cutover converge on the same authoritative schema. Keep the existing checks for unknown or partially upgraded layouts.
- At the existing deployment gate, after both services stop and before either restarts, run the additive upgrade for the exact predecessor. Then run the existing strict read-only validation against the target schema. Any migration or validation failure blocks restart. Writable startup also supports upgrading the predecessor through the existing catalog upgrade path.

## Rollback and verification

- A failed migration rolls back the column and index together. Rehearse on a disposable catalog and compare schema and data before and after.
- For a rollback to the previous release, stop both writers and verify that every main-franchise value is `NULL`. Remove the index and column in one transaction, validate the exact previous schema and foreign keys, then reopen with the matching previous release. Keep the expanded schema and use a forward fix if an assignment exists. Deployment retains its existing operator-directed recovery behavior.
- Verify fresh and upgraded catalogs, zero assignments after upgrade, the `NULL` insert default, FK enforcement, merge and delete behavior, stable catalog refreshes, retry safety, and rejection of unknown layouts. Exercise the deployment gate with predecessor, current, and invalid fixtures.
- An in-memory rehearsal against the current catalog confirmed that SQLite adds the nullable FK and index, and that removing them restores the exact previous schema accepted by the current validator.
