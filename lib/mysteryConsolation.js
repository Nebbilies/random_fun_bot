import { createHash } from 'node:crypto';
import { getGameConfig } from './gameConfig.js';
import { getResolvedItemDefinitions, ITEM_TIERS } from './itemRoster.js';
import { getUsableInventory, decrementItemCharge } from './itemStorage.js';
import { createDirectItemRewardInTransaction, getItemRewardSource, getVaultReward } from './vaultRewards.js';

export function consolationRewardId(sessionId) {
  return `chit-${createHash('sha256').update(`mystery-consolation:${sessionId}`).digest('hex').slice(0, 32)}`;
}

function draw(random) {
  const value = random();
  if (!Number.isFinite(value) || value < 0 || value >= 1) throw new Error('Invalid random value');
  return value;
}

/** Called only at the validated genuine-win boundary, inside its transaction. */
export function resolveMysteryConsolation(db, { session, winnerId, canClaim, now, random = Math.random }) {
  if (!db.isTransaction) throw new Error('Consolation requires a transaction');
  const decision = status => ({ version: 1, status });
  if (canClaim) return decision('claim_available');
  const entry = getUsableInventory(db, session.guildId, winnerId, now)
    .find(item => item.item_id === 'consolation_chit');
  if (!entry) return decision('no_chit');
  const config = getGameConfig(db, session.guildId);
  const weights = config.itemEffects?.consolation_chit?.tierWeights;
  const roster = getResolvedItemDefinitions(db, session.guildId, config).filter(item => item.rewardEligible);
  const eligible = Object.entries(weights ?? {}).filter(([tier, weight]) =>
    Number.isFinite(weight) && weight > 0 && roster.some(item => item.tier === tier));
  const total = eligible.reduce((sum, [, weight]) => sum + weight, 0);
  if (!(total > 0) || !Number.isFinite(total)) return decision('no_reward_pool');
  let cursor = draw(random) * total;
  const last = eligible.at(-1);
  if (!last) return decision('no_reward_pool');
  let tier = last[0];
  for (const [candidate, weight] of eligible) { cursor -= weight; if (cursor < 0) { tier = candidate; break; } }
  const items = roster.filter(item => item.tier === tier);
  const outcome = { tier, tierData: ITEM_TIERS[tier], item: items[Math.floor(draw(random) * items.length)] };
  const rewardId = consolationRewardId(session.id);
  const metadata = { version: 1, sessionId: session.id, guildId: session.guildId, userId: winnerId,
    channelId: session.eventChannelId, inventoryId: entry.id, resolvedAt: now,
    tierWeights: weights, rewardPool: roster };
  const spent = decrementItemCharge(db, entry.id);
  if (spent.escrowed) throw new Error('Consolation cost unavailable');
  createDirectItemRewardInTransaction(db, { rewardId, guildId: session.guildId, userId: winnerId,
    channelId: session.eventChannelId, sourceKind: 'mystery_consolation', sourceId: String(session.id),
    metadata, outcome, now });
  return { ...decision('activated'), rewardId };
}

/** Read-only integrity check used by startup and the publication gate. Legacy decisions stay absent. */
export function inspectMysteryConsolation(db, session) {
  const runtime = JSON.parse(session.stateJson || 'null')?.runtime;
  const decision = runtime?.consolation;
  if (decision == null) return null;
  if (decision.version !== 1 || !['claim_available', 'no_chit', 'no_reward_pool', 'activated'].includes(decision.status)
    || runtime.resolved?.type !== 'winner' || runtime.resolved.winnerId !== session.winnerId) {
    throw new Error('Invalid mystery consolation decision');
  }
  if (decision.status !== 'activated') return decision;
  // Validate even terminal/acknowledged sessions: a paid reveal obligation must
  // never disappear through truthiness or an acknowledgement without a binding.
  const acknowledgement = runtime.consolationRevealAcknowledged;
  const messageId = runtime.prizeMessageId;
  if ((acknowledgement !== undefined && typeof acknowledgement !== 'boolean')
    || (messageId !== undefined && (typeof messageId !== 'string' || !/^\d+$/.test(messageId)))
    || (acknowledgement === true && !messageId)) {
    throw new Error('Invalid acknowledged consolation reveal binding');
  }
  const reward = getVaultReward(db, decision.rewardId);
  const source = getItemRewardSource(db, decision.rewardId);
  const metadata = source?.metadata;
  if (decision.rewardId !== consolationRewardId(session.id) || source?.id !== String(session.id)
    || !reward || reward.guildId !== session.guildId || reward.userId !== session.winnerId
    || reward.channelId !== session.eventChannelId || metadata.sessionId !== session.id
    || metadata.guildId !== session.guildId || metadata.userId !== session.winnerId
    || metadata.channelId !== session.eventChannelId || !Number.isSafeInteger(metadata.inventoryId) || metadata.inventoryId <= 0
    || !Number.isSafeInteger(metadata.resolvedAt) || metadata.resolvedAt < 0 || reward.createdAt !== metadata.resolvedAt
    || !Array.isArray(metadata.rewardPool) || !metadata.rewardPool.some(item =>
      JSON.stringify(item) === JSON.stringify(reward.original?.item))
    || !(metadata.tierWeights?.[reward.original?.tier] > 0)
    || reward.original?.item?.tier !== reward.original?.tier
    || !['delivered', 'overflow', 'declined'].includes(reward.state) || reward.result !== 'consolation'
    || reward.gambleInventoryId != null || !reward.reward
    || JSON.stringify(reward.original) !== JSON.stringify(reward.reward)) {
    throw new Error('Invalid mystery consolation reward linkage');
  }
  return decision;
}

export function isConsolationRewardPublishable(db, reward) {
  const source = getItemRewardSource(db, reward.vaultId);
  if (!source) return true;
  const row = db.prepare(`SELECT id,guild_id AS guildId,winner_id AS winnerId,event_channel_id AS eventChannelId,
    state_json AS stateJson FROM mystery_sessions WHERE id=?`).get(Number(source.id));
  if (!row) throw new Error('Missing consolation mystery');
  const decision = inspectMysteryConsolation(db, row);
  if (decision?.status !== 'activated' || decision.rewardId !== reward.vaultId)
    throw new Error('Missing consolation activation decision');
  const runtime = JSON.parse(row.stateJson).runtime;
  return Boolean(runtime.prizeMessageId && runtime.consolationRevealAcknowledged === true);
}
