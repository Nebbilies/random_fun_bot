# Manual character addition — implementation plan

## Authority and scope

Implement the [confirmed design](./manual-character-addition-design.md). This plan is not a production migration execution record. No production database should be opened for migration during implementation or tests.

Deliver source-independent UUID identities, deterministic rank insertion, durable manual franchise membership, a manual-character portal, and environment-configured admin/moderator authentication. Preserve existing game relationships and traditional prefix commands; do not register slash commands.

Do not add published-character deletion/retirement, image uploads, automatic identity merging, general imported-metadata overrides, a free-form likes editor, public registration, or a general undo system. Preserve unrelated work already in the checkout.

## 1. Baseline and reference inventory

Read the current schema and every character-reference consumer before changing storage. Inventory columns, JSDoc types, URL parameters, Discord component payloads, API contracts, caches, in-memory state, JSON snapshots, and importer cursors. Distinguish character UUIDs from AniList IDs, anime IDs, marriage/roll/session/item IDs, ranks, and Discord snowflakes.

Starting points:

- `lib/catalogDb.js`, `lib/gameCharacterLookup.js`, `lib/characterWishlist.js`.
- `lib/characterMarriage.js`, `lib/characterTrade.js`, `lib/characterRolls.js`, `lib/characterRollRuntime.js`.
- `lib/itemStorage.js`, `lib/itemActionStorage.js`, `lib/itemActions.js`, `lib/itemActionRuntime.js`, `lib/tradeRuntime.js`, mystery coordinator/event modules.
- `scripts/importCharacterCatalog.js`, `scripts/importFranchiseCatalog.js`, tag matchers/review tools, `lib/anilistCatalogApi.js`.
- Commands, `index.js`, portal handlers/assets, and relevant tests.

Explicit hazards: non-character rolls currently use character ID zero; some references lack foreign keys; `duckduckgo_tag_attempts` has a cascading reference to published rows; serialized JSON requires shape-specific handling rather than global number replacement.

Capture baseline tests/type checks and representative pre-migration fixtures, including retained identities, tied ranks, manual tag decisions, pending/refundable actions, zero sentinels, and incomplete imports. Never generate fixtures from secret-bearing production data.

## 2. Identity schema and offline migration

Introduce UUID character identities using Node's `crypto.randomUUID()`, stored as text. Separate unique `(source, external_id)` references from internal identity. Track creation method, likes provenance, durable curated aliases/memberships, and persistent tie order independently.

Build an explicit maintenance migration with dry-run/rehearsal support, schema-version checks, transaction/rollback behavior, and a report of counts/invariants. Do not let an ordinary unattended startup silently perform the cross-cutting production conversion.

- Construct one mapping for every retained legacy character identity/reference, not only current published rows.
- Migrate all permanent references and classified historical snapshots without changing ownership, wishes, tags, or history.
- Safely cancel pending gameplay through domain-specific settlement/refund rules; release reservations. Preserve the cancellation record.
- Replace or explicitly classify non-character sentinels without creating fake identities.
- Preserve existing tied-character rank order independently of UUID values.
- Preserve published anime/franchise data; reset unfinished staging and legacy cursors only. Require explicit import restarts, never automatic network scans.
- Expire pre-migration components gracefully. Do not attempt numeric-ID interaction compatibility.
- Verify no unresolved character references, accidental cascade losses, or duplicate source mappings before commit/restart.

Keep database recovery separate from business undo: retain a verified offline backup and document restoration using the compatible pre-migration application version.

## 3. Source-aware imports and shared catalog publication

Keep external numeric IDs at API/staging boundaries where appropriate; resolve to UUIDs before joining published game data. Make character and franchise imports source-aware, skipping unlinked manual identities for AniList queries.

Preserve manually created metadata, curated aliases/memberships, and generated counts on refresh. Reuse linked identities; never create a second identity for an occupied external reference. Preserve current growing-catalog eligibility and written-permission gates.

Centralize atomic publication and a durable catalog revision. Serialize commits across processes, check revisions inside write transactions, and avoid holding database locks during network calls. Stage remote data outside the publication transaction and re-check field/source ownership before applying it.

Rank by count descending then persistent tie order. Preserve existing order on migration and refresh. New imported equal-count characters append to existing tied groups, ordered by AniList ID within each batch.

Acceptance: rerunning/resuming imports cannot duplicate linked identities or overwrite generated counts/curation; failed publication leaves prior data intact.

## 4. Rank insertion and mutation service

Provide one validated service for preview/confirm of creation, metadata editing, repositioning, source linking/correction, and likes-source switching. The portal must not implement separate ranking SQL.

Rules:

- Creation rank is 1 through N+1; reposition rank is the final position in the N-character result after excluding the moved character when computing neighbors.
- Between neighbors: `lower + floor((upper - lower) / 2)` using validated nonnegative safe integers. Avoid an overflowing `upper + lower` sum.
- First: leader plus one; last: max(0, lowest minus one); empty: zero. Handle a sole-character reposition explicitly as the empty-neighbor case.
- Permit equal counts; persistent tie order must guarantee the requested final position without modifying anyone else's likes.
- Generated counts remain fixed until an explicit action; never offer a free-form count field.
- Source-managed repositioning explicitly switches to generated counts. Switching to AniList-managed counts requires a verified link, current fetched count, and preview/confirmation.
- Unlink/replacement preserves identity; previously source-managed counts freeze as generated. No identity merging. Invalidate or refresh cached source-derived appearance relationships when their source association changes; never lose curated memberships.

Bind previews to validated payloads and relevant revisions. Confirmations are idempotent and reject stale state. Persist the mutation, audit record, revision, and idempotency result atomically. Repeated successful requests return the original result, while reuse with different input is rejected. Include authenticated account/role and duplicate-override explanations; never log credentials.

Validate text lengths, empty/duplicate aliases, enums, URLs, and output escaping consistently. Check duplicate names/aliases/franchises and permit an explicit reasoned distinct-character override. Reuse adds curation without changing identity/ownership/likes.

## 5. Direct franchises and relevant completeness tracking

Extend franchise metadata with optional curated cover/reference URL. Add durable direct character memberships and shared deduplicated read paths combining them with anime-derived memberships.

Update franchise lists, marriage grouping, roll filters, franchise-dependent items, covers, and search—not only `!ima`/`!imar`. Manual characters require at least one membership; membership corrections must preserve that invariant. Imported membership grouping behavior should not be accidentally changed.

Replace global publication-timestamp invalidation with relevant anime-enrichment coverage/revision tracking. Likes, ranks, curated metadata, and manual-only additions must not invalidate anime data. Linked characters awaiting appearance enrichment remain distinguishable from already-covered identities. Direct memberships remain available independently; consumers must follow a consistent freshness policy rather than some bypassing the gate.

Use anime covers when suitable, otherwise curated cover, otherwise text-only. No fake anime records, and no franchise-name fallback puzzle.

## 6. Gameplay, display, and coherent reload

Change numeric character validation/parsing/types to UUID-aware handling while keeping all other identifier types intact. Review component lengths and parsers with UUID values. Gracefully expire old components.

Centralize likes display/provenance so every revealed generated count appends `[generated]`, including cards, lists, and event results. Hidden likes hide the label. Rename portrait fallback provenance so manual URLs are not falsely described as AniList images.

Refresh character/franchise indexes from durable revisions before subsequent catalog-dependent operations. Verify coherent reads across portal and bot processes; do not rely on a notification sent only inside the portal process. Bound an operation to a consistent catalog revision/read snapshot where it combines cached and database-backed data.

Preserve captured terms for published rolls/running events; revalidate pending rank-sensitive exchanges/items and safely cancel invalidated actions. Targets are UUID-bound. Generated likes have normal gameplay meaning. Unknown/unspecified gender follows existing both-pools behavior. Clue Reveal remains unavailable without suitable anime data; event selection falls back to a normal roll if no compatible event exists.

Support empty and manual-only catalogs without a completed AniList-import prerequisite.

## 7. Portal authentication and authorization

Build shared authentication/authorization for both server entry points, before exposing new editing endpoints. Preserve existing Host/Origin defenses and loopback defaults.

- Two environment-configured accounts: admin and moderator. No registration or account editor.
- Store salted password hashes; provide an offline password-hash generation procedure that does not place plaintext in command-line arguments, logs, or source control.
- Explicit environment loading and documented variable names. Validate both accounts and reject missing/invalid configuration at startup.
- Use opaque server-side sessions, HttpOnly/SameSite cookies, Secure cookies for HTTPS, session expiry/logout, login rate limiting, and CSRF defenses. Trust proxy headers only under explicitly documented proxy configuration.
- Authenticate portal pages and APIs; allow only intentionally public login assets/routes. Unauthenticated requests receive login/401 behavior as appropriate.
- Admin: all features. Moderator: catalog, franchise, tags/reports only; deny configuration reads/writes, item grants, roll additions, and claim resets.
- Enforce permission checks on endpoints, not only sidebar visibility; standalone franchise server must not be an auth bypass.

Test every route/role combination, expired sessions, invalid CSRF/Origin, login throttling, and absent credentials. Never return environment contents, hashes, passwords, or session secrets in API payloads.

## 8. Portal manual-character workflow

Use the existing plain HTML/CSS/JS portal architecture and shared assets.

Deliver entry → duplicate review → rank/source preview → confirmation → published result, plus search/edit/reposition and mutation history. Required fields: display name, portrait HTTPS URL, explicit gender, target rank, and one or more franchises. Optional aliases, description, reference URL, and validated tag.

Support existing/new franchise selection without overwriting an existing franchise's metadata. HTTPS portrait/cover previews run in the browser; do not server-fetch arbitrary image URLs or add uploads. Render user text safely and document external image hosting/permission responsibilities.

Verify source references with a bounded single-character AniList lookup before confirmation; errors leave data unchanged. No arbitrary URL fetching: construct requests against the fixed source API. Revalidate external-reference uniqueness at commit.

Show generated provenance and rank impacts clearly. Require refreshed previews after conflicting edits, retain form input on recoverable errors, and make successful retries safe. No published-character removal controls or APIs.

## 9. Verification and rollout gates

Run targeted tests after each phase, then `npm test`, `npm run typecheck:catalog`, and diff checks. Expand the narrow type-check coverage only where appropriate; do not suppress UUID errors with broad `any` casts.

Required acceptance scenarios:

- Legacy migration preserves identities/relationships/history and exact tied order; cancellation/refunds and zero sentinels are correct; migration failure rolls back.
- Rank insertion/reposition covers equal/consecutive counts, repeated gap exhaustion, boundaries, empty/single catalogs, stale previews, overflow, and idempotent retries.
- Manual characters search, roll, marry, trade/gift, and participate in wishes/items under normal rules.
- Every generated count has its label when revealed, none when hidden.
- Imports preserve curation/generated likes; source correction cannot misattribute old appearances; duplicate references cannot split identity.
- Direct/mixed franchises deduplicate consistently and remain usable without unnecessary anime refreshes.
- Cross-process publication/reload never exposes inconsistent new rank/identity mappings to a subsequent command.
- Active events retain captured terms while pending rank-sensitive actions revalidate without losing refundable costs.
- Admin/moderator/anonymous route matrix enforces the confirmed permissions, including direct requests and alternate server entry points.
- Browser checks cover desktop/mobile forms, duplicate warnings, preview conflicts, login/logout, both roles, and empty/manual-only bootstrap.

Before production: time a full migration rehearsal on a consistent backup, verify all invariants and a recovery procedure, then choose the maintenance window based on measurement with a buffer. Do not estimate migration duration from UUID generation speed alone. Run no production mutation until explicitly scheduled/authorized.

Update catalog/franchise/operator docs for environment setup, credentials, permission matrix, generated likes, source linking, import restarts, automatic reload, maintenance/recovery, and no-removal policy. Update glossary terms as domain language is introduced, preserving unrelated edits.

## Stop condition

The confirmed feature passes the acceptance matrix; the migration has a successful measured rehearsal and documented recovery path; operating docs are accurate. Production rollout is a separate recorded action, not an implicit side effect of completing implementation.
