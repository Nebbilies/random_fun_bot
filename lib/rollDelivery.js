import { createHash } from 'node:crypto';
import { ContainerBuilder } from 'discord.js';
import { transaction } from './catalogDb.js';
import { validateCharacterSnapshot } from './characterSnapshot.js';
import { loadRollCharacterSnapshot, publishRoll } from './characterRolls.js';
import { rollCard } from './characterRollRuntime.js';
import { findWishMatchers } from './characterWishlist.js';
import { hasAffection } from './characterAffection.js';
import { flushAffectionRewardsInTransaction } from './affectionRewards.js';

// Installed by the authoritative schema only. Runtime must never create tables.
export { ROLL_DELIVERY_DDL } from './catalogRuntimeSchema.js';

export function hasRollDelivery(db) {
  return Number(db.prepare('PRAGMA user_version').get().user_version) > 10
    && !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='roll_delivery'").get();
}

/** Synchronous: caller must include this in the allowance/buff reservation transaction. */
export function captureRollDelivery(db, { rollId, userId, remaining, characterSnapshot,
  image = characterSnapshot.image_url ? { url: characterSnapshot.image_url } : null }) {
  if (!hasRollDelivery(db)) return false;
  validateCharacterSnapshot(characterSnapshot, characterSnapshot.id);
  if (!/^\d+$/.test(userId) || !Number.isSafeInteger(remaining) || remaining < 0) {
    throw new Error('Invalid roll delivery capture');
  }
  const roll = db.prepare('SELECT * FROM character_rolls WHERE id=?').get(rollId);
  if (!roll || roll.state !== 'pending' || roll.mystery_session_id != null
    || roll.character_id !== characterSnapshot.id || !roll.rules_json) throw new Error('Invalid roll delivery reservation');
  validateWindows(JSON.parse(roll.rules_json));
  const logicalId = `roll:${roll.guild_id}:${roll.channel_id}:${roll.command_message_id}`;
  db.prepare(`INSERT INTO roll_delivery (roll_id,version,roller_id,remaining,logical_delivery_id,
    character_snapshot_json,presentation_json,phase) VALUES (?,1,?,?,?,?,?,'reserved')`)
    .run(rollId, userId, remaining, logicalId, JSON.stringify(characterSnapshot), JSON.stringify({ image }));
  return true;
}

function validateWindows(windows) {
  if (!windows || !['claimMs', 'escapeProtectionMs', 'escapeClaimMs', 'reportMs']
    .every((key) => Number.isSafeInteger(windows[key]) && windows[key] > 0)) {
    throw new Error('Invalid captured roll windows');
  }
}

/** Strict validation is intentional: corrupt final state stays pending for inspection. */
export function loadRollDelivery(db, rollId) {
  if (!hasRollDelivery(db)) return null;
  const delivery = db.prepare('SELECT * FROM roll_delivery WHERE roll_id=?').get(rollId);
  if (!delivery) return null;
  const roll = db.prepare('SELECT * FROM character_rolls WHERE id=?').get(rollId);
  if (!roll || delivery.version !== 1 || roll.mystery_session_id != null
    || delivery.logical_delivery_id !== `roll:${roll.guild_id}:${roll.channel_id}:${roll.command_message_id}`
    || !/^\d+$/.test(delivery.roller_id) || !Number.isSafeInteger(delivery.remaining) || delivery.remaining < 0) {
    throw new Error('Invalid roll delivery identity');
  }
  const character = validateCharacterSnapshot(JSON.parse(delivery.character_snapshot_json), roll.character_id);
  const stored = loadRollCharacterSnapshot(db, rollId);
  if (character.name_full !== roll.character_name || (stored && JSON.stringify(stored) !== JSON.stringify(character))) {
    throw new Error('Invalid roll delivery character');
  }
  const windows = JSON.parse(roll.rules_json);
  validateWindows(windows);
  const misfire = windows.cupidsMisfire;
  if (misfire && (misfire.version !== 1 || !['divorced', 'blocked', 'negated'].includes(misfire.result)
    || misfire.characterId !== roll.character_id || !/^\d+$/.test(misfire.formerOwnerId)
    || !Number.isSafeInteger(misfire.marriageId) || misfire.marriageId <= 0
    || (misfire.result === 'divorced' ? roll.escape_marriage_id !== null
      : roll.escape_marriage_id !== misfire.marriageId || roll.escape_owner_id !== misfire.formerOwnerId))) {
    throw new Error('Invalid Cupid\'s Misfire outcome');
  }
  const presentation = JSON.parse(delivery.presentation_json);
  if (!presentation || (presentation.image !== null && (typeof presentation.image?.url !== 'string'
    || !/^https?:\/\//.test(presentation.image.url)))) throw new Error('Invalid roll delivery presentation');
  const acknowledged = ['acknowledged', 'bound'].includes(delivery.phase);
  if ((!acknowledged && delivery.phase !== 'reserved')
    || (acknowledged ? !/^\d+$/.test(delivery.message_id) || !Number.isSafeInteger(delivery.acknowledged_at)
      : delivery.message_id !== null || delivery.acknowledged_at !== null)
    || (roll.message_id != null && roll.message_id !== delivery.message_id)
    || (delivery.phase === 'bound' && roll.state === 'pending')) throw new Error('Invalid roll delivery binding');
  return { ...delivery, roll, character, windows, presentation };
}

/** Persist Discord's acknowledgement BEFORE publishRoll. Never overwrite a canonical binding. */
export function acknowledgeRollDelivery(db, rollId, messageId, now = Date.now()) {
  if (!/^\d+$/.test(messageId) || !Number.isSafeInteger(now) || now < 0) throw new Error('Invalid delivery acknowledgement');
  return transaction(db, () => {
    const delivery = loadRollDelivery(db, rollId);
    if (!delivery) throw new Error('Missing roll delivery');
    if (delivery.message_id) {
      if (delivery.message_id !== messageId) throw new Error('Conflicting roll delivery acknowledgement');
      return false;
    }
    db.prepare("UPDATE roll_delivery SET phase='acknowledged',message_id=?,acknowledged_at=? WHERE roll_id=? AND phase='reserved'")
      .run(messageId, now, rollId);
    return true;
  });
}

const busy = new Map();
const connectionIds = new WeakMap();
let nextConnection = 0;
function lockKey(db, rollId) {
  const file = db.prepare('PRAGMA database_list').all().find((row) => row.name === 'main')?.file;
  if (!connectionIds.has(db)) connectionIds.set(db, ++nextConnection);
  return `${file || `memory:${connectionIds.get(db)}`}:${rollId}`;
}

/** No selection, allowance mutation or buff charge occurs here.
 * Discord nonce deduplication is best effort and time-limited, NOT exactly-once delivery.
 * A crash after send but before acknowledgement can resend outside Discord's nonce window.
 */
/** @param {{rollId: number, channel?: any, now?: () => number}} options */
export async function deliverReservedRoll(db, client, options) {
  const { rollId, channel = null, now = Date.now } = options;
  const key = lockKey(db, rollId);
  if (busy.has(key)) return busy.get(key);
  const work = Promise.resolve().then(async () => {
    let delivery = loadRollDelivery(db, rollId);
    if (!delivery) return { status: 'legacy' };
    if (delivery.phase === 'bound' || delivery.roll.state !== 'pending') {
      if (delivery.roll.state === 'open' && !delivery.windows.ownAppearance) {
        try {
          const target = channel ?? await client.channels.fetch(delivery.roll.channel_id);
          const message = await target.messages.fetch(delivery.message_id);
          if (!message.reactions?.cache?.get('❤️')?.me) await message.react('❤️');
        } catch { /* Keep canonical claim live; subsequent sweeps retry UI. */ }
      }
      if (delivery.phase === 'acknowledged' && delivery.roll.message_id === delivery.message_id) {
        db.prepare("UPDATE roll_delivery SET phase='bound' WHERE roll_id=?").run(rollId);
      }
      return { status: 'bound', messageId: delivery.message_id };
    }
    if (!delivery.message_id) {
      const target = channel ?? await client.channels.fetch(delivery.roll.channel_id);
      if (!target || target.id !== delivery.roll.channel_id
        || (target.guildId != null && target.guildId !== delivery.roll.guild_id)) throw new Error('Invalid delivery channel');
      const time = now();
      const escape = delivery.roll.escape_marriage_id ? { phase: /** @type {const} */ ('protected'), ownerId: delivery.roll.escape_owner_id,
        protectedUntil: time + delivery.windows.escapeProtectionMs, ping: true } : null;
      const wishUserIds = findWishMatchers(db, { guildId: delivery.roll.guild_id,
        characterId: delivery.character.id });
      const misfire = delivery.windows.cupidsMisfire;
      // Discord send and our acknowledgement cannot be atomic. Record the owner
      // notification attempt before I/O: ambiguous retries may resend a card,
      // but must never notify its former owner twice, even beyond nonce expiry.
      const pingOwner = Boolean(misfire && !misfire.ownerNotificationAttempted);
      if (pingOwner) {
        delivery.windows.cupidsMisfire = { ...misfire, ownerNotificationAttempted: true };
        db.prepare('UPDATE character_rolls SET rules_json=? WHERE id=?')
          .run(JSON.stringify(delivery.windows), rollId);
      }
      const payload = rollCard(delivery.character, delivery.presentation.image, delivery.remaining, escape,
        { userIds: wishUserIds, ping: true }, misfire ? { ...misfire, ping: pingOwner } : null);
      if (delivery.windows.ownAppearance) {
        const container = payload.components.find(component => component instanceof ContainerBuilder);
        container?.addTextDisplayComponents(text => text.setContent('♡ An appearance from your harem · No claim needed.'));
      }
      if (misfire && !pingOwner) {
        payload.allowedMentions.users = payload.allowedMentions.users.filter(id => id !== misfire.formerOwnerId);
      }
      const message = await target.send({ ...payload,
        reply: { messageReference: delivery.roll.command_message_id, failIfNotExists: false },
        nonce: createHash('sha256').update(delivery.logical_delivery_id).digest('hex').slice(0, 24), enforceNonce: true });
      acknowledgeRollDelivery(db, rollId, message.id, now());
      delivery = loadRollDelivery(db, rollId);
    }
    // Separate committed acknowledgement survives a crash or publication failure.
    const published = publishRoll(db, rollId, delivery.message_id, delivery.acknowledged_at);
    db.prepare("UPDATE roll_delivery SET phase='bound' WHERE roll_id=? AND phase='acknowledged'").run(rollId);
    if (published && hasAffection(db)) transaction(db, () => flushAffectionRewardsInTransaction(db, {
      guildId: delivery.roll.guild_id, userId: delivery.roller_id, now: delivery.acknowledged_at }));
    // The claim handler does not require the bot's reaction, but make the
    // recoverable card discoverable after a crash before the live path reacts.
    try {
      const target = channel ?? await client.channels.fetch(delivery.roll.channel_id);
      const message = await target.messages.fetch(delivery.message_id);
      if (!delivery.windows.ownAppearance) await message.react('❤️');
    } catch { /* Reaction failure cannot invalidate a committed paid claim. */ }
    return { status: published ? 'published' : 'closed', rollId, messageId: delivery.message_id };
  });
  busy.set(key, work);
  try { return await work; } finally { busy.delete(key); }
}

/** Transient transport failures and corrupt records remain pending; callers may report errors. */
export async function recoverPendingRollDeliveries(db, client, options = {}) {
  if (!hasRollDelivery(db)) return [];
  const results = [];
  for (const { id } of db.prepare(`SELECT r.id FROM character_rolls r
    LEFT JOIN roll_delivery d ON d.roll_id=r.id
    WHERE (r.state='pending' OR (r.state='open' AND r.expires_at>?))
    AND r.mystery_session_id IS NULL AND r.command_message_id NOT LIKE 'siren:%'`).all((options.now ?? Date.now)())) {
    try {
      const result = await deliverReservedRoll(db, client, { ...options, rollId: id });
      if (result.status !== 'bound') results.push(result);
    }
    catch (error) { results.push({ status: 'pending', rollId: id, error }); }
  }
  return results;
}
