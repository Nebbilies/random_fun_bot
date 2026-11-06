import { randomUUID } from 'node:crypto';
import { getAffectionBenefits } from './characterAffection.js';
import { resolveAffectionDecisionInTransaction } from './affectionPerks.js';
import { getUsableInventory, decrementItemCharge } from './itemStorage.js';

// Legacy integer catalogs and isolated item fixtures intentionally keep old rules.
export function hasItemAffection(db) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='affection_schema'").get());
}
export function itemConservationChance(db, guildId, userId) {
  return hasItemAffection(db) ? getAffectionBenefits(db, guildId, userId).perks.item_conservation : 0;
}
export function itemUseInvocationId(options = {}) {
  return `item-use:${options.invocationId ?? options.commandMessageId ?? randomUUID()}`;
}
function requireTransaction(db) {
  if (!db.isTransaction) throw new Error('Affection item use requires caller transaction');
}
/** Immutable scope and committed result must be inspected before mutable inventory. */
export function getItemUseReceipt(db, { invocationId, guildId, userId, channelId = '', kind, inventoryId }) {
  if (!hasItemAffection(db)) return null;
  const row = db.prepare('SELECT * FROM affection_invocations WHERE invocation_id=?').get(invocationId);
  if (!row) return null;
  const envelope = JSON.parse(row.result_json);
  if (row.guild_id !== guildId || row.user_id !== userId || row.channel_id !== channelId || row.kind !== kind
    || envelope.version !== 1 || (inventoryId != null && envelope.inventoryId !== inventoryId)
    || !envelope.result || typeof envelope.result !== 'object') throw new Error('Item invocation scope mismatch or corrupt receipt');
  return envelope.result;
}
export function saveItemUseReceipt(db, { invocationId, guildId, userId, channelId = '', kind, inventoryId, result, now }) {
  if (!hasItemAffection(db)) return result;
  requireTransaction(db);
  db.prepare('INSERT INTO affection_invocations(invocation_id,guild_id,user_id,channel_id,kind,result_json,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(invocationId, guildId, userId, channelId, kind, JSON.stringify({ version: 1, inventoryId, result }), now);
  return result;
}
/** Capture at semantic commitment, not at a menu/hold, and before consequences.
 * @param {any} db
 * @param {{sourceKey:string,guildId:string,userId:string,chance?:number,now?:number,random?:()=>number,ordinal?:number}} options
 */
export function captureAffectionItemUseInTransaction(db, { sourceKey, guildId, userId, chance = undefined, now = Date.now(), random = Math.random, ordinal = 0 }) {
  requireTransaction(db);
  if (!hasItemAffection(db)) return { version: 1, chance: 0, triggered: false, actualDebit: 1 };
  const decision = resolveAffectionDecisionInTransaction(db, { sourceKey, guildId, userId, effect: 'item_conservation',
    chance: chance ?? itemConservationChance(db, guildId, userId), now, random, ordinal });
  return { version: 1, ...decision, actualDebit: decision.triggered ? 0 : 1 };
}
/** Ordinary unheld source only. Reserved consumers must authorize/release their own hold.
 * @param {any} db
 * @param {{sourceKey:string,guildId:string,userId:string,inventoryId:number,chance?:number,now?:number,random?:()=>number,ordinal?:number}} options
 */
export function spendAffectionItemChargeInTransaction(db, { sourceKey, guildId, userId, inventoryId, chance = undefined, now = Date.now(), random = Math.random, ordinal = 0 }) {
  requireTransaction(db);
  if (!sourceKey) throw new Error('A stable item charge sourceKey is required');
  const scope = { invocationId: `item-charge:${JSON.stringify([sourceKey, guildId, userId, ordinal])}`,
    guildId, userId, kind: 'item_charge', inventoryId };
  const saved = getItemUseReceipt(db, scope);
  if (saved) return saved;
  const source = getUsableInventory(db, guildId, userId, now).find(row => row.id === inventoryId);
  if (!source) throw new Error('Item charge source is unavailable or reserved');
  const terms = captureAffectionItemUseInTransaction(db, { sourceKey, guildId, userId, chance, now, random, ordinal });
  const payment = terms.actualDebit ? decrementItemCharge(db, inventoryId) : { remainingCharges: source.charges, removed: false };
  if (payment.escrowed) throw new Error('Item charge source is reserved');
  const result = { ...payment, actualDebit: terms.actualDebit, conserved: terms.triggered, chance: terms.chance };
  return saveItemUseReceipt(db, { ...scope, result, now });
}
