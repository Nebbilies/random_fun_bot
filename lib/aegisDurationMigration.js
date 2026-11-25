import { getItemRules } from "./itemRuntimeConfig.js";

export const AEGIS_DURATION_ROLLOUT_KEY = "__aegis_duration_rollout_v1";

export function isAegisDurationMigrationPending(db) {
  return (
    !db
      .prepare(
        `SELECT 1 FROM game_config_overrides
      WHERE scope_id='' AND key=?`,
      )
      .get(AEGIS_DURATION_ROLLOUT_KEY) &&
    Boolean(
      db
        .prepare(
          `SELECT 1 FROM character_protection_locks
      WHERE lock_type='soulbind' AND protected_until IS NULL LIMIT 1`,
        )
        .get(),
    )
  );
}

/** Caller owns the write transaction. Records rollout once and gives legacy soulbinds a fresh configured term. */
export function migrateAegisDuration(db, { now = Date.now() } = {}) {
  if (!Number.isSafeInteger(now) || now < 0)
    throw new Error("Invalid Aegis duration rollout time");
  if (!isAegisDurationMigrationPending(db)) return false;

  const locks = db
    .prepare(
      `SELECT guild_id, character_id FROM character_protection_locks
    WHERE lock_type='soulbind' AND protected_until IS NULL`,
    )
    .all();
  if (!locks.length) return false;
  const update =
    db.prepare(`UPDATE character_protection_locks SET protected_until=?
    WHERE guild_id=? AND character_id=? AND lock_type='soulbind' AND protected_until IS NULL`);
  const deadlines = new Map();
  for (const lock of locks) {
    let deadline = deadlines.get(lock.guild_id);
    if (deadline === undefined) {
      deadline =
        now + getItemRules(db, lock.guild_id, "aegis_of_fidelity").protectionMs;
      if (!Number.isSafeInteger(deadline))
        throw new Error(
          `Invalid Aegis duration deadline for guild ${lock.guild_id}`,
        );
      deadlines.set(lock.guild_id, deadline);
    }
    update.run(deadline, lock.guild_id, lock.character_id);
  }
  db.prepare(
    "INSERT INTO game_config_overrides(scope_id,key,value_json) VALUES(?,?,?)",
  ).run("", AEGIS_DURATION_ROLLOUT_KEY, JSON.stringify(now));
  return true;
}
