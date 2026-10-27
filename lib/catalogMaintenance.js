import { getMeta } from './catalogDb.js';

// Persisted gate: every bot process using the same catalog sees it. Existing
// replies/components continue resolving; only new actions are refused.
export function isCatalogDraining(db) {
  // Small isolated item-storage databases predate the catalog gate.
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='catalog_meta'").get()) return false;
  return getMeta(db,'game_maintenance') === 'drain';
}
export function requireNewGameAction(db) {
  if (isCatalogDraining(db)) throw new Error('Character game is draining for maintenance; existing actions may finish.');
}
const NEW_ACTIONS = new Set(['w','h','mu','ru','daily','use','trade','give','divorce','wish']);
export function isNewGameActionCommand(command) { return NEW_ACTIONS.has(command); }
export function catalogDrainStatus(db) {
  const activeRolls=db.prepare("SELECT id,state,command_message_id AS commandMessageId FROM character_rolls WHERE state IN ('pending','open')").all();
  const mysteries=db.prepare("SELECT id,state FROM mystery_sessions WHERE state IN ('reserved','running','countdown','claim_open')").all();
  const itemActions=db.prepare("SELECT id,state FROM item_actions WHERE state NOT IN ('completed','resolved','canceled','failed','expired')").all();
  return {draining:isCatalogDraining(db),activeRolls,mysteries,itemActions,persistedActionsDrained:activeRolls.length===0&&mysteries.length===0&&itemActions.length===0,
    requiresAllWritersStopped:true, note:'In-memory trade/gift/divorce dialogs are not visible here. Finish them and stop every writer before conversion.'};
}
