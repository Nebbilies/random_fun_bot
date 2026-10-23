import { ITEM_ACTION_CONFIG } from './itemActionConfig.js';
import { getItemsInTier, ITEM_TIERS } from './itemRoster.js';
import { addItemToInventory, removeItemFromInventory } from './itemStorage.js';

/** The parent owns schema-version migration and calls this initializer. */
export function initVaultRewards(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS vault_rewards (
    vault_id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, user_id TEXT NOT NULL,
    channel_id TEXT NOT NULL, source_message_id TEXT, message_id TEXT,
    original_json TEXT NOT NULL, reward_json TEXT, state TEXT NOT NULL,
    deadline INTEGER, gamble_inventory_id INTEGER, result TEXT,
    created_at INTEGER NOT NULL, resolved_at INTEGER, delivered_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS vault_rewards_pending ON vault_rewards(state, deadline);`);
}

function transaction(db, operation) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function getVaultReward(db, vaultId) {
  const row = db.prepare('SELECT * FROM vault_rewards WHERE vault_id = ?').get(vaultId);
  if (!row) return null;
  return {
    vaultId: row.vault_id, guildId: row.guild_id, userId: row.user_id,
    channelId: row.channel_id, sourceMessageId: row.source_message_id,
    messageId: row.message_id, original: JSON.parse(row.original_json),
    reward: row.reward_json ? JSON.parse(row.reward_json) : null,
    state: row.state, deadline: row.deadline, gambleInventoryId: row.gamble_inventory_id,
    result: row.result, createdAt: row.created_at, resolvedAt: row.resolved_at,
    deliveredAt: row.delivered_at,
  };
}

function gamblingEntry(db, guildId, userId) {
  return db.prepare(`SELECT i.* FROM user_inventory i
    WHERE i.guild_id = ? AND i.user_id = ? AND i.item_id = 'double_or_nothing'
    AND i.charges > 0 AND NOT EXISTS
      (SELECT 1 FROM item_action_costs c WHERE c.inventory_id = i.id)
    ORDER BY i.id LIMIT 1`).get(guildId, userId);
}

function deliver(db, reward, outcome, result, now) {
  const added = addItemToInventory(db, reward.guildId, reward.userId, outcome.item.id, outcome.item.maxCharges ?? 1);
  db.prepare(`UPDATE vault_rewards SET state = ?, reward_json = ?, result = ?, resolved_at = ?, delivered_at = NULL WHERE vault_id = ?`)
    .run(added.status === 'full' ? 'overflow' : 'delivered', JSON.stringify(outcome), result, now, reward.vaultId);
  return getVaultReward(db, reward.vaultId);
}

/** Persist before presenting. Duplicate source IDs always return their first outcome. */
export function revealVaultReward(db, {
  vaultId, guildId, userId, channelId, sourceMessageId = null, messageId = null,
  outcome, now = Date.now(), config = ITEM_ACTION_CONFIG,
}) {
  return transaction(db, () => {
    const existing = getVaultReward(db, vaultId);
    if (existing) return existing;
    const eligible = ['common', 'rare'].includes(outcome.tier) && gamblingEntry(db, guildId, userId);
    const deadline = eligible ? now + config.doubleDecisionMs : null;
    db.prepare(`INSERT INTO vault_rewards
      (vault_id, guild_id, user_id, channel_id, source_message_id, message_id, original_json, state, deadline, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(vaultId, guildId, userId, channelId, sourceMessageId, messageId,
        JSON.stringify(outcome), eligible ? 'decision' : 'revealed', deadline, now);
    const reward = getVaultReward(db, vaultId);
    return eligible ? reward : deliver(db, reward, outcome, 'kept', now);
  });
}

function draw(random) {
  const value = random();
  if (!Number.isFinite(value) || value < 0 || value >= 1) throw new Error('Invalid random value');
  return value;
}

function replacement(random, config) {
  const weights = Object.entries(config.doubleRewardWeights).filter(([tier, weight]) =>
    ['epic', 'legendary'].includes(tier) && Number.isFinite(weight) && weight > 0);
  const total = weights.reduce((sum, [, weight]) => sum + weight, 0);
  if (!(total > 0)) throw new Error('No Double or Nothing reward weights');
  let target = draw(random) * total;
  let tier = weights[weights.length - 1][0];
  for (const [candidate, weight] of weights) {
    target -= weight;
    if (target < 0) { tier = candidate; break; }
  }
  const items = getItemsInTier(tier);
  if (!items.length) throw new Error(`No items defined for tier ${tier}`);
  return { tier, tierData: ITEM_TIERS[tier], item: items[Math.floor(draw(random) * items.length)] };
}

/** Owner/guild/channel/message scope is mandatory for every interactive mutation. */
export function decideVaultReward(db, {
  vaultId, guildId, userId, channelId, messageId, action, inventoryId,
  now = Date.now(), random = Math.random, config = ITEM_ACTION_CONFIG,
}) {
  return transaction(db, () => {
    let reward = getVaultReward(db, vaultId);
    if (!reward) return { status: 'stale', reward: null };
    if (reward.guildId !== guildId || reward.userId !== userId || reward.channelId !== channelId ||
        !reward.messageId || reward.messageId !== messageId) return { status: 'forbidden', reward };
    if (!['keep', 'gamble', 'replace', 'decline', 'accept'].includes(action)) return { status: 'invalid', reward };
    if (reward.state === 'decision') {
      if (now >= reward.deadline) {
        reward = deliver(db, reward, reward.original, 'kept', now);
        return { status: 'expired', reward };
      }
      if (action === 'keep') return { status: 'resolved', reward: deliver(db, reward, reward.original, 'kept', now) };
      if (action !== 'gamble') return { status: 'invalid', reward };
      const entry = gamblingEntry(db, guildId, userId);
      if (!entry) return { status: 'missing_item', reward };
      const won = draw(random) < config.doubleWinChance;
      const outcome = won ? replacement(random, config) : null;
      if (!removeItemFromInventory(db, entry.id)) throw new Error('Gambling cost unavailable');
      db.prepare('UPDATE vault_rewards SET gamble_inventory_id = ? WHERE vault_id = ?').run(entry.id, vaultId);
      if (outcome) return { status: 'resolved', reward: deliver(db, reward, outcome, 'won', now) };
      db.prepare(`UPDATE vault_rewards SET state = 'lost', result = 'lost', resolved_at = ?, delivered_at = NULL WHERE vault_id = ?`).run(now, vaultId);
      return { status: 'resolved', reward: getVaultReward(db, vaultId) };
    }
    if (reward.state !== 'overflow') return { status: 'stale', reward };
    if (action === 'decline') {
      db.prepare("UPDATE vault_rewards SET state = 'declined', delivered_at = NULL WHERE vault_id = ?").run(vaultId);
      return { status: 'resolved', reward: getVaultReward(db, vaultId) };
    }
    if (!['replace', 'accept'].includes(action)) return { status: 'invalid', reward };
    if (action === 'replace') {
      if (!Number.isSafeInteger(inventoryId)) return { status: 'invalid_inventory', reward };
      const entry = db.prepare(`SELECT i.id FROM user_inventory i WHERE i.id = ? AND i.guild_id = ? AND i.user_id = ?
        AND NOT EXISTS (SELECT 1 FROM item_action_costs c WHERE c.inventory_id = i.id)`).get(inventoryId, guildId, userId);
      if (!entry) return { status: 'invalid_inventory', reward };
      if (!removeItemFromInventory(db, entry.id)) throw new Error('Replacement cost unavailable');
      const delivered = deliver(db, reward, reward.reward, reward.result, now);
      if (!delivered || delivered.state !== 'delivered') throw new Error('Inventory remains full');
      return { status: 'resolved', reward: delivered };
    }
    return { status: 'resolved', reward: deliver(db, reward, reward.reward, reward.result, now) };
  });
}

/** Persist the Discord prompt binding; never bind an existing reward to a different message. */
export function bindVaultRewardMessage(db, vaultId, channelId, messageId, previousMessageId = null) {
  db.prepare(`UPDATE vault_rewards SET message_id = ? WHERE vault_id = ? AND channel_id = ? AND message_id IS ?`)
    .run(messageId, vaultId, channelId, previousMessageId);
  return getVaultReward(db, vaultId);
}

export function markVaultRewardDelivered(db, vaultId, now = Date.now()) {
  db.prepare('UPDATE vault_rewards SET delivered_at = ? WHERE vault_id = ?').run(now, vaultId);
}

/** DB-only startup reconciliation. No prompt or collector is needed to choose overdue Keep. */
export function reconcileVaultRewards(db, { now = Date.now() } = {}) {
  return transaction(db, () => {
    const overdue = db.prepare("SELECT vault_id FROM vault_rewards WHERE state = 'decision' AND deadline <= ?").all(now);
    for (const row of overdue) {
      const reward = getVaultReward(db, row.vault_id);
      if (reward) deliver(db, reward, reward.original, 'kept', now);
    }
    return listPendingVaultRewards(db);
  });
}

export function listPendingVaultRewards(db) {
  return db.prepare(`SELECT vault_id FROM vault_rewards WHERE state IN ('decision', 'overflow') OR delivered_at IS NULL`)
    .all().map(row => getVaultReward(db, row.vault_id));
}
