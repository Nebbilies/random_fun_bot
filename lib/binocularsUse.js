import { randomUUID } from 'node:crypto';
import { transaction } from './catalogDb.js';
import { getUsableInventory } from './itemStorage.js';
import { getItemActionSource, consumeItemActionSource, releaseItemActionSource, reserveItemActionSource } from './itemActionStorage.js';

/** A terminal action envelope keeps DM delivery out of confirmation/Hostage recovery. */
export function reserveBinocularsUse(db, { guildId, userId, channelId, inventoryId, sessionId, now }) {
  return transaction(db, () => {
    const source = getUsableInventory(db, guildId, userId, now).find(i => i.id === inventoryId && i.item_id === 'binoculars');
    if (!source) return null;
    const id = randomUUID();
    db.prepare(`INSERT INTO item_actions(id,kind,guild_id,actor_id,channel_id,inventory_id,state,selections_json,result_json,created_at,expires_at)
      VALUES(?,'binoculars',?,?,?,?,'resolved','{}',?, ?,?)`)
      .run(id, guildId, userId, channelId, source.id, JSON.stringify({ status: 'dm_pending', sessionId }), now, now);
    reserveItemActionSource(db, id, source, now);
    return id;
  });
}

export function settleBinocularsUse(db, id, delivered) {
  return transaction(db, () => {
    const action = db.prepare("SELECT * FROM item_actions WHERE id=? AND kind='binoculars'").get(id);
    if (!action || JSON.parse(action.result_json).status !== 'dm_pending') return false;
    const { sessionId } = JSON.parse(action.result_json);
    if (!getItemActionSource(db, action)) throw new Error('Missing reserved Binoculars source');
    if (delivered) consumeItemActionSource(db, action);
    else releaseItemActionSource(db, id);
    if (delivered && Number.isSafeInteger(sessionId)) {
      const session = db.prepare('SELECT state_json FROM mystery_sessions WHERE id=?').get(sessionId);
      if (session) {
        const state = JSON.parse(session.state_json);
        state.runtime = { ...state.runtime, binocularsUsed: true };
        db.prepare('UPDATE mystery_sessions SET state_json=? WHERE id=?').run(JSON.stringify(state), sessionId);
      }
    }
    db.prepare('UPDATE item_actions SET result_json=? WHERE id=?').run(JSON.stringify({ status: delivered ? 'resolved' : 'canceled' }), id);
    return true;
  });
}

/** An interrupted DM may have arrived: charge once, never resend a secret answer. */
export function recoverBinocularsUses(db) {
  const pending = db.prepare("SELECT id FROM item_actions WHERE kind='binoculars' AND json_extract(result_json,'$.status')='dm_pending'").all();
  for (const { id } of pending) settleBinocularsUse(db, id, true);
  return pending.length;
}
