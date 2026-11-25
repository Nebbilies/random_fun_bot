function validTime(now) {
  if (!Number.isSafeInteger(now) || now < 0)
    throw new Error("Invalid ownership operation time");
}

/** Synchronous scope only. Joins caller transactions; otherwise owns a write
 * transaction. Nested scopes restore the outer clock even on failure. Legacy
 * integer catalogs intentionally have no history and remain supported writers. */
export function withOwnershipOperationClock(db, now, callback) {
  validTime(now);
  if (callback?.constructor?.name === "AsyncFunction")
    throw new Error(
      "Ownership operation clock requires a synchronous callback",
    );
  const supported = !!db
    .prepare(
      "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='ownership_operation_clock'",
    )
    .get();
  const owns = !db.isTransaction;
  if (owns) db.exec("BEGIN IMMEDIATE");
  else db.exec("SAVEPOINT ownership_operation_scope");
  let previous;
  try {
    if (supported) {
      previous = db
        .prepare(
          "SELECT now_ms FROM ownership_operation_clock WHERE singleton=1",
        )
        .get();
      if (!previous || (owns && previous.now_ms !== null))
        throw new Error("Invalid ownership operation clock context");
      db.prepare(
        "UPDATE ownership_operation_clock SET now_ms=? WHERE singleton=1",
      ).run(now);
    }
    const result = callback();
    if (result && typeof result.then === "function")
      throw new Error(
        "Ownership operation clock requires a synchronous callback",
      );
    if (supported)
      db.prepare(
        "UPDATE ownership_operation_clock SET now_ms=? WHERE singleton=1",
      ).run(previous.now_ms);
    if (owns) db.exec("COMMIT");
    else db.exec("RELEASE SAVEPOINT ownership_operation_scope");
    return result;
  } catch (error) {
    if (owns) {
      if (db.isTransaction) db.exec("ROLLBACK");
    } else if (db.isTransaction) {
      db.exec(
        "ROLLBACK TO SAVEPOINT ownership_operation_scope; RELEASE SAVEPOINT ownership_operation_scope",
      );
    }
    throw error;
  }
}

const projection =
  "guild_id AS guildId, former_owner_id AS formerOwnerId, character_id AS characterId, lost_at AS lostAt";
// Fail closed on unsupported legacy storage, rather than claiming complete history.
export function getLatestOwnershipLoss(
  db,
  guildId,
  formerOwnerId,
  characterId,
) {
  return (
    db
      .prepare(
        `SELECT ${projection} FROM character_ownership_losses
    WHERE guild_id=? AND former_owner_id=? AND character_id=?`,
      )
      .get(guildId, formerOwnerId, characterId) ?? null
  );
}
export function listRecentOwnershipLosses(
  db,
  { guildId, formerOwnerId, now = Date.now(), historyWindowMs },
) {
  validTime(now);
  if (!Number.isSafeInteger(historyWindowMs) || historyWindowMs <= 0)
    throw new Error("Invalid ownership history window");
  return db
    .prepare(
      `SELECT ${projection} FROM character_ownership_losses
    WHERE guild_id=? AND former_owner_id=? AND lost_at BETWEEN ? AND ?
    ORDER BY lost_at DESC,character_id`,
    )
    .all(guildId, formerOwnerId, Math.max(0, now - historyWindowMs), now);
}
