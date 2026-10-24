# Guild item list and discovery

Status: approved and implemented.

## Commands and presentation

- Add traditional guild prefix command `itemlist` with alias `il` (examples: `!itemlist`, `!il`); respect the configured guild prefix. Do not register slash commands.
- Show the full item catalog, including items disabled as vault rewards.
- Each row is `• **Item name** - description` for discovered items and exactly `• **???** - ???` for undiscovered items.
- Use guild-effective descriptions for discovered items.
- Order by rarity (Common, Rare, Epic, Legendary), then item name. Paginate at ten rows per page, with an additional text-size bound.
- Use Discord Components V2 with a rarity select: All items (default), Common, Rare, Epic, Legendary.
- Anyone viewing the message may use its shared controls; updates affect that message for everyone.
- Reuse existing game-control lifetime, expiration disabling, mention suppression, and pagination conventions.

## Discovery

- Discovery is guild-wide, permanent, and scoped to an item kind, not an individual inventory entry or user.
- Successful acquisition establishes discovery, including ordinary vault delivery, Alchemist rewards, and administrative grants.
- Reveal alone does not establish discovery. Declined, lost, or overflowed rewards do not count unless successfully acquired later.
- Consuming or removing every copy does not erase discovery.
- Reward eligibility does not control catalog visibility or erase discovery.
- Introduce persistent discovery storage; current inventories alone are not a permanent record.

## Existing-inventory sync script

- Provide an idempotent script to mark item kinds discovered from all users' current stored inventories, grouped by guild.
- Support a single guild or all guilds, and a dry-run option.
- Do not change user inventories, fetch Discord members, or reconstruct historical acquisitions or uses.
- Rerunning the script must not remove discoveries or duplicate records.

### Running the sync

```sh
# Preview all guilds without writing or migrating the database
npm run items:sync-discovery -- --dry-run

# Sync all guilds
npm run items:sync-discovery

# Sync one guild (optionally choose a database)
npm run items:sync-discovery -- --guild 123456789012345678 --db data/bot.sqlite
```

The script reports scanned inventory rows/guilds, candidate guild/item discoveries, already known pairs, new discoveries, and inserted discoveries. The default database is `data/bot.sqlite` relative to the npm project directory. Back up the database before a production sync. Run the sync once after deployment to reveal currently held items; subsequent successful acquisitions are tracked automatically and atomically with inventory insertion. An existing open list refreshes discovery when its controls are used.

## Implementation checks

- Both command names use the early game-command dispatch path.
- Verify successful acquisitions mark discovery, failed/full acquisitions do not, and discovery survives consumption.
- Verify guild isolation and all acquisition sources.
- Verify undiscovered output conceals both name and description.
- Verify rarity filters, ordering, shared navigation, pagination, expiration, and effective guild descriptions.
- Verify sync dry runs make no discovery changes and repeated real runs are idempotent.
