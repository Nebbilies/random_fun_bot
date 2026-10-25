# Manual character addition — implementation checkpoint

This is a partial implementation, not rollout approval. The confirmed design and plan remain authoritative. No production database has been opened or migrated.

## Implemented foundations

- Full reference inventory: `manual-character-reference-inventory.md`.
- Shared portal authentication for both server entry points, explicit environment accounts, role enforcement, sessions, CSRF, throttling, login/logout UI, password hash utility. See `portal-authentication.md` before restarting the portal: credentials are now mandatory.
- Pure UUID identity/source-key validation and unique source-link primitives. Not yet integrated into existing numeric-ID consumers.
- Pure rank insertion/reposition previews, generated likes, safe-integer/overflow validation, deterministic integer tie order.
- Shared revealed-count formatter wired into character, marriage, roll and mystery displays. Imported presentation is unchanged; hidden mystery counts stay hidden. Provenance must still be selected/persisted through subsequent schema work.
- Manual metadata validation (HTTPS portrait/reference URLs, explicit gender, nonempty franchise selection, normalized aliases). No manual editor/publication endpoint yet.
- Offline UUID migration foundation and rollback-only rehearsal CLI. Explicit database path is mandatory; CLI rejects default `bot.sqlite`. It neither invokes network imports nor commits a migration.

## Migration limitations — do not deploy as a completed conversion

- Nonempty character-bearing historical JSON requires the shape-specific adapters identified in the inventory. Current preflight deliberately refuses it.
- Pending gameplay, reservations and escrow require reviewed domain cancellation/refund handling; preflight refuses unsafe state rather than inventing refunds.
- Existing schema version/initialization, source-aware import/publication, gameplay references, lookup SQL, caches and portal identifier parsing are not converted to UUIDs.
- Library commit primitive exists only for explicit future schema integration; normal startup does not invoke it. No production-capable migration CLI is exposed.
- Tests for version gates use current synthetic legacy schemas, not an exhaustive historical schema fixture library.

## Verification at checkpoint

- Before changes: `npm test` — 456 passed; `npm run typecheck:catalog` passed.
- After changes: `npm test` — 504 passed, 0 failed; `npm run typecheck:catalog` passed.
- Focused migration fixtures: 29 passed, including rollback/cascade/reference checks.
- Focused auth verification includes authenticated portal behavior, role/API denial, login/logout and startup validation.
- No production-data rehearsal, measured downtime, or production browser smoke test has occurred.

## Next integration work

1. Finish historical JSON adapters and domain-specific maintenance settlement.
2. Coordinate explicit new schema, UUID consumer conversion and fixtures; retain source IDs only at API boundaries.
3. Implement source-aware imports and shared revision-bound atomic publication, preserving curation and generated likes.
4. Implement durable direct franchise memberships and relevant enrichment completeness.
5. Wire validated preview/confirm mutation service, audit/idempotency, and manual-character portal workflows.
6. Cover coherent cross-process reloads and active gameplay rules; run full acceptance/browser checks.
7. Rehearse on a consistent disposable backup and verify restoration before separately authorized production migration.
