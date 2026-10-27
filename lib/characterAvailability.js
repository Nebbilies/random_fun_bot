/** Shared, transaction-neutral character availability. No runtime imports or writes on reads. */
const pendingTransfers = new WeakMap();

/** Register the selected offers of one live trade/gift. Replaces its previous selections.
 * IDs stay opaque: UUID strings and legacy numeric identities are never coerced.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} actionId
 * @param {string} guildId
 * @param {(string | number)[]} characterIds
 * @param {number} [expiresAt]
 */
export function registerPendingTransfer(db, actionId, guildId, characterIds, expiresAt = Infinity) {
  let entries = pendingTransfers.get(db);
  if (!entries) { entries = new Map(); pendingTransfers.set(db, entries); }
  entries.set(actionId, { guildId, characterIds: new Set(characterIds), expiresAt });
}

export function unregisterPendingTransfer(db, actionId) {
  pendingTransfers.get(db)?.delete(actionId);
}

/** Hostage stakes are durable and have no clock-based expiry; settlement releases them.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} guildId
 * @param {string | number} characterId
 * @param {string | null} [exceptActionId]
 */
export function isCharacterReserved(db, guildId, characterId, exceptActionId = null) {
  return Boolean(db.prepare(`SELECT 1 FROM item_character_reservations
    WHERE guild_id = ? AND character_id = ? AND (? IS NULL OR action_id != ?)`)
    .get(guildId, characterId, exceptActionId, exceptActionId));
}

/** @param {import('node:sqlite').DatabaseSync} db
 * @param {string} guildId
 * @param {string | number} characterId
 * @param {number} [now]
 * @param {string | null} [exceptActionId]
 */
export function isCharacterBusy(db, guildId, characterId, now = Date.now(), exceptActionId = null) {
  if (isCharacterReserved(db, guildId, characterId, exceptActionId)) return true;
  if (db.prepare(`SELECT 1 FROM character_rolls WHERE guild_id = ? AND character_id = ?
    AND escape_marriage_id IS NOT NULL
    AND (state = 'pending' OR (state = 'open' AND (expires_at IS NULL OR expires_at > ?)))`)
    .get(guildId, characterId, now)) return true;
  return isCharacterPendingTransfer(db, guildId, characterId, now, exceptActionId);
}

/** Transaction-neutral in-memory offer lookup, also used while selecting natural roll candidates.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} guildId
 * @param {string | number} characterId
 * @param {number} [now]
 * @param {string | null} [exceptActionId]
 */
export function isCharacterPendingTransfer(db, guildId, characterId, now = Date.now(), exceptActionId = null) {
  for (const [actionId, entry] of pendingTransfers.get(db) ?? []) {
    if (actionId !== exceptActionId && entry.guildId === guildId && entry.expiresAt > now
      && entry.characterIds.has(characterId)) return true;
  }
  return false;
}

/** Prizes held before publication, by live cards, or by an active mystery session.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} guildId
 * @param {string | number} characterId
 * @param {number} [now]
 */
export function isCharacterHeld(db, guildId, characterId, now = Date.now()) {
  return Boolean(db.prepare(`SELECT 1 FROM character_rolls WHERE guild_id = ? AND character_id = ?
    AND (state = 'pending' OR (state = 'open' AND expires_at > ?))`)
    .get(guildId, characterId, now)
    || db.prepare(`SELECT 1 FROM mystery_sessions WHERE guild_id = ? AND character_id = ?
      AND state IN ('reserved', 'running', 'countdown', 'claim_open')`)
      .get(guildId, characterId));
}

/** Ownership loss/protection invalidates a defense permanently, even if ownership returns.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} guildId
 * @param {string | number} characterId
 */
export function invalidateCharacterCrown(db, guildId, characterId) {
  return db.prepare('DELETE FROM counterfeit_crowns WHERE guild_id = ? AND character_id = ?')
    .run(guildId, characterId).changes;
}
