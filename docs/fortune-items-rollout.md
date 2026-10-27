# Fortune items Phase 1 rollout

## Routine deployment

Fortune adds a small set of tables; this is not a destructive catalog conversion. Deploy normally. On writable startup, the application recognizes the exact supported pre-Fortune v12 schema and installs the additive extension in one SQLite transaction before validation. Repeated startup does not reapply it. Existing inventory, ownership, and captured vault terms remain unchanged.

The migration is bounded to the known historical schema. Unknown, partial, weakened or incompatible schemas are refused, not guessed or silently repaired. Read-only tools cannot perform a migration; start the writable application first if they encounter a supported pre-Fortune file.

Normal deployment backup practices still apply. Manual maintenance is reserved for substantial or risky schema changes; it is not a requirement for this release. No live database was opened or migrated during implementation.

## Optional diagnostic rehearsal

Operators who want to inspect the additive upgrade before normal startup can use the standalone utility on an offline copy:

```sh
node scripts/upgradeFortuneCatalog.js /absolute/path/catalog-copy.sqlite
```

Default is rollback-only rehearsal. Explicit `--commit` is available for an operator-managed upgrade but is not part of routine deployment. Never use character identity conversion to rerun a final-v12 catalog conversion.

## Validation and recovery

Startup performs schema validation and the existing runtime preflight/recovery. Existing vault snapshots without Fortune capability finish with their original rules; armed Recast waits for an eligible new reward. Investigate blockers rather than deleting pending states or rerolling rewards to force readiness.

Discord messages and SQLite transactions cannot commit atomically. Candidates, costs, terminal choices, and inventory delivery are durable; message delivery acknowledgement can remain uncertain after a crash. Lens recovery inspects the canonical card before refunding an apparently unpublished reveal and defers unverifiable transport failures rather than guessing. Recast resumes privately using the owner-only button on its public reward card.

## Release record

See `docs/item-release-changelog.md` for future item releases. The initial fixed date is 28/10/2026; adjust before publication if release moves. Names remain masked per guild until successful acquisition.
