import { prepareTransferCancellation } from './tradeRuntime.js';

/** Called inside the ownership transaction. Only durable writes happen here.
 * The returned callback must run synchronously after COMMIT, never on rollback.
 * Escape controls consult their durable roll state; Hostage controls consult their
 * action state. Transfers are memory-only and disappear entirely on restart.
 */
export function cancelSelectedCharacterInteractions(db, guildId, selected, now) {
  const afterCommit = prepareTransferCancellation(db, guildId, selected);
  const challenges = new Set();
  for (const row of selected) {
    db.prepare(`UPDATE character_rolls SET state='closed', escape_outcome='canceled', escape_resolved_at=?
      WHERE guild_id=? AND character_id=? AND escape_owner_id=? AND escape_marriage_id=?
        AND state IN ('pending','open')`).run(now, guildId, row.characterId, row.ownerId, row.marriageId);
    for (const reservation of db.prepare(`SELECT action_id FROM item_character_reservations
      WHERE guild_id=? AND character_id=? AND owner_id=? AND marriage_id=?`)
      .all(guildId, row.characterId, row.ownerId, row.marriageId)) challenges.add(reservation.action_id);
  }
  for (const id of challenges) {
    // No cancelUndeliveredHostage: it can restore Crown state. A delivered Note
    // stays spent; an undelivered Note merely leaves escrow, never gains a copy.
    const result = { status: 'canceled', canceledBy: 'kaimetsu', message: 'Hostage challenge canceled by Kaimetsu. No exchange or additional divorce.' };
    db.prepare(`UPDATE item_actions SET state='canceled', result_json=?, delivery_pending=1
      WHERE id=? AND guild_id=? AND kind='hostage_note' AND state IN ('active','awaiting_delivery')`)
      .run(JSON.stringify(result), id, guildId);
    db.prepare('DELETE FROM item_character_reservations WHERE action_id=?').run(id);
    db.prepare('DELETE FROM item_action_costs WHERE action_id=?').run(id);
  }
  return afterCommit;
}
