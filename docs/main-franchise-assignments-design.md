# Many-to-many main franchise assignments

This proposal replaces the single-value design in [Main franchise schema design](character-main-franchise-design.md). Ship the schema migration and franchise alias lookup fix together. Import the CSVs after verifying the release on production.

## Assignment model

A character can have zero or more main franchises. Store each assignment in `character_main_franchises` with a composite primary key on `(character_id, franchise_id)`. Use the existing character and franchise ID types, foreign keys to `characters` and `franchises`, and an index on `(franchise_id, character_id)`. Deleting either parent clears its assignments, consistent with the old column clearing when its franchise is deleted.

The existing `character_franchise_memberships` table and `effective_character_franchises` view continue to serve member lists and gameplay. The new table stores main franchise assignments independently. Existing character refreshes preserve assignments for the same character ID. Franchise renames preserve the live ID and its assignments. Franchise merges move pairs to the surviving ID within the existing merge transaction and collapse a pair if the character already links to the survivor.

A junction table enforces valid references and unique pairs in SQLite. Reusing the effective membership relation would make main franchise curation affect gameplay. Keeping the old column alongside the table would give readers two representations of the same assignment.

## Alias exclusions

Bot search currently gets a franchise's aliases from saved rows and from titles and synonyms of linked anime. Apply each `source = 'excluded'` entry to aliases from both sources for that franchise ID, using the existing name normalization. The canonical display name stays searchable. A manual re-add can restore an excluded alias. Keep the existing matching order and scoped direct-membership search behavior.

For example, excluding `Nisekoi` on franchise `22` removes that alias supplied by its linked anime. A future franchise `3055` named `Nisekoi` can then resolve by its display name. This works without moving an anime record or changing effective memberships. The later import can rename `X (TV)` to `X` and retain `X (TV)` as a searchable alias. The existing bot matcher requires at least two characters in a query.

## Migration and rollout

Production is on catalog version 12, has season tables, and had 17,310 characters with zero populated `main_franchise_id` values at the design check. The migration preserves populated values wherever present.

- Recognize the exact column-based predecessor schemas with and without season tables. Preserve the season layout of the source. Existing supported historical upgrades and fresh databases converge on the table-based layout. Keep the rejection of unknown or partially migrated schemas.
- Recheck the predecessor under the SQLite write lock. In one transaction, create the assignment table and index, copy every non-null legacy pair, verify the copied pairs, then drop the legacy index and column. Validate the target schema and foreign keys before committing. A second open of the migrated schema is a no-op.
- Use a consistent SQLite backup for the rehearsal. Verify that both layout variants converge on the same schema as their fresh equivalents. Cover populated and empty source assignments, multiple assignments per character, merges, deletions, alias normalization and scoping, rollback on failure, and a second run. Rehearse the migration and application startup on a production copy. Measure the SQLite table rewrite on that copy to estimate deployment downtime.
- At deployment, stop both writers and take a consistent pre-migration backup before running the existing schema readiness gate. The deployment uses matching code and schema for both services. Verify schema readiness and service startup before the later CSV import.

## Recovery and import boundary

A transaction failure leaves the original layout and data available. Before writers restart, a committed migration can be rolled back by restoring the verified pre-migration snapshot with its matching release. Once writers resume, restoring that snapshot would discard subsequent writes. A downgrade that preserves those writes would need a separately verified reverse migration and at most one assignment per character. After any character has multiple assignments, use a forward fix to preserve all pairs.

The later SQL import maps CSV IDs to surviving production IDs for renames and uses the proposed IDs for new franchises. Keep multiple distinct pairs from the CSV, including the 61 previously conflicting characters, and deduplicate pairs that converge after remapping. Alias exclusions and franchise curation are part of that import.
