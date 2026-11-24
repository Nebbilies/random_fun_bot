import { transaction } from '../../lib/catalogDb.js';
import { SEASON_RECEIPT_TABLES, hasSeasonSchema, seasonReceiptKey } from '../../lib/seasonSchema.js';
import { inspectLegacyVaultAbandonment } from '../../lib/legacyVaultAbandonment.js';
import { seasonCutoffReached } from './seasonStore.js';

// Remove descendants and historical markers while their original IDs are still available.
const related = {
  character_rolls: [
    ['roll_notices','roll_id','id'],
    ['affection_legacy_sources','source_key','command_message_id',"kind='roll'"],
    ['affection_legacy_sources','source_key','id',"kind='roll_id'"],
  ],
  mystery_sessions: [['affection_legacy_sources','source_key','id',"kind='mystery'"]],
  vault_sessions: [
    ['fortune_lens','vault_id','vault_id'],
    ['affection_legacy_sources','source_key','vault_id',"kind IN ('vault','fortune_lens')"],
  ],
  vault_rewards: [
    ['reward_sources','reward_id','vault_id'], ['fortune_recasts','vault_id','vault_id'],
    ['affection_legacy_sources','source_key','vault_id',"kind IN ('reward','fortune_recast')"],
  ],
  item_actions: [
    ['item_action_costs','action_id','id'], ['item_use_reservations','action_id','id'],
    ['affection_legacy_sources','source_key','id',"kind='item_action'"],
  ],
  reward_grants: [['reward_copies','source_key','source_key']],
};

function tryCleanupTransaction(db, work) {
  const timeout = Number(db.prepare('PRAGMA busy_timeout').get().timeout);
  if (timeout !== 0) db.exec('PRAGMA busy_timeout=0');
  try {
    return transaction(db, work);
  } catch (error) {
    const code = error.errcode & 255;
    if (code !== 5 && code !== 6) throw error;
    // A later worker pass can retry the same batch.
    return 0;
  } finally {
    if (timeout !== 0) db.exec(`PRAGMA busy_timeout=${timeout}`);
  }
}

export function pruneSeasonReceipts(db, {limit=200,now=Date.now()} = {}) {
  if (!hasSeasonSchema(db)) return 0;
  const completed = db.prepare(`SELECT r.guild_id,r.season FROM season_rollovers r JOIN guild_seasons s USING(guild_id)
    WHERE r.phase='applied' AND r.pruned_at IS NULL AND s.season>r.season ORDER BY r.completed_at LIMIT 10`).all();
  let removed = 0;
  const abandoned = completed.length ? [...inspectLegacyVaultAbandonment(db).ids] : [];
  for (const {guild_id:guildId,season} of completed) {
    if (seasonCutoffReached(db,guildId,now)) continue;
    const count = tryCleanupTransaction(db, () => {
      let changes = 0;
      for (const table of SEASON_RECEIPT_TABLES) {
        if (changes >= limit) break;
        const exclusions = table === 'character_rolls' && abandoned.length
          ? `AND p.id NOT IN (SELECT value FROM json_each('${JSON.stringify(abandoned)}'))` : '';
        const select = `SELECT p.rowid AS recordRowId FROM ${table} p
          LEFT JOIN season_receipts r ON r.kind='${table}' AND r.record_key=${seasonReceiptKey(table,'p')}
          WHERE p.guild_id=? AND COALESCE(r.season,0)=? ${exclusions}
          ORDER BY p.rowid LIMIT ?`;
        const ids = db.prepare(select).all(guildId,season,limit-changes).map(row => row.recordRowId);
        if (!ids.length) continue;
        const selected = JSON.stringify(ids);
        for (const [child, foreignKey, primaryKey, condition] of related[table] ?? []) {
          db.prepare(`DELETE FROM ${child} WHERE ${condition ? condition+' AND ' : ''}${foreignKey}
            IN (SELECT ${primaryKey} FROM ${table} WHERE rowid IN (SELECT value FROM json_each(?)))`).run(selected);
        }
        changes += Number(db.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT value FROM json_each(?))`).run(selected).changes);
      }
      if (!changes) {
        db.prepare('DELETE FROM season_players WHERE guild_id=? AND season=?').run(guildId,season);
        db.prepare("UPDATE season_rollovers SET pruned_at=? WHERE guild_id=? AND season=? AND phase='applied'")
          .run(now,guildId,season);
      }
      return changes;
    });
    removed += count;
    if (removed >= limit) break;
  }
  return removed;
}
