# Manual character addition — confirmed design

Status: confirmed by the user. Ready for implementation planning; no application implementation or production migration has been performed. See [implementation plan](./manual-character-addition-plan.md).

## Settled decisions

- Use permanent UUID character identities, separate from external source IDs such as AniList character IDs.
- Manual additions request an insertion rank. Inserting at rank R shifts the current character at R and subsequent characters down.
- Generate likes to fit the surrounding counts where possible. Keep the generated count fixed across AniList refreshes; the character's rank may change naturally. The selected rank is not pinned.
- Whenever generated likes are displayed, append `[generated]` next to the likes display. Apply this everywhere likes are revealed; hide the label when likes are hidden. Imported likes retain their existing presentation. The label follows the count's provenance, not the character's creation method or external references.
- Allow generated integer likes to equal neighboring counts when necessary. An explicit tie order guarantees the exact requested insertion rank without changing existing characters' likes.
- For insertion between two characters, generate the midpoint of their like counts, rounded down. Generation is deterministic, not random.
- At rank 1, generate the current leader's likes plus one. At the end, generate the lowest count minus one with a floor of zero. In an empty catalog, generate zero. Counts must be nonnegative safe integers; reject an insertion that would overflow.
- Generated likes and manual characters' ranks have the same gameplay meaning as imported likes and ranks. Insertion may shift existing characters across rank-dependent gameplay thresholds; this is intentional.
- Use the existing management portal as the primary manual-addition interface, with entry, rank selection, preview, and confirmation. Generate UUIDs server-side. Require a refreshed preview if the catalog changes before confirmation.
- Manual characters require one or more franchise memberships before publication. Allow selecting existing franchises or creating franchises with display names and searchable aliases.
- Add direct, manually managed character-to-franchise membership alongside anime-derived membership; do not create fake anime records. Preserve direct memberships across imports and deduplicate characters in combined franchise results.
- New franchises require a display name. Search aliases, cover image, and reference URL are optional. Use an anime-derived cover when available, otherwise an optional curated cover, otherwise text-only presentation. Selecting an existing franchise reuses its metadata rather than overwriting it from the character form.
- Publishing a manual character requires a display name, one or more franchises, an insertion rank from 1 through catalog size plus one, a fallback portrait URL, and an explicit gender selection (including unknown/unspecified). Unknown/unspecified characters qualify for both gender-filtered roll pools.
- Character aliases, description, reference URL, and approved Danbooru character tag are optional. The system assigns UUID, generated likes, and their provenance.
- Before publication, check names, aliases, and franchise memberships for possible duplicates and show matching identities with portraits and source references. Name matches warn rather than block; never merge automatically.
- The editor may reuse an existing character and add missing aliases or memberships without changing its identity, ownership, or likes. Creating a distinct character despite warnings requires explicit confirmation and a recorded explanation. An external source reference may belong to only one character identity.
- Linking a manual character to an AniList entry preserves its UUID, ownership, wishes, history, manually maintained metadata, and generated likes/provenance. Imports resolve the linked entry to the existing identity rather than creating a duplicate.
- Switching to AniList-managed likes is a separate explicit action with a preview of the resulting rank change and confirmation. After switching, refreshes manage the count and the `[generated]` label no longer applies.
- Repositioning is an explicit action separate from metadata editing: select a target rank, preview neighbors and regenerated likes under the agreed rules, then confirm. Preserve UUID, ownership, wishes, and history. Ordinary metadata edits do not regenerate likes.
- Repositioning a character with AniList-managed likes requires explicit confirmation of switching to generated likes, which subsequent source refreshes must preserve. Do not expose a free-form likes field in the initial version.
- Superseding the earlier keep-as-is access decision, add environment-configured admin and moderator accounts protecting all portal pages and administrative APIs. No public registration or account-management system. Admin has full access. Moderator may manage characters, source links, likes-source switches, franchises, tag review, and report resolution, but may not view/change configuration, grant items, add rolls, or reset claims. Enforce authorization on every API, including alternate server entry points; hiding UI alone is insufficient.
- Keep credentials server-side, store salted password hashes rather than plaintext passwords, and explicitly load deployment environment settings. Use protected server-side sessions, appropriate secure cookie settings, login rate limiting, and CSRF protection alongside existing Host/Origin checks. Refuse startup on missing/invalid required credentials rather than silently running unprotected.
- Record the authenticated role/account for future catalog changes; old unauthenticated history must not receive invented attribution.
- Disallow removing published characters in the initial version. Do not add retirement, restoration, or hard deletion of published characters. Metadata correction and explicit repositioning remain available.
- Automatically reload catalog-dependent character and franchise indexes after atomic publication of additions, metadata edits, or repositioning. Subsequent catalog-dependent commands must use the updated catalog consistently; an already-running command may finish using captured data. Routine portal edits do not require restarting the bot.
- Rank by likes descending, then persistent tie order, never UUID order. Migration preserves existing tied-character order. Manual insertion establishes its exact position within ties. Refreshes preserve saved tie order; newly imported characters join the end of an existing equal-like group, ordered by AniList ID within the new batch.
- Portraits and curated franchise covers use HTTPS URLs only in the initial version; no uploads or local image-storage system. Show images in browser previews without server-side fetching of arbitrary URLs. URL correction preserves character identity and likes. Image suitability, hosting durability, and usage permissions remain editorial responsibilities.
- Optional Danbooru character tags use the existing validated approval path and general-rated image selection.
- Retain completeness tracking for anime enrichment, but do not invalidate it for likes/rank edits or manual-only additions with direct memberships. Direct memberships become available immediately and combine with anime-derived memberships without duplication. Linking an AniList reference does not itself import appearances; enrichment remains a separate step. Track relevant source/appearance changes rather than treating every catalog publication as invalidating anime data.
- Maintain a minimal catalog mutation log for creation, metadata edits, repositioning, source linking, and likes-source switches. Record timestamps and before/after values plus duplicate-warning override explanations. Attribute new changes to their authenticated account; never invent attribution for older unauthenticated records. This is diagnostic history, not a general undo feature.
- Allow correcting an incorrect AniList reference by unlinking it or replacing it with a verified, unoccupied reference, with explicit confirmation and change history. Preserve UUID, ownership, wishes, and history; never merge identities through this action. Existing generated likes remain unchanged. If likes were AniList-managed, freeze the last count as generated until an explicit source switch or repositioning.
- During UUID migration, preserve published catalog and anime/franchise data but discard unfinished staging data and numeric-ID import cursors. Restart interrupted imports explicitly under the new identity model rather than migrating checkpoints. Do not automatically run network imports during migration; restarting incomplete scans may repeat API work. Preserve tag decisions and other retained game data.
- Verify AniList links through a single-character identity lookup and side-by-side local/source name, portrait, and reference preview, then explicit confirmation. Reject external references already owned by another identity. API failure leaves the record unchanged. Linking is not a bulk import and does not automatically switch metadata or likes management.
- Full metadata editing (name, portrait, description, gender) is limited to manually created characters in this feature, including those later linked to AniList. Imported characters may receive durable curated aliases/direct franchise memberships and existing tag corrections, but no general imported-metadata override editor. Both kinds may be repositioned with explicit switching to generated likes and may receive unique external-source links.
- Manual management must work before any AniList import, including an empty or manual-only catalog. Search, rolls, and direct franchise membership support manual-only characters; an empty catalog returns clear unavailable responses. AniList enrichment requires relevant linked identities, and bulk import permission requirements remain unchanged.
- Confirmation requests must be idempotent: retries or double-clicks must not create duplicate characters or apply a reposition twice.
- Perform UUID migration during a maintenance window with the bot, portal, and importers stopped and a verified backup available. Safely cancel pending gameplay interactions, release reservations, and restore refundable costs. Migrate permanent identities and retained references while preserving ownership, wishes, tags, and history. Pre-migration interactions expire gracefully; no legacy numeric-ID interaction support is required. Verify migrated data before restarting.
- Exclude characters without a suitable anime target from Clue Reveal; do not use franchise-name fallback puzzles. Check event eligibility before selection. Characters remain eligible for normal rolls and other compatible mystery events; if no eligible event is available, continue as a normal roll. A manual character with suitable imported anime data may qualify normally.
- Already-published rolls and running mystery events preserve captured rank/likes and determined outcomes across catalog edits. Pending exchanges and item actions revalidate rank-dependent eligibility at confirmation; cancel safely without consuming uncommitted costs if invalidated. New actions use updated catalog data. Targets always remain attached to character UUIDs, not old rank positions.

- Repositioning ranks mean final positions after excluding the moved character from its old position. Serialize publication across portal/importers, preserve curated data, and reject stale confirmations without locking the portal throughout network fetching.
- Permit direct franchise membership corrections while requiring manually created characters to retain at least one franchise.
- Require a successful backup rehearsal and verification of ownership, wishes, tag decisions, tie order, and absence of broken character references, plus a verified recovery path before production migration.

## Implementation follow-through

- Product design is confirmed. Detailed text validation and presentation are implementation requirements, not further product choices.
- Complete the reference inventory, migration rehearsal, recovery verification, and acceptance tests in the implementation plan before production rollout.

## Repository constraints already verified

- `lib/catalogDb.js` currently publishes ranks by favourites descending, then numeric character ID ascending. Numeric counts cannot always strictly separate an inserted character from its neighbors.
- `lib/characterRolls.js` uses both favourites and rank in some eligibility conditions. Generated likes can therefore affect gameplay.
- `lib/mysteryOdds.js` derives mystery-event odds from rank.
- `lib/franchiseCatalog.js` currently models franchise membership through anime appearances.
- `lib/characterImages.js` supports portrait fallback but currently labels that fallback as AniList sourced.

## Interview progress

1. Rank persistence: insertion only, accepted.
2. Generated-like provenance: `[generated]` on every revealed generated count; imported presentation unchanged, accepted.
3. No-gap insertion: equal counts allowed with explicit tie ordering, accepted.
4. Between-neighbor generation: midpoint rounded down, accepted.
5. Boundary generation: leader plus one, trailing count minus one floored at zero, empty catalog zero; nonnegative safe integers with overflow rejection, accepted.
6. Gameplay: generated likes and ranks participate normally, including threshold changes caused by insertion, accepted.
7. Portal-first addition with preview and confirmation, accepted.
8. One or more existing/new franchises per manual character, direct durable membership, accepted.
9. Franchise info: required name; optional aliases, cover, reference URL; text-only fallback and existing-metadata reuse, accepted.
10. Character fields: required name, franchises, insertion rank, portrait, explicit gender; unknown/unspecified enters both gender pools. Optional aliases, description, reference URL, approved tag; system-assigned identity and likes, accepted.
11. Duplicate handling: warn using names/aliases/franchises, permit reuse, require explicit distinction explanation to override, never auto-merge, and enforce unique external references, accepted.
12. Source linking preserves manual data and generated likes; explicit preview/confirmation is required to switch to AniList-managed likes, accepted.
13. Repositioning: explicit rank-based preview and confirmation, regenerate likes, preserve relationships; source-managed counts switch explicitly to generated; no free-form likes field initially, accepted.
14. Original access decision: keep access unchanged. Superseded by decisions 30–31.
15. Removal: disallow removing published characters in the initial version; no retirement/restoration feature, accepted.
16. Availability: automatic consistent character/franchise index reload after atomic publication, without routine bot restarts, accepted.
17. Ties: preserve existing order during migration and refreshes; exact manual placement; new imported ties append in AniList ID order within their batch, accepted.
18. Images: HTTPS URL-only portraits/covers, browser preview, no arbitrary server-side image fetch or uploads; existing validated/general-rated tag flow, accepted.
19. Franchise freshness: preserve anime completeness tracking, narrow invalidation to relevant changes, and make direct manual memberships independently available, accepted.
20. Active gameplay: published rolls/events retain captured terms; pending rank-dependent actions revalidate safely; new actions use current catalog; UUID-bound targets, accepted.
21. Clue Reveal: exclude characters lacking a suitable anime target; no franchise fallback (earlier fallback request withdrawn), accepted.
22. UUID migration: maintenance window, backup, safe cancellation/refunds, preservation of retained data, and graceful expiry of old interactions rather than compatibility support, accepted.
23. Mutation history: minimal timestamped before/after log, no general undo; idempotent confirmations, accepted. Original no-attribution policy superseded for new authenticated changes by decision 30.
24. Bootstrap: support empty/manual-only catalogs without requiring an AniList import; retain bulk import permission requirements, accepted.
25. Editing scope: full metadata editing for manually created characters only; durable aliases/memberships, existing tag corrections, explicit repositioning, and source linking supported for imported identities without general metadata overrides, accepted.
26. Source verification: require a successful single-character AniList identity preview and confirmation; reject occupied references; leave data unchanged on API failure, accepted.
27. Import checkpoints: preserve published data, discard unfinished staging/cursors, explicitly restart incomplete imports after migration; no automatic network import during migration, accepted.
28. Incorrect source links: allow verified replacement/unlinking without merging or changing UUID/relationships; freeze previously source-managed likes as generated; history and confirmation required, accepted.
29. Final-position repositioning, serialized publication/stale-preview rejection, membership corrections, and verified migration rehearsal/recovery requirements, accepted.
30. Authentication: environment-configured admin plus moderator accounts; protect entire portal, no public registration. Supersedes decision 14 and no-attribution portion of decision 23.
31. Moderator boundary: catalog/franchise/tag/report management allowed; configuration access, item grants, added rolls, and claim resets forbidden. Enforce server-side on every API, accepted.
