import { loadRollCharacterSnapshot } from './characterRolls.js';

/**
 * Preflight, NOT a replay engine. Call on a normally opened final catalog before
 * cancelMysteryRuntime/recoverRollRuntime and before enabling game handlers.
 * Throws rather than guessing refunds, item costs, deadlines or Discord delivery.
 * This deliberately performs no writes, sends, timers, or default-path opens and
 * can also run on openCatalogReadOnly(path).
 *
 * Existing startup cancels mysteries and escapes, fails ordinary reservations,
 * and retries Siren deliveries (whose reservation currently omits rules_json).
 * None of those actions is permission to discard a consumed cost. An operator or
 * a future durable recovery implementation must resolve each blocker explicitly.
 * Normal published ordinary rolls need no timer to claim: reactions read SQLite.
 * Trades/gifts cannot be detected here: their sessions/reservations are memory-only.
 */
export function inspectCatalogRuntimeRestart(db) {
  if (db.prepare('PRAGMA user_version').get().user_version !== 12) {
    throw new Error('Runtime restart preflight requires a normally opened final v12 catalog');
  }
  const blockers = [];
  const add = (code, table, id, detail) => blockers.push({ code, table, id, detail });
  for (const roll of db.prepare(`SELECT id,state,command_message_id,mystery_session_id,
    escape_marriage_id,rules_json FROM character_rolls WHERE state IN ('pending','open') ORDER BY id`).all()) {
    try {
      if (!loadRollCharacterSnapshot(db, roll.id)) {
        add('missing_terms', 'character_rolls', roll.id, 'No durable character terms; do not reconstruct from the live catalog.');
      }
    } catch {
      add('invalid_terms', 'character_rolls', roll.id, 'Stored character terms are invalid or disagree with the mystery.');
    }
    if (roll.mystery_session_id != null) continue; // session reported below
    if (roll.state === 'pending') {
      const forced = roll.command_message_id.startsWith('siren:');
      add(forced ? 'forced_delivery_pending' : 'ordinary_delivery_pending', 'character_rolls', roll.id,
        forced ? 'Spent item and effective target must be retained; Discord send acknowledgement may be ambiguous.'
          : 'Roll allowance/buffs may already be spent; startup currently fails this reservation without compensation.');
      if (forced) {
        let windows;
        try { windows = JSON.parse(roll.rules_json); } catch { /* reported below */ }
        if (!windows || !['claimMs', 'escapeProtectionMs', 'escapeClaimMs'].every(
          key => Number.isSafeInteger(windows[key]) && windows[key] > 0)) {
          add('forced_rules_unavailable', 'character_rolls', roll.id,
            'No valid captured windows; retry would use current rules or invalid deadlines. Do not guess.');
        }
      }
    } else if (roll.escape_marriage_id != null) {
      add('escape_runtime_missing', 'character_rolls', roll.id,
        'Escape timer/card updates are not restored; existing startup cancels the attempt, preserving ownership but not its spent cost.');
    }
  }
  for (const session of db.prepare(`SELECT id,state FROM mystery_sessions
    WHERE state IN ('reserved','running','countdown','claim_open') ORDER BY id`).all()) {
    add('mystery_runtime_missing', 'mystery_sessions', session.id,
      `Persisted ${session.state} session has no restored runtime/timer; existing startup cancels it without refunding consumed costs.`);
  }
  for (const action of db.prepare(`SELECT id,state,delivery_pending FROM item_actions
    WHERE state IN ('confirming','awaiting_delivery','active') OR delivery_pending=1 ORDER BY id`).all()) {
    add('item_reconciliation_required', 'item_actions', action.id,
      `State ${action.state}, delivery_pending=${action.delivery_pending}; reconcile through the item runtime before enabling handlers, not by replaying activation.`);
  }
  for (const reward of db.prepare(`SELECT vault_id,state FROM vault_rewards
    WHERE state IN ('decision','overflow') OR delivered_at IS NULL ORDER BY vault_id`).all()) {
    add('vault_reconciliation_required', 'vault_rewards', reward.vault_id,
      `State ${reward.state}; reconcile via the vault runtime, never reroll the reward or discard pending delivery.`);
  }
  return {
    ready: blockers.length === 0,
    blockers,
    limitations: [
      'Trade/gift conversations and collectors are memory-only; restart abandons them without changing ownership. No durable record exists to notify participants.',
      'Discord send followed by a crash before message-id commit is not exactly-once delivery; this preflight does not infer whether a message exists.',
      'This is a startup guard, not recovery. The bot invokes it before enabling recovery writes, timers, handlers or Discord login.',
    ],
  };
}

export function assertCatalogRuntimeRestartReady(db) {
  const report = inspectCatalogRuntimeRestart(db);
  if (!report.ready) {
    const error = new Error(`Catalog runtime restart blocked: ${report.blockers.map(
      issue => `${issue.code}:${issue.table}:${issue.id}`).join(', ')}`);
    error.code = 'CATALOG_RUNTIME_RECOVERY_REQUIRED';
    error.report = report;
    throw error;
  }
  return report;
}
