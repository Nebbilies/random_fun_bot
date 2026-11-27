import { currentSeasonRows } from "./seasonSchema.js";
import { weeklyRewardExtraCharges } from "../features/weeklyEvents/weeklyEvents.js";
import { hasAffection } from "./characterAffection.js";
import {
  captureAffectionRewardInTransaction,
  finalizeAffectionRewardInTransaction,
  deliverAffectionEchoInTransaction,
  settleAffectionRewardCopyInTransaction,
  captureRewardUseCostInTransaction,
} from "./affectionRewards.js";
import {
  prepareRecast,
  getRecast,
  chooseRecast,
  hasFortune,
  getLens,
  acknowledgeLens,
} from "./vaultFortune.js";
import { getItemActionConfig } from "./itemActionConfig.js";
import {
  getRewardItemsInTier,
  getResolvedItemDefinition,
  ITEM_TIERS,
} from "./itemRoster.js";
import {
  addItemToInventory,
  removeItemFromInventory,
  decrementItemCharge,
  getUsableInventory,
} from "./itemStorage.js";

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
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function getVaultReward(db, vaultId) {
  const row = db
    .prepare(
      `SELECT * FROM ${currentSeasonRows(db, "vault_rewards")} WHERE vault_id = ?`,
    )
    .get(vaultId);
  if (!row) return null;
  return {
    vaultId: row.vault_id,
    guildId: row.guild_id,
    userId: row.user_id,
    channelId: row.channel_id,
    sourceMessageId: row.source_message_id,
    messageId: row.message_id,
    original: JSON.parse(row.original_json),
    reward: row.reward_json ? JSON.parse(row.reward_json) : null,
    state: row.state,
    deadline: row.deadline,
    gambleInventoryId: row.gamble_inventory_id,
    result: row.result,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    deliveredAt: row.delivered_at,
  };
}

/** Explicit provenance; malformed/unknown non-vault rows never fall back to vault policy. */
export function getItemRewardSource(db, rewardId) {
  if (
    !db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='reward_sources'",
      )
      .get()
  ) {
    if (/^(chit|aff|affection|echo)-/.test(String(rewardId)))
      throw new Error("Missing direct item reward provenance");
    return null;
  }
  const row = db
    .prepare("SELECT * FROM reward_sources WHERE reward_id=?")
    .get(rewardId);
  if (!row) {
    if (/^(chit|aff|affection|echo)-/.test(String(rewardId)))
      throw new Error("Missing direct item reward provenance");
    return null;
  }
  const metadata = JSON.parse(row.metadata_json);
  if (!validDirectSource(row.source_kind, row.source_id, metadata))
    throw new Error("Invalid direct item reward provenance");
  if (row.source_kind.startsWith("affection_")) {
    if (!hasAffection(db)) throw new Error("Missing affection reward schema");
    const copy = db
      .prepare(
        `SELECT c.*,g.parent_reward_id,g.guild_id,g.user_id,g.source_type FROM reward_copies c
      JOIN reward_grants g ON g.source_key=c.source_key WHERE c.reward_id=?`,
      )
      .get(rewardId);
    const reward = getVaultReward(db, rewardId);
    if (
      !copy ||
      !reward ||
      copy.source_key !== row.source_id ||
      copy.guild_id !== reward.guildId ||
      copy.user_id !== reward.userId ||
      copy.outcome_json !== JSON.stringify(reward.original) ||
      (row.source_kind === "affection_echo"
        ? copy.ordinal !== 1 ||
          copy.parent_reward_id !== metadata.parentRewardId ||
          copy.source_type === "affection_milestone"
        : copy.ordinal !== 0 || copy.source_type !== "affection_milestone")
    ) {
      throw new Error("Invalid affection reward provenance");
    }
  }
  return { kind: row.source_kind, id: row.source_id, metadata };
}

function validDirectSource(kind, sourceId, metadata) {
  if (metadata?.version !== 1 || typeof sourceId !== "string" || !sourceId)
    return false;
  if (kind === "mystery_consolation") return /^\d+$/.test(sourceId);
  if (kind === "affection_milestone")
    return (
      sourceId.startsWith("milestone:") &&
      typeof metadata.characterId === "string" &&
      typeof metadata.milestoneKey === "string"
    );
  if (kind === "affection_echo")
    return (
      typeof metadata.parentRewardId === "string" &&
      !!metadata.parentRewardId &&
      !metadata.parentRewardId.includes(":")
    );
  return false;
}

/** Caller owns the write transaction. No vault session or Fortune effect is consulted. */
export function createDirectItemRewardInTransaction(
  db,
  {
    rewardId,
    guildId,
    userId,
    channelId,
    sourceKind,
    sourceId,
    metadata,
    outcome,
    now = Date.now(),
    random = Math.random,
  },
) {
  if (
    !db.isTransaction ||
    typeof rewardId !== "string" ||
    !rewardId ||
    rewardId.includes(":") ||
    !validDirectSource(sourceKind, sourceId, metadata) ||
    !outcome?.item?.id
  )
    throw new Error("Invalid direct item reward");
  if (
    db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='vault_sessions'",
      )
      .get() &&
    db
      .prepare(
        `SELECT 1 FROM ${currentSeasonRows(db, "vault_sessions")} WHERE vault_id=?`,
      )
      .get(rewardId)
  ) {
    throw new Error("Direct reward source collision with vault session");
  }
  const previous = db
    .prepare(
      "SELECT reward_id FROM reward_sources WHERE source_kind=? AND source_id=?",
    )
    .get(sourceKind, sourceId);
  if (previous) {
    const reward = getVaultReward(db, previous.reward_id);
    const source = getItemRewardSource(db, previous.reward_id);
    if (
      !reward ||
      !source ||
      previous.reward_id !== rewardId ||
      reward.guildId !== guildId ||
      reward.userId !== userId ||
      reward.channelId !== channelId ||
      JSON.stringify(source.metadata) !== JSON.stringify(metadata) ||
      JSON.stringify(reward.original) !== JSON.stringify(outcome)
    )
      throw new Error("Direct reward scope mismatch");
    return reward;
  }
  db.prepare(
    `INSERT INTO vault_rewards(vault_id,guild_id,user_id,channel_id,original_json,state,created_at)
    VALUES(?,?,?,?,?,'revealed',?)`,
  ).run(rewardId, guildId, userId, channelId, JSON.stringify(outcome), now);
  db.prepare("INSERT INTO reward_sources VALUES(?,?,?,?)").run(
    rewardId,
    sourceKind,
    sourceId,
    JSON.stringify(metadata),
  );
  const reward = getVaultReward(db, rewardId);
  const final =
    sourceKind === "mystery_consolation"
      ? finalizeAffectionRewardInTransaction(db, reward, outcome, now, random)
      : outcome;
  const delivered = deliverNeutral(
    db,
    reward,
    final,
    sourceKind === "mystery_consolation" ? "consolation" : sourceKind,
    now,
  );
  if (sourceKind === "mystery_consolation")
    deliverAffectionEchoInTransaction(db, delivered, now);
  return delivered;
}

function gamblingEntry(db, guildId, userId, now) {
  return getUsableInventory(db, guildId, userId, now).find(
    (item) => item.item_id === "double_or_nothing",
  );
}

function deliver(db, reward, outcome, result, now, random = Math.random) {
  // Overflow retries deliver the already determined terminal choice. They must
  // never activate a Recast acquired/armed after this reward was resolved.
  const recast =
    reward.state === "overflow" || getItemRewardSource(db, reward.vaultId)
      ? null
      : prepareRecast(db, reward, outcome, now);
  if (recast && recast.state !== "chosen") {
    db.prepare(
      "UPDATE vault_rewards SET state='recast',reward_json=?,result=?,resolved_at=?,delivered_at=NULL WHERE vault_id=?",
    ).run(JSON.stringify(outcome), result, now, reward.vaultId);
    return getVaultReward(db, reward.vaultId);
  }
  const final = finalizeAffectionRewardInTransaction(
    db,
    reward,
    outcome,
    now,
    random,
  );
  const delivered = deliverNeutral(db, reward, final, result, now);
  deliverAffectionEchoInTransaction(db, delivered, now);
  return delivered;
}

function deliverNeutral(db, reward, outcome, result, now) {
  if (["delivered", "declined"].includes(reward.state)) return reward;
  const extra = weeklyRewardExtraCharges(db, reward, outcome.item.id, now);
  const added = addItemToInventory(
    db,
    reward.guildId,
    reward.userId,
    outcome.item.id,
    (outcome.item.maxCharges ?? outcome.item.startingCharges ?? 1) + extra,
    { now },
  );
  settleAffectionRewardCopyInTransaction(
    db,
    reward.vaultId,
    added.status === "full" ? "overflow" : "delivered",
    added.item,
    now,
  );
  db.prepare(
    `UPDATE vault_rewards SET state = ?, reward_json = ?, result = ?, resolved_at = ?, delivered_at = NULL WHERE vault_id = ?`,
  ).run(
    added.status === "full" ? "overflow" : "delivered",
    JSON.stringify(outcome),
    result,
    now,
    reward.vaultId,
  );
  return getVaultReward(db, reward.vaultId);
}

/** Persist before presenting. Duplicate source IDs always return their first outcome. */
export function revealVaultReward(
  db,
  {
    vaultId,
    guildId,
    userId,
    channelId,
    sourceMessageId = null,
    messageId = null,
    outcome,
    now = Date.now(),
    config = getItemActionConfig(db, guildId),
    random = Math.random,
  },
) {
  return transaction(db, () => {
    const savedSession =
      db
        .prepare("SELECT 1 FROM sqlite_schema WHERE name='vault_sessions'")
        .get() &&
      db
        .prepare("SELECT captured_json FROM vault_sessions WHERE vault_id=?")
        .get(vaultId);
    if (
      savedSession &&
      !db
        .prepare(
          `SELECT 1 FROM ${currentSeasonRows(db, "vault_sessions")} WHERE vault_id=?`,
        )
        .get(vaultId)
    )
      return null;
    const existing = getVaultReward(db, vaultId);
    if (existing) return existing;
    const rewardPools =
      outcome._rewardPools ??
      Object.fromEntries(
        ["epic", "legendary"].map((tier) => [
          tier,
          getRewardItemsInTier(db, guildId, tier),
        ]),
      );
    config = outcome._rules ?? config;
    const item = outcome.item.rules
      ? outcome.item
      : (getResolvedItemDefinition(db, guildId, outcome.item.id) ??
        outcome.item);
    outcome = { ...outcome, item, _rules: config, _rewardPools: rewardPools };
    const eligible =
      ["common", "rare"].includes(outcome.tier) &&
      gamblingEntry(db, guildId, userId, now) &&
      Object.entries(config.doubleRewardWeights).some(
        ([tier, weight]) => weight > 0 && rewardPools[tier]?.length,
      );
    const deadline = eligible ? now + config.doubleDecisionMs : null;
    db.prepare(
      `INSERT INTO vault_rewards
      (vault_id, guild_id, user_id, channel_id, source_message_id, message_id, original_json, state, deadline, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      vaultId,
      guildId,
      userId,
      channelId,
      sourceMessageId,
      messageId,
      JSON.stringify(outcome),
      eligible ? "decision" : "revealed",
      deadline,
      now,
    );
    // Selection itself confirms the committed Lens flow. Release its exhausted
    // source before capacity is checked, in the same reward transaction.
    if (getLens(db, vaultId)?.state === "pending")
      acknowledgeLens(db, vaultId, now);
    const reward = getVaultReward(db, vaultId);
    if (
      hasAffection(db) &&
      savedSession &&
      JSON.parse(savedSession.captured_json).affectionVersion === 1
    ) {
      captureAffectionRewardInTransaction(db, {
        sourceKey: `vault:${vaultId}`,
        sourceType: "vault",
        rewardId: vaultId,
        guildId,
        userId,
        outcome,
        pools: rewardPools,
        now,
      });
    }
    return eligible
      ? reward
      : deliver(db, reward, outcome, "kept", now, random);
  });
}

function draw(random) {
  const value = random();
  if (!Number.isFinite(value) || value < 0 || value >= 1)
    throw new Error("Invalid random value");
  return value;
}

function replacement(random, config, pools) {
  const weights = Object.entries(config.doubleRewardWeights).filter(
    ([tier, weight]) =>
      ["epic", "legendary"].includes(tier) &&
      pools[tier]?.length &&
      Number.isFinite(weight) &&
      weight > 0,
  );
  const total = weights.reduce((sum, [, weight]) => sum + weight, 0);
  if (!(total > 0)) throw new Error("No Double or Nothing reward weights");
  let target = draw(random) * total;
  let tier = weights[weights.length - 1][0];
  for (const [candidate, weight] of weights) {
    target -= weight;
    if (target < 0) {
      tier = candidate;
      break;
    }
  }
  const items = pools[tier];
  if (!items.length) throw new Error(`No items defined for tier ${tier}`);
  return {
    tier,
    tierData: ITEM_TIERS[tier],
    item: items[Math.floor(draw(random) * items.length)],
  };
}

/**
 * Owner/guild/channel/message scope is mandatory for every interactive mutation.
 * @param {any} db
 * @param {{vaultId: string, guildId: string, userId: string, channelId: string,
 *   messageId: string, action: string, inventoryId?: number, choice?: number, now?: number,
 *   random?: () => number, config?: ReturnType<typeof getItemActionConfig>}} request
 */
export function decideVaultReward(
  db,
  {
    vaultId,
    guildId,
    userId,
    channelId,
    messageId,
    action,
    inventoryId,
    choice,
    now = Date.now(),
    random = Math.random,
    config = undefined,
  },
) {
  return transaction(db, () => {
    let reward = getVaultReward(db, vaultId);
    if (!reward) return { status: "stale", reward: null };
    if (
      reward.guildId !== guildId ||
      reward.userId !== userId ||
      reward.channelId !== channelId ||
      !reward.messageId ||
      reward.messageId !== messageId
    )
      return { status: "forbidden", reward };
    const direct = getItemRewardSource(db, vaultId);
    if (
      direct &&
      (!["delivered", "overflow", "declined"].includes(reward.state) ||
        !["replace", "decline", "accept"].includes(action))
    )
      return { status: "invalid", reward };
    if (action === "recast" && reward.state !== "recast")
      return { status: "stale", reward };
    if (action === "recast" && reward.state === "recast") {
      const selected = chooseRecast(db, {
        vaultId,
        guildId,
        userId,
        channelId,
        messageId,
        choice,
        now,
        random,
      });
      if (selected.status !== "chosen")
        return { status: selected.status, reward };
      return {
        status: "resolved",
        reward: deliver(
          db,
          reward,
          selected.outcome,
          reward.result,
          now,
          random,
        ),
      };
    }
    if (!["keep", "gamble", "replace", "decline", "accept"].includes(action))
      return { status: "invalid", reward };
    if (reward.state === "decision") {
      if (now >= reward.deadline) {
        reward = deliver(db, reward, reward.original, "kept", now, random);
        return { status: "expired", reward };
      }
      if (action === "keep")
        return {
          status: "resolved",
          reward: deliver(db, reward, reward.original, "kept", now, random),
        };
      if (action !== "gamble") return { status: "invalid", reward };
      const entry = gamblingEntry(db, guildId, userId, now);
      if (!entry) return { status: "missing_item", reward };
      const rules =
        reward.original._rules ?? config ?? getItemActionConfig(db, guildId);
      const pools =
        reward.original._rewardPools ??
        Object.fromEntries(
          ["epic", "legendary"].map((tier) => [
            tier,
            getRewardItemsInTier(db, guildId, tier),
          ]),
        );
      const cost = captureRewardUseCostInTransaction(db, {
        sourceKey: `gamble:${vaultId}`,
        guildId,
        userId,
        inventoryId: entry.id,
        now,
        random,
      });
      const won = draw(random) < rules.doubleWinChance;
      const outcome = won
        ? {
            ...replacement(random, rules, pools),
            ...(reward.original._fortuneVersion === 1
              ? { _fortuneVersion: 1, _rules: rules, _rewardPools: pools }
              : {}),
          }
        : null;
      const spent = cost.actual_debit ? decrementItemCharge(db, entry.id) : {};
      if (spent.escrowed) throw new Error("Gambling cost unavailable");
      db.prepare(
        "UPDATE vault_rewards SET gamble_inventory_id = ? WHERE vault_id = ?",
      ).run(entry.id, vaultId);
      if (outcome)
        return {
          status: "resolved",
          reward: deliver(db, reward, outcome, "won", now, random),
        };
      finalizeAffectionRewardInTransaction(db, reward, null, now, random);
      db.prepare(
        `UPDATE vault_rewards SET state = 'lost', result = 'lost', resolved_at = ?, delivered_at = NULL WHERE vault_id = ?`,
      ).run(now, vaultId);
      return { status: "resolved", reward: getVaultReward(db, vaultId) };
    }
    if (reward.state !== "overflow") return { status: "stale", reward };
    if (action === "decline") {
      settleAffectionRewardCopyInTransaction(
        db,
        vaultId,
        "declined",
        null,
        now,
      );
      db.prepare(
        "UPDATE vault_rewards SET state = 'declined', delivered_at = NULL WHERE vault_id = ?",
      ).run(vaultId);
      return { status: "resolved", reward: getVaultReward(db, vaultId) };
    }
    if (!["replace", "accept"].includes(action))
      return { status: "invalid", reward };
    if (action === "replace") {
      if (!Number.isSafeInteger(inventoryId))
        return { status: "invalid_inventory", reward };
      const entry = getUsableInventory(db, guildId, userId, now).find(
        (item) => item.id === inventoryId,
      );
      if (!entry) return { status: "invalid_inventory", reward };
      if (!removeItemFromInventory(db, entry.id))
        throw new Error("Replacement cost unavailable");
      const delivered = deliver(db, reward, reward.reward, reward.result, now);
      if (!delivered || delivered.state !== "delivered")
        throw new Error("Inventory remains full");
      return { status: "resolved", reward: delivered };
    }
    return {
      status: "resolved",
      reward: deliver(db, reward, reward.reward, reward.result, now),
    };
  });
}

/** Persist the Discord prompt binding; never bind an existing reward to a different message. */
export function bindVaultRewardMessage(
  db,
  vaultId,
  channelId,
  messageId,
  previousMessageId = null,
) {
  db.prepare(
    `UPDATE vault_rewards SET message_id = ? WHERE vault_id = ? AND channel_id = ? AND message_id IS ?
    AND EXISTS (SELECT 1 FROM ${currentSeasonRows(db, "vault_rewards")} current WHERE current.vault_id = vault_rewards.vault_id)`,
  ).run(messageId, vaultId, channelId, previousMessageId);
  return getVaultReward(db, vaultId);
}

export function markVaultRewardDelivered(db, vaultId, now = Date.now()) {
  db.prepare(
    `UPDATE vault_rewards SET delivered_at = ? WHERE vault_id = ?
    AND EXISTS (SELECT 1 FROM ${currentSeasonRows(db, "vault_rewards")} current WHERE current.vault_id = vault_rewards.vault_id)`,
  ).run(now, vaultId);
}

/** DB-only startup reconciliation. No prompt or collector is needed to choose overdue Keep. */
export function reconcileVaultRewards(
  db,
  { now = Date.now(), collectPending = true } = {},
) {
  return transaction(db, () => {
    const overdue = db
      .prepare(
        `SELECT vault_id FROM ${currentSeasonRows(db, "vault_rewards")} WHERE state = 'decision' AND deadline <= ?`,
      )
      .all(now);
    for (const row of overdue) {
      const reward = getVaultReward(db, row.vault_id);
      if (reward) deliver(db, reward, reward.original, "kept", now);
    }
    if (hasFortune(db))
      for (const row of db
        .prepare(
          `SELECT f.vault_id FROM fortune_recasts f
      JOIN ${currentSeasonRows(db, "vault_rewards")} r ON r.vault_id=f.vault_id
      WHERE f.state='presented' AND f.deadline<=?`,
        )
        .all(now)) {
        const reward = getVaultReward(db, row.vault_id);
        const decision = getRecast(db, row.vault_id);
        if (reward?.state !== "recast")
          throw new Error("Recast delivery linkage missing");
        db.prepare(
          "UPDATE fortune_recasts SET state='chosen',choice=-1 WHERE vault_id=?",
        ).run(row.vault_id);
        deliver(db, reward, decision.original, reward.result, now);
      }
    if (collectPending) return listPendingVaultRewards(db);
  });
}

export function listPendingVaultRewards(db) {
  return listPendingVaultRewardCards(db).map(({ vaultId }) =>
    getVaultReward(db, vaultId),
  );
}

export function listPendingVaultRewardCards(db) {
  return db
    .prepare(
      `SELECT vault_id AS vaultId, channel_id AS channelId, delivered_at AS deliveredAt
      FROM ${currentSeasonRows(db, "vault_rewards")}
      WHERE state IN ('decision', 'overflow', 'recast') OR delivered_at IS NULL
      ORDER BY vault_id`,
    )
    .all();
}
