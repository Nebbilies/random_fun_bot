import { isDeepStrictEqual } from 'node:util';
import { getItemDefinition } from './itemRoster.js';
import { addItemToInventory } from './itemStorage.js';
import { validateLegacyConversionSchema, validateRetainedVaultOverflow } from './characterIdentityMigration.js';
import { validateCharacterSnapshot } from './characterSnapshot.js';

const ACTION_KINDS = new Set(['blood_pact', 'alchemist', 'chaos_exchange', 'counterfeit_crown', 'heart_for_a_heart',
  'hostage_note', 'severed_fate', 'grand_masquerade', 'kaimetsu']);
const TERMINAL_ACTIONS = new Set(['resolved', 'canceled', 'expired']);
const TERMINAL_ROLLS = new Set(['closed', 'failed', 'prank', 'vault']);
const TERMINAL_MYSTERIES = new Set(['completed', 'canceled', 'failed']);
const TERMINAL_VAULTS = new Set(['delivered', 'lost', 'declined']);
const INVENTORY_FIELDS = ['id', 'guild_id', 'user_id', 'item_id', 'charges', 'acquired_at'];
const all = (db, table) => db.prepare(`SELECT * FROM ${table}`).all();
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const sameInventory = (a, b) => b && INVENTORY_FIELDS.every(key => a[key] === b[key]);
const discordId = value => typeof value === 'string' && /^\d+$/.test(value);

// v10 publishRoll binds an ordinary card with NULL escape/protection fields.
// No zero/empty-string sentinel is a documented default. Never interpret one as
// absence, or use current configuration to reconstruct missing published terms.
function ordinaryExpiredRoll(db, roll, now) {
  if (roll.state !== 'open' || !positive(roll.id)
    || !['mystery_session_id', 'exclusive_user_id', 'escape_marriage_id', 'escape_owner_id',
      'protected_until', 'escape_outcome', 'escape_winner_id', 'escape_resolved_at']
      .every(key => roll[key] === null)
    || ![roll.guild_id, roll.channel_id, roll.command_message_id, roll.message_id].every(discordId)
    || !positive(roll.published_at) || !positive(roll.expires_at)
    || roll.expires_at <= roll.published_at || roll.expires_at > now
    || !positive(roll.character_id) || typeof roll.character_name !== 'string' || !roll.character_name.trim()) return false;
  // Retained identities can outlive the live catalog and its mutable name.
  if (!db.prepare('SELECT 1 FROM character_identities WHERE id=?').get(roll.character_id)
    && !db.prepare('SELECT 1 FROM characters WHERE id=?').get(roll.character_id)) return false;
  // Refuse even a terminal mystery's inconsistent reverse binding.
  if (db.prepare('SELECT 1 FROM mystery_sessions WHERE origin_roll_id=?').get(roll.id)) return false;
  try {
    // Legacy v10 allows absent rules. If captured, they must agree with the
    // ordinary producer's deadline; expiry alone cannot repair corrupt terms.
    if (roll.rules_json !== null) {
      const windows = JSON.parse(roll.rules_json);
      if (!object(windows) || Object.keys(windows).some(key => !['claimMs', 'escapeProtectionMs', 'escapeClaimMs', 'reportMs'].includes(key))
        || !['claimMs', 'escapeProtectionMs', 'escapeClaimMs', 'reportMs']
        .every(key => positive(windows[key]))
        || roll.expires_at - roll.published_at !== windows.claimMs) return false;
    }
    // This column is absent in standard v10. Validate any optional stored terms
    // using the producer contract, without requiring a later schema upgrade.
    if (Object.hasOwn(roll, 'character_snapshot_json') && roll.character_snapshot_json !== null) {
      const snapshot = validateCharacterSnapshot(JSON.parse(roll.character_snapshot_json), roll.character_id);
      if (snapshot.name_full !== roll.character_name) return false;
    }
  } catch { return false; }
  return true;
}

export class CharacterMigrationSettlementError extends Error {
  constructor(blockers) {
    super(`Unsafe maintenance settlement:\n${blockers.join('\n')}`);
    this.name = 'CharacterMigrationSettlementError';
    this.blockers = blockers;
  }
}

/**
 * Explicit OFFLINE v10 maintenance operation on a caller-supplied working copy.
 * Never opens a database, runs at startup, sends Discord messages, calls recovery,
 * or touches memory-only transfers (all application processes must be stopped).
 * Owns BEGIN IMMEDIATE/COMMIT; do not call inside another transaction.
 *
 * Current v10 has no exact consumed-cost ledger for rolls/mysteries/Siren or
 * delivered Hostages. Refund/cancellation remains unsupported for those costs.
 * Proven ordinary published expiry only closes the claim window, with no refund.
 * All other nonterminal rolls remain hard blockers. An inventory ID,
 * remaining charge, command token, or escrow-shaped row is NOT proof of payment.
 * Undelivered Hostage escrow is still in inventory: release it, never insert it.
 * No completed gameplay costs are refunded. All validation/writes roll back on
 * any failure, including full inventory while preserving a determined vault item.
 *
 * The acknowledgements are operator assertions, not automatic exclusivity/backup
 * verification. Use only a verified disposable offline working copy, never the
 * production database or sole backup. This service does not perform UUID migration.
 */
export function settleCharacterMigration(db, {
  offline = false, backupVerified = false, retainOverflow = false, now = Date.now(),
} = {}) {
  if (offline !== true || backupVerified !== true) {
    throw new Error('Explicit offline and backupVerified acknowledgements are required.');
  }
  if (typeof retainOverflow !== 'boolean') throw new Error('Invalid retainOverflow option.');
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid maintenance time.');
  db.exec('BEGIN IMMEDIATE');
  try {
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version !== 10) throw new CharacterMigrationSettlementError([`Unsupported user_version ${version}; expected current legacy schema 10.`]);
    validateLegacyConversionSchema(db);
    const blockers = [];
    const refuse = message => blockers.push(message);
    const parse = (text, label) => {
      try { return JSON.parse(text); }
      catch { refuse(`${label}: invalid JSON.`); return null; }
    };
    const actions = all(db, 'item_actions');
    const costs = all(db, 'item_action_costs');
    const reservations = all(db, 'item_character_reservations');
    const safe = [];
    for (const action of actions) {
      const label = `item_actions ${action.id}`;
      const escrow = costs.filter(row => row.action_id === action.id);
      const held = reservations.filter(row => row.action_id === action.id);
      if (!ACTION_KINDS.has(action.kind)) { refuse(`${label}: unsupported kind ${action.kind}.`); continue; }
      if (TERMINAL_ACTIONS.has(action.state)) {
        if (escrow.length || held.length) refuse(`${label}: terminal action retains escrow/reservations.`);
        continue;
      }
      if (action.state === 'active' && action.kind === 'hostage_note') {
        refuse(`${label}: delivered Hostage has no durable consumed Note snapshot; exact refund unsupported.`);
        continue;
      }
      if (action.state !== 'confirming' && !(action.state === 'awaiting_delivery' && action.kind === 'hostage_note')) {
        refuse(`${label}: unsupported state ${action.state}.`); continue;
      }
      if (action.result_json !== null || action.delivery_pending !== 0) refuse(`${label}: unexpected result/delivery state.`);
      const selections = parse(action.selections_json, `${label}.selections_json`);
      if (!object(selections)) refuse(`${label}: selections must be an object.`);
      if (action.state === 'confirming') {
        if (escrow.length || held.length || action.crown_json !== null) refuse(`${label}: confirming action already has activation side effects.`);
        safe.push({ action, crowns: [], escrow: [] });
        continue;
      }
      // Mirror undelivered cancellation's ownership/crown rules, but validate
      // before releasing anything; transaction-owning domain APIs cannot nest.
      const own = selections?.own;
      const targets = selections?.targets;
      const choices = [own, ...(Array.isArray(targets) ? targets : [])];
      if (!own || !Array.isArray(targets) || targets.length !== 1 || held.length !== 2
        || new Set(choices.map(row => row?.characterId)).size !== 2
        || own.ownerId !== action.actor_id || targets[0]?.ownerId === action.actor_id) {
        refuse(`${label}: malformed Hostage stakes/reservations.`);
      }
      for (const choice of choices) {
        if (!object(choice) || !positive(choice.characterId) || !positive(choice.marriageId) || typeof choice.ownerId !== 'string') {
          refuse(`${label}: invalid Hostage stake.`); continue;
        }
        const marriage = db.prepare('SELECT * FROM marriages WHERE guild_id=? AND character_id=?').get(action.guild_id, choice.characterId);
        const matching = held.filter(row => row.guild_id === action.guild_id && row.character_id === choice.characterId
          && row.owner_id === choice.ownerId && row.marriage_id === choice.marriageId);
        if (matching.length !== 1 || marriage?.id !== choice.marriageId || marriage?.owner_id !== choice.ownerId) {
          refuse(`${label}: stake ownership/reservation changed.`);
        }
      }
      if (escrow.length !== 1) refuse(`${label}: expected exactly one undelivered Note escrow.`);
      for (const cost of escrow) {
        const snapshot = parse(cost.snapshot_json, `${label}.snapshot_json`);
        const current = db.prepare('SELECT * FROM user_inventory WHERE id=?').get(cost.inventory_id);
        if (!object(snapshot) || !positive(snapshot.id) || !positive(snapshot.charges)
          || snapshot.id !== action.inventory_id || cost.inventory_id !== action.inventory_id
          || snapshot.guild_id !== action.guild_id || snapshot.user_id !== action.actor_id
          || snapshot.item_id !== 'hostage_note' || typeof snapshot.acquired_at !== 'string'
          || !sameInventory(snapshot, current)) refuse(`${label}: undelivered inventory no longer matches exact escrow snapshot.`);
      }
      const crowns = parse(action.crown_json ?? '[]', `${label}.crown_json`);
      if (!Array.isArray(crowns) || crowns.length > 1) refuse(`${label}: unsupported crown snapshot.`);
      else for (const crown of crowns) {
        if (!object(crown) || crown.guild_id !== action.guild_id || !positive(crown.character_id)
          || !positive(crown.marriage_id) || typeof crown.user_id !== 'string' || typeof crown.generation_id !== 'string'
          || crown.character_id !== targets?.[0]?.characterId || crown.user_id !== targets?.[0]?.ownerId
          || crown.marriage_id !== targets?.[0]?.marriageId) {
          refuse(`${label}: invalid redirected crown snapshot.`); continue;
        }
        const current = db.prepare('SELECT * FROM counterfeit_crowns WHERE guild_id=? AND user_id=?').get(crown.guild_id, crown.user_id);
        if (current && !isDeepStrictEqual({ ...current }, crown)) refuse(`${label}: conflicting replacement Crown; refusing to overwrite.`);
      }
      safe.push({ action, crowns: Array.isArray(crowns) ? crowns : [], escrow });
    }
    const ids = new Set(actions.map(row => row.id));
    for (const row of [...costs, ...reservations]) if (!ids.has(row.action_id)) refuse(`Orphan escrow/reservation for ${row.action_id}.`);
    const expiredRolls = [];
    for (const roll of all(db, 'character_rolls')) {
      if (TERMINAL_ROLLS.has(roll.state)) continue;
      if (ordinaryExpiredRoll(db, roll, now)) expiredRolls.push(roll.id);
      else refuse(`character_rolls ${roll.id} (${roll.state}): not a verified ordinary published expiry; missing exact allowance/buff/Siren cost provenance; drain or reconcile before maintenance.`);
    }
    for (const session of all(db, 'mystery_sessions')) {
      if (!TERMINAL_MYSTERIES.has(session.state)) refuse(`mystery_sessions ${session.id} (${session.state}): origin roll refund provenance unavailable.`);
    }
    const vaults = [], retainedOverflow = [];
    for (const vault of all(db, 'vault_rewards')) {
      if (TERMINAL_VAULTS.has(vault.state)) continue;
      if (retainOverflow && vault.state === 'overflow') {
        try { validateRetainedVaultOverflow(vault); retainedOverflow.push(vault.vault_id); }
        catch (error) { refuse(error.message); }
        continue;
      }
      if (!['decision', 'revealed', 'overflow'].includes(vault.state)) { refuse(`vault_rewards ${vault.vault_id}: unsupported state ${vault.state}.`); continue; }
      const original = parse(vault.original_json, `vault_rewards ${vault.vault_id}.original_json`);
      const outcome = vault.state === 'overflow' ? parse(vault.reward_json, `vault_rewards ${vault.vault_id}.reward_json`) : original;
      if (!object(outcome) || !object(outcome.item) || !getItemDefinition(outcome.item.id)
        || !positive(outcome.item.maxCharges ?? 1)
        || (vault.state !== 'overflow' && (vault.gamble_inventory_id !== null || vault.reward_json !== null))
        || (vault.state === 'overflow' && !['kept', 'won'].includes(vault.result))) {
        refuse(`vault_rewards ${vault.vault_id}: unsupported determined reward/provenance.`);
      }
      vaults.push({ vault, outcome });
    }
    if (blockers.length) throw new CharacterMigrationSettlementError(blockers);
    const report = { canceledActions: [], releasedEscrow: [], restoredCrowns: [], deliveredVaults: [], closedExpiredRolls: [], retainedOverflow,
      refundedConsumedCosts: 0, memoryTransfers: 'Expired by offline process shutdown; no durable transfer rows.', now };
    for (const { action, crowns, escrow } of safe) {
      for (const crown of crowns) {
        const lock = db.prepare('SELECT protected_until FROM character_protection_locks WHERE guild_id=? AND character_id=?').get(crown.guild_id, crown.character_id);
        if (lock && (lock.protected_until === null || lock.protected_until > now)) continue;
        db.prepare('INSERT OR IGNORE INTO counterfeit_crowns(guild_id,user_id,character_id,marriage_id,generation_id) VALUES(?,?,?,?,?)')
          .run(crown.guild_id, crown.user_id, crown.character_id, crown.marriage_id, crown.generation_id);
        report.restoredCrowns.push(crown.generation_id);
      }
      db.prepare('DELETE FROM item_character_reservations WHERE action_id=?').run(action.id);
      db.prepare('DELETE FROM item_action_costs WHERE action_id=?').run(action.id);
      const result = { status: 'canceled', canceledBy: 'uuid_maintenance', canceledAt: now,
        message: 'Offline maintenance canceled this action. No exchange, divorce or gamble. Unspent escrow released.',
        // Preserve exact escrow evidence in the terminal cancellation record.
        releasedEscrow: escrow.map(row => ({ inventoryId: row.inventory_id, snapshotJson: row.snapshot_json })) };
      db.prepare("UPDATE item_actions SET state='canceled',result_json=?,delivery_pending=0 WHERE id=?")
        .run(JSON.stringify(result), action.id);
      report.canceledActions.push(action.id);
      report.releasedEscrow.push(...escrow.map(row => row.inventory_id));
    }
    for (const id of expiredRolls) {
      // Natural expiry, NOT cancellation: retain all bindings, snapshots, notices
      // and spent gameplay costs. This write rolls back with every other write.
      db.prepare("UPDATE character_rolls SET state='closed' WHERE id=?").run(id);
      report.closedExpiredRolls.push(id);
    }
    for (const { vault, outcome } of vaults) {
      // Keep an unchosen reward, or deliver an already determined overflow reward.
      // Never consume Double or Nothing, draw randomness, replace, or decline items.
      const added = addItemToInventory(db, vault.guild_id, vault.user_id, outcome.item.id, outcome.item.maxCharges ?? 1);
      if (added.status !== 'added') throw new CharacterMigrationSettlementError([`vault_rewards ${vault.vault_id}: inventory full; drain reward before maintenance.`]);
      db.prepare(`UPDATE vault_rewards SET state='delivered',reward_json=?,result=?,resolved_at=?,delivered_at=NULL WHERE vault_id=?`)
        .run(JSON.stringify(outcome), vault.state === 'overflow' ? vault.result : 'kept', now, vault.vault_id);
      report.deliveredVaults.push(vault.vault_id);
    }
    db.exec('COMMIT');
    return report;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
