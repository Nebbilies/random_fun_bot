import { hasFortune } from './vaultFortune.js';
import { randomUUID } from 'node:crypto';
import { getGameConfig } from './gameConfig.js';
import { getResolvedItemDefinitions, rollVaultOutcome } from './itemRoster.js';

/** Parent-owned final schema migration only. Never execute this at runtime. */
export { VAULT_SESSIONS_DDL } from './catalogRuntimeSchema.js';

export function hasVaultSessions(db) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'vault_sessions'").get();
}

export function getVaultSession(db, vaultId) {
  const row = db.prepare('SELECT * FROM vault_sessions WHERE vault_id = ?').get(vaultId);
  return row ? { vaultId: row.vault_id, commandMessageId: row.command_message_id,
    paidRollId: row.paid_roll_id, guildId: row.guild_id, rollerId: row.user_id,
    channelId: row.channel_id, remaining: row.remaining, captured: JSON.parse(row.captured_json),
    deadline: row.deadline, createdAt: row.created_at, messageId: row.message_id,
    deliveredAt: row.delivered_at, state: row.state, rewardId: row.reward_id } : null;
}

export function getVaultSessionByCommand(db, commandMessageId) {
  const row = db.prepare('SELECT vault_id FROM vault_sessions WHERE command_message_id = ?').get(commandMessageId);
  return row ? getVaultSession(db, row.vault_id) : null;
}

/** Synchronous: call INSIDE the allowance/paid roll transaction. Does not open a transaction.
 * capturedOutcome is an explicit serializable scripted/test outcome, never a callback.
 * paidRollId links the reservation to the parent's paid roll (commandMessageId is also unique).
 */
/** @param {any} db @param {{guildId: string, rollerId?: string, userId?: string, channelId: string, commandMessageId?: string | null, paidRollId?: string | null, remaining?: number, now?: number, timeoutMs?: number, gameConfig?: any, capturedOutcome?: any, vaultId?: string}} options */
export function reservePaidVaultSession(db, { guildId, rollerId, userId = rollerId, channelId,
  commandMessageId = null, paidRollId = commandMessageId, remaining = 0,
  now = Date.now(), timeoutMs, gameConfig, capturedOutcome, vaultId = randomUUID() }) {
  if (commandMessageId) {
    const existing = getVaultSessionByCommand(db, commandMessageId);
    if (existing) {
      if (existing.guildId !== guildId || existing.rollerId !== userId || existing.channelId !== channelId)
        throw new Error('Vault reservation scope mismatch');
      return existing;
    }
  }
  const config = gameConfig ?? getGameConfig(db, guildId);
  const roster = getResolvedItemDefinitions(db, guildId);
  const captured = { ...(hasFortune(db) ? { fortuneVersion: 1 } : {}), rules: config.itemActions, weights: config.vault.tierWeights, roster,
    rewardPools: Object.fromEntries((hasFortune(db) ? ['common', 'rare', 'epic', 'legendary', '???'] : ['epic', 'legendary']).map(tier =>
      [tier, roster.filter(item => item.tier === tier && item.rewardEligible)])),
    ...(capturedOutcome ? { outcome: capturedOutcome } : {}) };
  db.prepare(`INSERT INTO vault_sessions (vault_id, command_message_id, paid_roll_id,
    guild_id, user_id, channel_id, remaining, captured_json, deadline, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(vaultId, commandMessageId,
    paidRollId == null ? null : String(paidRollId), guildId, userId, channelId, remaining,
    JSON.stringify(captured), now + (timeoutMs ?? config.vault.openTimeoutMs), now);
  return getVaultSession(db, vaultId);
}

export function drawVaultSessionOutcome(session, random = Math.random) {
  const captured = session.captured;
  return { ...(captured.outcome ?? rollVaultOutcome(random, random, captured.weights, captured.roster)),
    _rules: captured.rules, _rewardPools: captured.rewardPools,
    ...(captured.fortuneVersion === 1 ? { _fortuneVersion: 1 } : {}) };
}

export function bindVaultSessionMessage(db, vaultId, messageId, previousMessageId = null, now = Date.now()) {
  db.prepare(`UPDATE vault_sessions SET message_id = ?, delivered_at = ?
    WHERE vault_id = ? AND message_id IS ?`).run(messageId, now, vaultId, previousMessageId);
  return getVaultSession(db, vaultId);
}

/** DB-only inspector/reconciliation; deadlines never move during retries. */
export function inspectVaultSessions(db, { now = Date.now() } = {}) {
  if (!hasVaultSessions(db)) return [];
  // Explicit non-vault provenance outranks the legacy same-ID heuristic. Check
  // every collision before reconciliation/expiry can mutate any paid session.
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='reward_sources'").get()
    && db.prepare(`SELECT 1 FROM vault_sessions s JOIN reward_sources r ON r.reward_id=s.vault_id LIMIT 1`).get()) {
    throw new Error('Vault reward source collision');
  }
  db.prepare(`UPDATE vault_sessions SET state = 'revealed', reward_id = vault_id
    WHERE EXISTS (SELECT 1 FROM vault_rewards r WHERE r.vault_id = vault_sessions.vault_id)` ).run();
  db.prepare("UPDATE vault_sessions SET state = 'expired', delivered_at = NULL WHERE state = 'unopened' AND deadline <= ?").run(now);
  return db.prepare("SELECT vault_id FROM vault_sessions WHERE state = 'unopened' OR (state = 'expired' AND delivered_at IS NULL)")
    .all().map(row => getVaultSession(db, row.vault_id));
}
