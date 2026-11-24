import { guildsAtCutoff } from '../features/seasons/seasonStore.js';
/** Remove only expired entries with no live source authority. Eligibility never relies on cleanup. */
export function cleanupExpiredItems(db, { now = Date.now(), limit = 100 } = {}) {
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error('Invalid item expiry cleanup bounds');
  }
  const fortune = Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='fortune_holds' AND type='table'").get());
  // The mutation is one statement: a reservation cannot be inserted between
  // selecting a candidate and deleting its source, even across connections.
  const result = db.prepare(`DELETE FROM user_inventory WHERE id IN (
    SELECT i.id FROM user_inventory i WHERE i.expires_at <= ?
      AND i.guild_id NOT IN (SELECT value FROM json_each(?))
      AND NOT EXISTS (SELECT 1 FROM item_action_costs c WHERE c.inventory_id=i.id)
      AND NOT EXISTS (SELECT 1 FROM item_use_reservations r WHERE r.inventory_id=i.id)
      ${fortune ? `AND NOT EXISTS (SELECT 1 FROM fortune_holds h WHERE h.inventory_id=i.id)
      AND NOT EXISTS (SELECT 1 FROM fortune_armed a WHERE a.inventory_id=i.id)` : ''}
      ORDER BY i.expires_at,i.id LIMIT ?
  )`).run(now, JSON.stringify(guildsAtCutoff(db)), limit);
  return result.changes;
}
