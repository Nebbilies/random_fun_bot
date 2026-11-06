import { hasAffection } from './characterAffection.js';
import { isLegacyAffectionSource } from './affectionSchema.js';
import { validateSavedAffectionContext } from './affectionSnapshot.js';

/** Validate the immutable paid-request/character envelope on both live and recovery paths.
 * Mystery's delivery channel differs from the original request channel; its original
 * channel remains bound by the permanent request receipt and context.
 */
export function loadValidatedRollAffection(db, rollId) {
  if (!hasAffection(db)) return null;
  const roll = db.prepare('SELECT * FROM character_rolls WHERE id=?').get(rollId);
  if (!roll) throw new Error('Missing roll for affection capture');
  let terms;
  try { terms = roll.rules_json ? JSON.parse(roll.rules_json) : {}; }
  catch { throw new Error('Invalid affection roll terms'); }
  if (roll.command_message_id.startsWith('siren:')) return null;
  if (terms.affectionVersion == null && isLegacyAffectionSource(db,'roll',roll.command_message_id)) return null;
  const sourceKey=`roll:${roll.guild_id}:${roll.command_message_id}`;
  const request=db.prepare('SELECT * FROM affection_requests WHERE source_key=?').get(sourceKey);
  if (!request || request.guild_id!==roll.guild_id || !request.user_id || !request.channel_id) throw new Error('Missing or invalid affection request envelope');
  let outcome;
  try { outcome=JSON.parse(request.outcome_json); } catch { throw new Error('Invalid affection request outcome'); }
  if (Object.hasOwn(terms,'soulmateReclaimVersion') || Object.hasOwn(outcome,'soulmateReclaimVersion')) {
    if (terms.soulmateReclaimVersion!==1 || outcome.soulmateReclaimVersion!==1
      || outcome.status!=='reserved' || outcome.rollId!==roll.id || roll.mystery_session_id!=null
      || (roll.escape_marriage_id!=null && outcome.escapeOwnerId!==roll.escape_owner_id)) {
      throw new Error('Invalid soulmate reclaim capture binding');
    }
  }
  if (outcome.rollId!=null && outcome.rollId!==roll.id) throw new Error('Affection request roll mismatch');
  if (['prank','vault'].includes(roll.state)) return null;
  const context=db.prepare('SELECT * FROM affection_contexts WHERE source_key=?').get(sourceKey);
  if (terms.affectionVersion!==1 || terms.affectionSourceKey!==sourceKey || !context
    || context.guild_id!==request.guild_id || context.user_id!==request.user_id || context.channel_id!==request.channel_id
    || context.character_id!==roll.character_id || outcome.character?.id!==roll.character_id) throw new Error('Invalid affection capture binding');
  if (roll.mystery_session_id!=null) {
    const mystery=db.prepare('SELECT * FROM mystery_sessions WHERE id=?').get(roll.mystery_session_id);
    if (!mystery || mystery.origin_roll_id!==roll.id || mystery.guild_id!==roll.guild_id
      || mystery.roller_id!==request.user_id || mystery.character_id!==roll.character_id
      || mystery.event_channel_id!==roll.channel_id || outcome.sessionId!==mystery.id) throw new Error('Invalid mystery affection binding');
  } else {
    const delivery=db.prepare('SELECT * FROM roll_delivery WHERE roll_id=?').get(roll.id);
    if (request.channel_id!==roll.channel_id || !delivery || delivery.roller_id!==request.user_id) throw new Error('Invalid ordinary affection binding');
    if (terms.soulmateReclaimVersion===1) {
      const acknowledged=['acknowledged','bound'].includes(delivery.phase);
      // A published card with a reserved delivery remains recoverable: the existing
      // coordinator can finish its acknowledgement. A conflicting saved ID is not.
      if (delivery.version!==1 || delivery.logical_delivery_id!==`roll:${roll.guild_id}:${roll.channel_id}:${roll.command_message_id}`
        || (!acknowledged && delivery.phase!=='reserved')
        || (acknowledged ? !/^\d+$/.test(delivery.message_id ?? '') || !Number.isSafeInteger(delivery.acknowledged_at)
          : delivery.message_id!==null || delivery.acknowledged_at!==null)
        || (roll.message_id!=null && delivery.message_id!=null && roll.message_id!==delivery.message_id)) {
        throw new Error('Invalid soulmate reclaim delivery binding');
      }
    }
  }
  const snapshot=validateSavedAffectionContext(context);
  return {sourceKey,request,context,snapshot,terms,outcome};
}
