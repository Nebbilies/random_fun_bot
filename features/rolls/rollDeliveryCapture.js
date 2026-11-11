import { validateCharacterSnapshot } from '../../lib/characterSnapshot.js';

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
  validateCapturedRollWindows(JSON.parse(roll.rules_json));
  const logicalId = `roll:${roll.guild_id}:${roll.channel_id}:${roll.command_message_id}`;
  db.prepare(`INSERT INTO roll_delivery (roll_id,version,roller_id,remaining,logical_delivery_id,
    character_snapshot_json,presentation_json,phase) VALUES (?,1,?,?,?,?,?,'reserved')`)
    .run(rollId, userId, remaining, logicalId, JSON.stringify(characterSnapshot), JSON.stringify({ image }));
  return true;
}

export function validateCapturedRollWindows(windows) {
  if (!windows || !['claimMs', 'escapeProtectionMs', 'escapeClaimMs', 'reportMs']
    .every((key) => Number.isSafeInteger(windows[key]) && windows[key] > 0)) {
    throw new Error('Invalid captured roll windows');
  }
}
