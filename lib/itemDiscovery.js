/** Install permanent guild discovery tracking without backfilling existing inventory. */
export function initItemDiscovery(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS guild_item_discoveries (
      guild_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      discovered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (guild_id, item_id)
    );
    CREATE TRIGGER IF NOT EXISTS user_inventory_discover_item
    AFTER INSERT ON user_inventory
    BEGIN
      INSERT INTO guild_item_discoveries (guild_id, item_id)
      VALUES (NEW.guild_id, NEW.item_id)
      ON CONFLICT(guild_id, item_id) DO NOTHING;
    END;
  `);
}

function hasDiscoveryTable(db) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'guild_item_discoveries'").get());
}

/** Return the permanently discovered item kinds for this guild. */
export function getDiscoveredItemIds(db, guildId) {
  if (!hasDiscoveryTable(db)) return new Set();
  return new Set(db.prepare('SELECT item_id FROM guild_item_discoveries WHERE guild_id = ?')
    .all(guildId).map(row => row.item_id));
}

/**
 * Explicitly backfill only current inventory, never historical acquisitions.
 * newDiscoveries counts missing guild/item pairs (including in dry runs);
 * insertedDiscoveries counts actual writes. Other counts describe the scoped scan.
 * Dry runs execute no DDL or writes and work on a read-only, pre-discovery DB.
 */
export function syncItemDiscovery(db, { guildId, dryRun = false } = {}) {
  const where = guildId === undefined ? '' : 'WHERE guild_id = ?';
  const params = guildId === undefined ? [] : [guildId];
  db.exec('SAVEPOINT sync_item_discovery');
  try {
    if (!dryRun) initItemDiscovery(db);
    const { scannedInventoryRows, scannedGuilds } = db.prepare(`
      SELECT COUNT(*) AS scannedInventoryRows, COUNT(DISTINCT guild_id) AS scannedGuilds
      FROM user_inventory ${where}
    `).get(...params);
    const candidates = `SELECT DISTINCT guild_id, item_id FROM user_inventory ${where}`;
    const { candidateDiscoveries } = db.prepare(`SELECT COUNT(*) AS candidateDiscoveries FROM (${candidates})`).get(...params);
    const existingDiscoveries = hasDiscoveryTable(db)
      ? db.prepare(`SELECT COUNT(*) AS count FROM (${candidates}) AS inventory
          JOIN guild_item_discoveries AS discovery
          ON discovery.guild_id = inventory.guild_id AND discovery.item_id = inventory.item_id`).get(...params).count
      : 0;
    const newDiscoveries = candidateDiscoveries - existingDiscoveries;
    let insertedDiscoveries = 0;
    if (!dryRun) {
      insertedDiscoveries = db.prepare(`
        INSERT INTO guild_item_discoveries (guild_id, item_id)
        SELECT guild_id, item_id FROM (${candidates}) WHERE 1
        ON CONFLICT(guild_id, item_id) DO NOTHING
      `).run(...params).changes;
    }
    db.exec('RELEASE sync_item_discovery');
    return { dryRun, scannedInventoryRows, scannedGuilds, candidateDiscoveries, existingDiscoveries, newDiscoveries, insertedDiscoveries };
  } catch (error) {
    db.exec('ROLLBACK TO sync_item_discovery; RELEASE sync_item_discovery');
    throw error;
  }
}
