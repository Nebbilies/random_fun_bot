import { getItemRewardSource, getVaultReward } from './vaultRewards.js';
import { isConsolationRewardPublishable } from './mysteryConsolation.js';
import { inspectFortuneRuntime } from './vaultFortune.js';
import { inspectLegacyVaultAbandonment } from './legacyVaultAbandonment.js';
import { loadRollCharacterSnapshot } from './characterRolls.js';
import { loadRollDelivery } from './rollDelivery.js';
import { inspectMysteryRuntime } from './mysteryRuntime.js';

/** Read-only startup preflight. Recoverable work is NOT a blocker. The caller
 * must run the corresponding recovery coordinator before enabling game ingress.
 * Unknown or ambiguous paid states stay blocked rather than being cancelled.
 */
export function inspectCatalogRuntimeRestart(db) {
  if (db.prepare('PRAGMA user_version').get().user_version !== 12) {
    throw new Error('Runtime restart preflight requires a normally opened final v12 catalog');
  }
  const blockers = [], recoverable = [];
  const abandonment = inspectLegacyVaultAbandonment(db);
  for (const detail of abandonment.blockers) blockers.push({ code: 'invalid_vault_abandonment', table: 'catalog_meta', detail });
  const add = (code, table, id, detail) => blockers.push({ code, table, id, detail });
  for (const [table, key, states] of [
    ['character_rolls','id',['pending','open','closed','failed','claimed','prank','vault']],
    ['mystery_sessions','id',['reserved','running','countdown','claim_open','completed','canceled','failed']],
    ['item_actions','id',['confirming','awaiting_delivery','active','resolved','canceled','expired']],
    ['vault_rewards','vault_id',['decision','recast','overflow','delivered','lost','declined']],
    ['vault_sessions','vault_id',['unopened','revealed','expired']],
  ]) for (const row of db.prepare(`SELECT ${key} AS id,state FROM ${table}`).all()) {
    if (!states.includes(row.state)) add('unknown_runtime_state', table, row.id, `Unsupported state ${row.state}`);
  }
  const windowsValid = value => {
    try { const w = JSON.parse(value); return w && ['claimMs','escapeProtectionMs','escapeClaimMs','reportMs']
      .every(key => Number.isSafeInteger(w[key]) && w[key] > 0); } catch { return false; }
  };
  for (const roll of db.prepare(`SELECT * FROM character_rolls WHERE state IN ('pending','open') ORDER BY id`).all()) {
    try {
      if (!loadRollCharacterSnapshot(db, roll.id)) add('missing_terms', 'character_rolls', roll.id, 'Missing durable character terms.');
    } catch { add('invalid_terms', 'character_rolls', roll.id, 'Corrupt or inconsistent durable character terms.'); }
    if (roll.mystery_session_id != null) continue;
    if (roll.state === 'pending') {
      if (roll.command_message_id.startsWith('siren:')) {
        if (!windowsValid(roll.rules_json)) add('forced_rules_unavailable', 'character_rolls', roll.id, 'Missing captured Siren windows.');
        else if (!roll.escape_marriage_id || !roll.escape_owner_id) add('invalid_escape_binding', 'character_rolls', roll.id, 'Missing original marriage/owner.');
        else recoverable.push({ kind: 'forced_delivery', id: roll.id });
      } else {
        try {
          if (!loadRollDelivery(db, roll.id)) throw new Error('Missing durable allowance/presentation delivery record');
          recoverable.push({ kind: 'ordinary_delivery', id: roll.id });
        } catch (error) { add('ordinary_delivery_pending', 'character_rolls', roll.id, error.message); }
      }
    } else if (roll.escape_marriage_id == null) {
      let windows;
      try { windows = JSON.parse(roll.rules_json); } catch { /* reported below */ }
      if (!/^\d+$/.test(roll.message_id ?? '') || !windowsValid(roll.rules_json)
        || !Number.isSafeInteger(roll.published_at) || !Number.isSafeInteger(roll.expires_at)
        || roll.expires_at !== roll.published_at + windows?.claimMs) {
        add('invalid_claim_terms', 'character_rolls', roll.id, 'Invalid canonical ordinary claim binding/deadline.');
      }
    } else if (roll.escape_marriage_id != null) {
      let windows;
      try { windows = JSON.parse(roll.rules_json); } catch { /* reported below */ }
      if (!roll.message_id || !roll.escape_owner_id || !windowsValid(roll.rules_json)
        || ![roll.published_at, roll.protected_until, roll.expires_at].every(Number.isSafeInteger)
        || roll.published_at > roll.protected_until || roll.protected_until >= roll.expires_at
        || roll.protected_until !== roll.published_at + windows?.escapeProtectionMs
        || roll.expires_at !== roll.protected_until + windows?.escapeClaimMs) {
        add('invalid_escape_terms', 'character_rolls', roll.id, 'Missing original bound escape deadlines.');
      } else recoverable.push({ kind: 'open_escape', id: roll.id });
    }
  }
  const mysteries = inspectMysteryRuntime(db);
  for (const issue of mysteries.blockers) add('mystery_runtime_missing', 'mystery_sessions', issue.sessionId, issue.reason);
  for (const session of mysteries.recoverable) recoverable.push({ kind: 'mystery', id: session.id });
  // These runtimes already own their exact escrow/settlement operations. Do not
  // replay item activation or roll reward outcomes during preflight.
  for (const action of db.prepare(`SELECT * FROM item_actions WHERE state IN ('confirming','awaiting_delivery','active') OR delivery_pending=1`).all()) {
    try {
      JSON.parse(action.selections_json);
      if (action.result_json != null) JSON.parse(action.result_json);
      if (action.crown_json != null) JSON.parse(action.crown_json);
      if (action.state === 'active' && (!Number.isSafeInteger(action.deadline_at) || !action.message_id))
        throw new Error('Invalid active item deadline/message');
      if (action.state === 'confirming' && !Number.isSafeInteger(action.expires_at))
        throw new Error('Invalid item confirmation deadline');
      if (!['confirming','awaiting_delivery','active','resolved','canceled','expired'].includes(action.state)) throw new Error('Unknown item state');
      recoverable.push({ kind: 'item_action', id: action.id });
    } catch (error) { add('item_reconciliation_required', 'item_actions', action.id, error.message); }
  }
  for (const reward of db.prepare(`SELECT * FROM vault_rewards WHERE state IN ('decision','recast','overflow') OR delivered_at IS NULL`).all()) {
    try {
      const original = JSON.parse(reward.original_json);
      if (!original || typeof original !== 'object') throw new Error('Missing original reward');
      if (reward.state === 'decision' && (!Number.isSafeInteger(reward.deadline) || reward.deadline < reward.created_at))
        throw new Error('Invalid reward decision deadline');
      if (reward.reward_json != null) JSON.parse(reward.reward_json);
      if (!['decision','recast','overflow','delivered','lost','declined'].includes(reward.state)) throw new Error('Unknown vault reward state');
      recoverable.push({ kind: 'vault_reward', id: reward.vault_id });
    } catch (error) { add('vault_reconciliation_required', 'vault_rewards', reward.vault_id, error.message); }
  }
  // Inspect all provenance, including already delivered rewards; paid corruption
  // must not disappear merely because its presentation was acknowledged.
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='reward_sources' AND type='table'").get()) {
    for (const row of db.prepare('SELECT reward_id FROM reward_sources').all()) {
      try {
        getItemRewardSource(db, row.reward_id);
        const reward = getVaultReward(db, row.reward_id);
        if (!reward) throw new Error('Missing direct reward');
        isConsolationRewardPublishable(db, reward);
      } catch (error) { add('invalid_reward_source', 'reward_sources', row.reward_id, error.message); }
    }
  }
  // Every paid unopened vault must have its session captured in the allowance
  // transaction. Old sent/unsent vault rows cannot safely be distinguished.
  for (const roll of db.prepare(`SELECT id,command_message_id FROM character_rolls WHERE state='vault'`).all()) {
    if (!abandonment.ids.has(roll.id) && !db.prepare('SELECT 1 FROM vault_sessions WHERE command_message_id=?').get(roll.command_message_id)) {
      add('vault_session_missing', 'character_rolls', roll.id, 'Paid vault has no durable session/outcome binding.');
    }
  }
  for (const session of db.prepare("SELECT * FROM vault_sessions WHERE state='unopened' OR (state='expired' AND delivered_at IS NULL)").all()) {
    try {
      const captured = JSON.parse(session.captured_json);
      if (!captured?.rules || !Array.isArray(captured.roster) || !captured.weights || !captured.rewardPools
        || !Number.isSafeInteger(session.deadline) || session.deadline < session.created_at) throw new Error('Invalid captured vault terms');
      if (captured.fortuneVersion !== undefined && (captured.fortuneVersion !== 1
        || !['common','rare','epic','legendary','???'].every(tier => Array.isArray(captured.rewardPools[tier])
          && captured.rewardPools[tier].every(item => item.tier === tier && item.rewardEligible !== false))))
        throw new Error('Invalid Fortune capability/captured pools');
      recoverable.push({ kind: 'vault_session', id: session.vault_id });
    } catch (error) { add('invalid_vault_session', 'vault_sessions', session.vault_id, error.message); }
  }
  const fortune = inspectFortuneRuntime(db);
  blockers.push(...fortune.blockers);
  recoverable.push(...fortune.recoverable);
  return { ready: blockers.length === 0, blockers, recoverable, limitations: [
    'Trade/gift conversations remain memory-only; restart abandons them without changing ownership.',
    'Discord send-before-acknowledgement is not exactly-once delivery. Nonce deduplication is time-limited; costs and canonical claims remain durable.',
    'Recovery runs before game ingress. Transient Discord failures retain durable work for retries; ambiguous legacy or corrupt state requires explicit investigation.',
  ] };
}
export function assertCatalogRuntimeRestartReady(db) {
  const report = inspectCatalogRuntimeRestart(db);
  if (!report.ready) {
    const error = new Error(`Catalog runtime restart blocked: ${report.blockers.map(issue => `${issue.code}:${issue.table}:${issue.id}`).join(', ')}`);
    error.code = 'CATALOG_RUNTIME_RECOVERY_REQUIRED'; error.report = report;
    throw error;
  }
  return report;
}
