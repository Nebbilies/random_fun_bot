import { currentSeasonRows } from "./seasonSchema.js";
import { randomUUID } from "node:crypto";
import { bloodPact } from "./items/bloodPact.js";
import {
  HOSTAGE_MIN_RANK_MULTIPLIER,
  HOSTAGE_TOP_RANK,
} from "./items/hostageNote.js";
import { requireNewGameAction } from "./catalogMaintenance.js";
import { cancelSelectedCharacterInteractions } from "./characterInteractionCancellation.js";
import { isCharacterBusy, isCharacterHeld } from "./characterAvailability.js";
import { redirectWithCrown, resolveSoulmateNegation } from "./itemDefense.js";
import {
  hasItemAffection,
  getItemUseReceipt,
  saveItemUseReceipt,
  itemConservationChance,
  captureAffectionItemUseInTransaction,
  spendAffectionItemChargeInTransaction,
} from "./affectionItemUse.js";
export { redirectWithCrown } from "./itemDefense.js";
import { transaction } from "./catalogDb.js";
import { withOwnershipOperationClock } from "./characterOwnershipHistory.js";
import { getItemDefinition, getRewardItemsInTier } from "./itemRoster.js";
import {
  getUsableInventory,
  removeItemFromInventory,
  addItemToInventory,
  isCharacterLocked,
} from "./itemStorage.js";
import {
  getItemAction,
  setCounterfeitCrown,
  getItemActionSource,
  consumeItemActionSource,
  releaseItemActionSource,
  reserveItemActionSource,
} from "./itemActionStorage.js";
import {
  getItemActionConfig,
  randomIndex,
  weightedTier,
} from "./itemActionConfig.js";
import { characterFranchiseRelation } from "./characterFranchises.js";
import { getItemRules } from "./itemRuntimeConfig.js";

export const ACTION_ITEMS = new Set([
  "blood_pact",
  "alchemist",
  "chaos_exchange",
  "counterfeit_crown",
  "heart_for_a_heart",
  "hostage_note",
  "severed_fate",
  "grand_masquerade",
  "kaimetsu",
  "threadbreaker",
  "chronicle_of_return",
  "shackles_of_liberation",
]);
const fail = (message) => {
  throw new ActionRefusal(message);
};
class ActionRefusal extends Error {}

export function createItemAction(
  db,
  {
    guildId,
    actorId,
    channelId,
    inventoryId,
    invocationId,
    selections = {},
    now = Date.now(),
  },
) {
  return transaction(db, () => {
    const scope = {
      invocationId,
      guildId,
      userId: actorId,
      channelId,
      kind: "manual_item",
    };
    // Writer serialization covers lookup, creation, source hold and receipt. A
    // replay is a continuation, even when the source is gone or ingress paused.
    if (invocationId && hasItemAffection(db)) {
      const saved = getItemUseReceipt(db, scope);
      if (saved) {
        const action = getItemAction(db, saved.actionId);
        if (
          !saved.pendingAction ||
          !action ||
          action.guild_id !== guildId ||
          action.actor_id !== actorId ||
          action.channel_id !== channelId ||
          action.inventory_id !== saved.inventoryId
        )
          throw new Error(
            "Item action invocation scope mismatch or corrupt receipt",
          );
        return action;
      }
    }
    requireNewGameAction(db);
    const item = getUsableInventory(db, guildId, actorId, now).find(
      (row) => row.id === inventoryId,
    );
    if (!item || !ACTION_ITEMS.has(item.item_id))
      return { status: "invalid", message: "This item is unavailable." };
    if (item.item_id === "chronicle_of_return" && !hasChronicleHistory(db)) {
      return {
        status: "invalid",
        message:
          "Chronicle of Return requires supported ownership history. No cost.",
      };
    }
    const id = randomUUID();
    const rules = getItemActionConfig(db, guildId);
    if (item.item_id === "blood_pact")
      rules.bloodPactSacrificeCount = getItemRules(
        db,
        guildId,
        "blood_pact",
      ).sacrificeCount;
    selections = {
      ...selections,
      _rules: rules,
      _rewardPools: Object.fromEntries(
        ["rare", "epic", "legendary"].map((tier) => [
          tier,
          getRewardItemsInTier(db, guildId, tier),
        ]),
      ),
    };
    db.prepare(
      `INSERT INTO item_actions(id,kind,guild_id,actor_id,channel_id,inventory_id,state,selections_json,created_at,expires_at)
      VALUES(?,?,?,?,?,?,'confirming',?,?,?)`,
    ).run(
      id,
      item.item_id,
      guildId,
      actorId,
      channelId,
      inventoryId,
      JSON.stringify(selections),
      now,
      now +
        (item.item_id === "grand_masquerade"
          ? rules.masqueradeConfirmationMs
          : rules.confirmationMs),
    );
    reserveItemActionSource(db, id, item, now);
    if (item.item_id === "chronicle_of_return") {
      const historyWindowMs =
        getItemRules(db, guildId, item.item_id).historyWindowMs ?? 604800000;
      if (!Number.isSafeInteger(historyWindowMs) || historyWindowMs <= 0)
        throw new Error("Invalid Chronicle history window");
      selections.historyWindowMs = historyWindowMs;
      db.prepare("UPDATE item_actions SET selections_json=? WHERE id=?").run(
        JSON.stringify(selections),
        id,
      );
      const action = getItemAction(db, id);
      if (!getChronicleTargets(db, action, now).length) {
        finish(
          db,
          action,
          {
            noCost: true,
            message:
              "No formerly owned characters are available to return. No cost.",
          },
          "canceled",
        );
      }
    }
    if (invocationId)
      saveItemUseReceipt(db, {
        ...scope,
        inventoryId,
        now,
        result: {
          success: false,
          pendingAction: true,
          inventoryId,
          actionId: id,
        },
      });
    return getItemAction(db, id);
  });
}

export function updateItemSelection(
  db,
  id,
  guildId,
  actorId,
  selections,
  now = Date.now(),
) {
  const action = getItemAction(db, id);
  if (
    !action ||
    action.state !== "confirming" ||
    action.guild_id !== guildId ||
    action.actor_id !== actorId ||
    now >= action.expires_at
  )
    return false;
  db.prepare("UPDATE item_actions SET selections_json=? WHERE id=?").run(
    JSON.stringify({
      ...selections,
      _rules: action.selections._rules,
      _rewardPools: action.selections._rewardPools,
      historyWindowMs: action.selections.historyWindowMs,
    }),
    id,
  );
  return true;
}

function hasChronicleHistory(db) {
  return Boolean(
    db
      .prepare(
        "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='character_ownership_losses'",
      )
      .get(),
  );
}

/** Stable identity selection: never reuse a former marriage ID or metadata. */
export function getChronicleTargets(db, action, now = Date.now()) {
  const window = action.selections.historyWindowMs;
  if (!Number.isSafeInteger(window) || window <= 0 || !hasChronicleHistory(db))
    return [];
  return db
    .prepare(
      `SELECT c.id AS characterId,c.rank,c.name_full AS name,h.lost_at AS lostAt
    FROM character_ownership_losses h JOIN characters c ON c.id=h.character_id
    WHERE h.guild_id=? AND h.former_owner_id=? AND h.lost_at<=? AND h.lost_at>=?
    AND NOT EXISTS(SELECT 1 FROM marriages m WHERE m.guild_id=h.guild_id AND m.character_id=h.character_id)
    ORDER BY c.rank,c.id`,
    )
    .all(action.guild_id, action.actor_id, now, now - window)
    .filter(
      (row) =>
        !isCharacterBusy(db, action.guild_id, row.characterId, now) &&
        !isCharacterHeld(db, action.guild_id, row.characterId, now),
    );
}

/** Exact marriage snapshots for the durable unbinding picker; no defense interception. */
export function getShacklesTargets(db, action, now = Date.now()) {
  return db
    .prepare(
      `SELECT m.id AS marriageId,m.character_id AS characterId,m.owner_id AS ownerId,c.rank,c.name_full AS name
    FROM marriages m JOIN characters c ON c.id=m.character_id
    JOIN character_protection_locks l ON l.guild_id=m.guild_id AND l.character_id=m.character_id
    WHERE m.guild_id=? AND l.lock_type='soulbind'
      AND (l.protected_until IS NULL OR l.protected_until > ?)
    ORDER BY c.rank,c.id`,
    )
    .all(action.guild_id, now)
    .filter(
      (row) => !isCharacterBusy(db, action.guild_id, row.characterId, now),
    );
}

function owned(db, guildId, choice) {
  if (!choice?.characterId || !choice.ownerId || !choice.marriageId)
    fail("Select a current owned character.");
  const row = db
    .prepare(
      `SELECT m.id AS marriageId,m.character_id AS characterId,m.owner_id AS ownerId,c.rank,c.name_full AS name
    FROM marriages m JOIN characters c ON c.id=m.character_id WHERE m.guild_id=? AND m.character_id=?`,
    )
    .get(guildId, choice.characterId);
  if (
    !row ||
    row.ownerId !== choice.ownerId ||
    row.marriageId !== choice.marriageId
  )
    fail("Ownership changed. Nothing was consumed.");
  return row;
}

function busy(db, guild, id, now) {
  return isCharacterBusy(db, guild, id, now);
}
function eligible(db, guild, row, now, unprotected = false) {
  const lock = isCharacterLocked(db, guild, row.characterId, now);
  if (
    (lock.locked &&
      (lock.permanent || lock.lockType === "soulbind" || unprotected)) ||
    busy(db, guild, row.characterId, now)
  )
    fail("Character is protected or committed to another action.");
  return row;
}
function meetsRankInterval(ownRank, targetRank, minMultiplier, topRank) {
  return (
    targetRank >= Math.ceil(minMultiplier * ownRank) ||
    (ownRank <= topRank && targetRank <= topRank)
  );
}
function loseCrown(db, guild, id) {
  db.prepare(
    "DELETE FROM counterfeit_crowns WHERE guild_id=? AND character_id=?",
  ).run(guild, id);
}
function divorce(db, guild, row) {
  loseCrown(db, guild, row.characterId);
  const change = db
    .prepare(
      "DELETE FROM marriages WHERE guild_id=? AND character_id=? AND owner_id=? AND id=?",
    )
    .run(guild, row.characterId, row.ownerId, row.marriageId);
  if (change.changes !== 1) fail("Ownership changed.");
}
function transfer(db, guild, row, owner, now) {
  loseCrown(db, guild, row.characterId);
  if (
    db
      .prepare(
        "UPDATE marriages SET owner_id=?,married_at=? WHERE guild_id=? AND character_id=? AND owner_id=? AND id=?",
      )
      .run(
        owner,
        new Date(now).toISOString(),
        guild,
        row.characterId,
        row.ownerId,
        row.marriageId,
      ).changes !== 1
  )
    fail("Ownership changed.");
}
function finish(db, action, result, state = "resolved") {
  releaseItemActionSource(db, action.id);
  const outcome = {
    status: state,
    ...action.selections?._affectionPayment,
    ...action._payment,
    ...result,
  };
  db.prepare(
    "UPDATE item_actions SET state=?,result_json=?,delivery_pending=1 WHERE id=?",
  ).run(state, JSON.stringify(outcome), action.id);
  return outcome;
}

export function activateItemAction(
  db,
  { actionId, guildId, actorId, now = Date.now(), random = Math.random },
) {
  // Never cancel memory-only sessions inside the transaction: a later SQL or
  // COMMIT failure must leave them live. No await may separate commit and cleanup.
  let afterCommit = null;
  try {
    const result = withOwnershipOperationClock(db, now, () => {
      const action = getItemAction(db, actionId);
      if (!action || action.guild_id !== guildId || action.actor_id !== actorId)
        fail("This action is not yours.");
      if (action.state !== "confirming")
        return action.result ?? { status: action.state };
      if (now >= action.expires_at)
        return finish(
          db,
          action,
          { message: "Confirmation expired. No cost." },
          "expired",
        );
      const source = getItemActionSource(db, action);
      if (!source) fail("Item is no longer available.");
      const chance = itemConservationChance(db, guildId, actorId);
      const pay = () => {
        action._payment = consumeItemActionSource(db, action, {
          chance,
          now,
          random,
        });
        return action._payment;
      };
      const s = action.selections;
      const rules = s._rules ?? getItemActionConfig(db, guildId);
      if (action.kind === "shackles_of_liberation") {
        const target = owned(db, guildId, s.unbindTarget);
        if (busy(db, guildId, target.characterId, now))
          fail("This character is committed to another action. No cost.");
        // Never use the broad lock remover: a replacement temporary or unrelated
        // permanent lock must survive a stale confirmation.
        const removed = db
          .prepare(
            `DELETE FROM character_protection_locks
          WHERE guild_id=? AND character_id=? AND lock_type='soulbind'
            AND (protected_until IS NULL OR protected_until > ?)`,
          )
          .run(guildId, target.characterId, now);
        if (removed.changes !== 1)
          fail("This character is no longer soulbound. No cost.");
        pay();
        return finish(db, action, {
          target: { ...target },
          message: `🔓 **${target.name}** was freed from their soulbind by **Shackles of Liberation**. They remain owned by <@${target.ownerId}>. No claim priority or cooldown was added; their owner may soulbind them again immediately with another Aegis of Fidelity.`,
        });
      }
      if (action.kind === "chronicle_of_return") {
        const target = getChronicleTargets(db, action, now).find(
          (row) => row.characterId === s.returnTarget?.characterId,
        );
        if (!target)
          fail(
            "This formerly owned character is no longer available to return. No cost.",
          );
        db.prepare(
          "INSERT INTO marriages(guild_id,character_id,owner_id,married_at) VALUES(?,?,?,?)",
        ).run(
          guildId,
          target.characterId,
          actorId,
          new Date(now).toISOString(),
        );
        pay();
        return finish(db, action, {
          character: {
            id: target.characterId,
            name: target.name,
            rank: target.rank,
          },
          message: `Chronicle of Return married **${target.name}** to <@${actorId}> anew.`,
        });
      }
      if (action.kind === "threadbreaker") {
        const franchiseId = s.franchise?.id;
        if (!Number.isSafeInteger(franchiseId)) fail("Choose a franchise.");
        const chance = getItemRules(db, guildId, "threadbreaker").divorceChance;
        if (!Number.isFinite(chance) || chance < 0 || chance > 1)
          fail("Invalid Threadbreaker divorce chance.");
        const membership = characterFranchiseRelation(db);
        const rows = db
          .prepare(
            `SELECT DISTINCT m.id AS marriageId,m.character_id AS characterId,m.owner_id AS ownerId,c.rank,c.name_full AS name
          FROM ${membership} membership JOIN characters c ON c.id=membership.character_id
          JOIN marriages m ON m.guild_id=? AND m.character_id=c.id
          WHERE membership.franchise_id=? AND NOT EXISTS (
            SELECT 1 FROM character_protection_locks l WHERE l.guild_id=m.guild_id
            AND l.character_id=m.character_id AND (l.protected_until IS NULL
              OR (l.lock_type='soulbind' AND l.protected_until > ?)))
          ORDER BY c.rank DESC`,
          )
          .all(guildId, franchiseId, now);
        const visited = [];
        const divorced = [];
        for (let index = 0; index < rows.length; index++) {
          const current = rows[index];
          const sameOwner =
            index > 0 && current.ownerId === rows[index - 1].ownerId;
          const didDivorce = !sameOwner || random() < chance;
          const outcome = { ...current, divorced: didDivorce };
          visited.push(outcome);
          if (!didDivorce) break;
          divorced.push(current);
        }
        if (!divorced.length)
          return finish(db, action, {
            kind: "threadbreaker",
            franchise: s.franchise,
            divorceChance: chance,
            visited,
            noCost: true,
            message: "No characters were divorced. No cost.",
          });
        afterCommit = cancelSelectedCharacterInteractions(
          db,
          guildId,
          divorced,
          now,
          "Threadbreaker",
        );
        for (const target of divorced) divorce(db, guildId, target);
        pay();
        return finish(db, action, {
          kind: "threadbreaker",
          franchise: s.franchise,
          divorceChance: chance,
          visited,
          message: `Threadbreaker activated on ${s.franchise.name}.`,
        });
      }
      if (action.kind === "kaimetsu") {
        // Do not join the current catalog or look up guild members: archived and
        // departed owners' marriages count too. Active soulbinds remain immune.
        const rows = db
          .prepare(
            `SELECT m.id AS marriageId,m.character_id AS characterId,m.owner_id AS ownerId
          FROM marriages m WHERE m.guild_id=? AND NOT EXISTS (
            SELECT 1 FROM character_protection_locks l WHERE l.guild_id=m.guild_id
              AND l.character_id=m.character_id AND (l.protected_until IS NULL
                OR (l.lock_type='soulbind' AND l.protected_until > ?)))
          ORDER BY m.owner_id,m.id`,
          )
          .all(guildId, now);
        const pools = new Map();
        for (const row of rows) {
          if (!pools.has(row.ownerId)) pools.set(row.ownerId, []);
          pools.get(row.ownerId).push(row);
        }
        const selected = [];
        let affectedOwners = 0;
        for (const pool of pools.values()) {
          const count = Math.floor(pool.length / 2);
          if (count) affectedOwners++;
          // Partial Fisher-Yates: uniform sampling without replacement per owner.
          for (let i = 0; i < count; i++) {
            const j = i + randomIndex(pool.length - i, random);
            [pool[i], pool[j]] = [pool[j], pool[i]];
            selected.push(pool[i]);
          }
        }
        if (!selected.length)
          return finish(db, action, {
            kind: "kaimetsu",
            actorId,
            totalDivorced: 0,
            affectedOwners: 0,
            noCost: true,
            message: "Kaimetsu would divorce nobody. No cost.",
          });
        afterCommit = cancelSelectedCharacterInteractions(
          db,
          guildId,
          selected,
          now,
        );
        for (const row of selected) divorce(db, guildId, row);
        pay();
        return finish(db, action, {
          kind: "kaimetsu",
          actorId,
          totalDivorced: selected.length,
          affectedOwners,
          message: `⚫ <@${actorId}> used **Kaimetsu**. **${selected.length}** characters were divorced across **${affectedOwners}** owners in this guild.`,
        });
      }
      if (action.kind === "blood_pact") {
        const choices = s.sacrifices ?? [];
        const count = rules.bloodPactSacrificeCount;
        if (
          choices.length !== count ||
          new Set(choices.map((row) => row.characterId)).size !== count
        )
          fail(`Choose ${count} distinct sacrifices.`);
        for (const choice of choices) {
          const current = eligible(
            db,
            guildId,
            owned(db, guildId, choice),
            now,
          );
          if (current.ownerId !== actorId) fail("Select your own characters.");
        }
        const result = bloodPact.execute({
          db,
          guildId,
          userId: actorId,
          choices,
          sacrificeCount: count,
          now,
        });
        if (!result.success) fail(result.message);
        pay();
        return finish(db, action, {
          character: {
            id: result.character.id,
            name: result.character.name_full,
            rank: result.character.rank,
          },
          message: result.message,
        });
      }
      if (action.kind === "alchemist") {
        const ids = s.inventoryIds ?? [];
        if (
          ids.length !== rules.alchemistCost ||
          new Set(ids).size !== rules.alchemistCost
        )
          fail(
            `Choose ${rules.alchemistCost} distinct Common inventory entries.`,
          );
        const inv = getUsableInventory(db, guildId, actorId, now);
        const costs = ids.map((id) => inv.find((row) => row.id === id));
        if (
          costs.some(
            (row) =>
              !row ||
              row.id === source.id ||
              getItemDefinition(row.item_id)?.tier !== "common",
          )
        )
          fail("Selected costs changed.");
        const pools =
          s._rewardPools ??
          Object.fromEntries(
            ["rare", "epic", "legendary"].map((tier) => [
              tier,
              getRewardItemsInTier(db, guildId, tier),
            ]),
          );
        if (
          !Object.entries(rules.alchemistRewardWeights).some(
            ([tier, weight]) => weight > 0 && pools[tier]?.length,
          )
        )
          fail("No eligible Alchemist rewards. Nothing was consumed.");
        const tier = weightedTier(
          Object.fromEntries(
            Object.entries(rules.alchemistRewardWeights).filter(
              ([tier]) => pools[tier]?.length,
            ),
          ),
          random,
        );
        const pool = pools[tier];
        const reward = pool[randomIndex(pool.length, random)];
        for (const row of costs)
          if (!removeItemFromInventory(db, row.id)) fail("Cost unavailable.");
        pay();
        if (
          addItemToInventory(
            db,
            guildId,
            actorId,
            reward.id,
            reward.maxCharges ?? 1,
            { now },
          ).status !== "added"
        )
          fail("Inventory is full.");
        return finish(db, action, {
          rewardId: reward.id,
          message: `Alchemist created **${reward.name}**.`,
        });
      }
      const own =
        action.kind === "severed_fate"
          ? null
          : eligible(
              db,
              guildId,
              owned(db, guildId, s.own),
              now,
              action.kind === "counterfeit_crown",
            );
      if (own && own.ownerId !== actorId) fail("Select your own character.");
      if (action.kind === "counterfeit_crown") {
        setCounterfeitCrown(db, guildId, actorId, own);
        pay();
        return finish(db, action, {
          privateCharacter: own,
          message: "Counterfeit Crown is active. Its decoy is secret.",
        });
      }
      if (action.kind === "chaos_exchange") {
        const pool = db
          .prepare(
            `SELECT c.id,c.name_full AS name,c.rank FROM characters c WHERE c.rank BETWEEN ? AND ? AND c.id<>?
          AND NOT EXISTS(SELECT 1 FROM marriages m WHERE m.guild_id=? AND m.character_id=c.id)
          AND NOT EXISTS(SELECT 1 FROM item_character_reservations r WHERE r.guild_id=? AND r.character_id=c.id)
          AND NOT EXISTS(SELECT 1 FROM character_rolls r WHERE r.guild_id=? AND r.character_id=c.id AND (r.state='pending' OR (r.state='open' AND r.expires_at>?)))
          AND NOT EXISTS(SELECT 1 FROM mystery_sessions ms WHERE ms.guild_id=? AND ms.character_id=c.id AND ms.state IN ('reserved','running','countdown','claim_open')) ORDER BY c.id`,
          )
          .all(
            Math.ceil(own.rank * rules.chaosMinRankMultiplier),
            Math.floor(own.rank * rules.chaosMaxRankMultiplier),
            own.characterId,
            guildId,
            guildId,
            guildId,
            now,
            guildId,
          );
        if (!pool.length)
          fail("No replacement is available. Nothing was consumed.");
        const reward = pool[randomIndex(pool.length, random)];
        divorce(db, guildId, own);
        pay();
        db.prepare(
          "INSERT INTO marriages(guild_id,character_id,owner_id,married_at) VALUES(?,?,?,?)",
        ).run(guildId, reward.id, actorId, new Date(now).toISOString());
        return finish(db, action, {
          character: reward,
          message: `Chaos Exchange married **${reward.name}** to <@${actorId}>.`,
        });
      }
      const originals = (s.targets ?? []).map((choice) =>
        eligible(db, guildId, owned(db, guildId, choice), now),
      );
      const masquerade = action.kind === "grand_masquerade";
      if (
        originals.length !== (masquerade ? 3 : 1) ||
        new Set([actorId, ...originals.map((row) => row.ownerId)]).size !==
          originals.length + 1
      )
        fail("Choose distinct other owners.");
      if (action.kind === "heart_for_a_heart" && originals[0].rank <= own.rank)
        fail(
          "Target must have a strictly larger rank number than your sacrifice.",
        );
      if (
        masquerade &&
        originals.some(
          (row) =>
            !meetsRankInterval(
              own.rank,
              row.rank,
              rules.masqueradeMinRankMultiplier,
              rules.masqueradeTopRank,
            ),
        )
      )
        fail("A target is outside the permitted rank interval.");
      if (
        action.kind === "hostage_note" &&
        !meetsRankInterval(
          own.rank,
          originals[0].rank,
          HOSTAGE_MIN_RANK_MULTIPLIER,
          HOSTAGE_TOP_RANK,
        )
      ) {
        fail(
          `Choose a target ranked #${Math.ceil(HOSTAGE_MIN_RANK_MULTIPLIER * own.rank)} or with a larger rank number. Nothing was consumed.`,
        );
      }
      if (!masquerade) {
        const ownerId = originals[0].ownerId;
        if (
          resolveSoulmateNegation(db, {
            sourceKey: action.id,
            guildId,
            ownerId,
            now,
            random,
          }).triggered
        ) {
          pay();
          return finish(db, action, {
            blocked: true,
            blockedBy: "negation",
            message:
              "Soulmate Negation blocked the action. All characters and defenses remain unchanged.",
          });
        }
        const shield = getUsableInventory(db, guildId, ownerId, now).find(
          (row) => row.item_id === "mirror_shield",
        );
        if (shield) {
          const payment = spendAffectionItemChargeInTransaction(db, {
            sourceKey: action.id,
            guildId,
            userId: ownerId,
            inventoryId: shield.id,
            now,
            random,
          });
          pay();
          return finish(db, action, {
            blocked: true,
            blockedBy: "mirror_shield",
            message: `Mirror Shield ${payment.conserved ? "blocked the action; its charge was conserved" : "shattered"}. All characters remain owned.`,
          });
        }
      }
      const redirected = originals.map((row) =>
        redirectWithCrown(db, guildId, row, now),
      );
      const targets = redirected.map(({ target }) =>
        eligible(db, guildId, target, now),
      );
      const redirects = redirected
        .map(({ target, crown }, i) =>
          crown ? `Crown: **${originals[i].name}** → **${target.name}**.` : "",
        )
        .filter(Boolean)
        .join("\n");
      if (action.kind === "hostage_note") {
        for (const row of [own, targets[0]])
          db.prepare(
            "INSERT INTO item_character_reservations VALUES(?,?,?,?,?)",
          ).run(
            guildId,
            row.characterId,
            action.id,
            row.ownerId,
            row.marriageId,
          );
        const effective = { ...s, own, targets, originals };
        if (hasItemAffection(db))
          effective._affectionItemUse = captureAffectionItemUseInTransaction(
            db,
            {
              sourceKey: action.id,
              guildId,
              userId: actorId,
              chance,
              now,
              random,
            },
          );
        db.prepare(
          "UPDATE item_actions SET state='awaiting_delivery',selections_json=?,crown_json=? WHERE id=?",
        ).run(
          JSON.stringify(effective),
          JSON.stringify(redirected.map((row) => row.crown).filter(Boolean)),
          action.id,
        );
        return {
          status: "awaiting_delivery",
          action: getItemAction(db, action.id),
        };
      }
      pay();
      if (action.kind === "heart_for_a_heart") divorce(db, guildId, own);
      if (
        action.kind === "heart_for_a_heart" ||
        action.kind === "severed_fate"
      ) {
        divorce(db, guildId, targets[0]);
        return finish(db, action, {
          originals,
          targets,
          message: `${redirects ? `${redirects}\n` : ""}Forced divorce: **${targets[0].name}**${action.kind === "heart_for_a_heart" ? ` and **${own.name}**` : ""}. Nobody receives them automatically.`,
        });
      }
      if (masquerade) {
        const pool = [own, ...targets];
        const permutations = [];
        function visit(prefix) {
          if (prefix.length === pool.length) {
            permutations.push(prefix);
            return;
          }
          for (let i = 0; i < pool.length; i++)
            if (i !== prefix.length && !prefix.includes(i))
              visit([...prefix, i]);
        }
        visit([]);
        const assignment =
          permutations[randomIndex(permutations.length, random)];
        pool.forEach((row, i) =>
          transfer(db, guildId, row, pool[assignment[i]].ownerId, now),
        );
        return finish(db, action, {
          originals: [own, ...originals],
          targets: pool,
          assignment,
          message:
            `${redirects ? `${redirects}\n` : ""}Grand Masquerade:\n` +
            pool
              .map(
                (row, i) =>
                  `**${row.name}** → <@${pool[assignment[i]].ownerId}>`,
              )
              .join("\n"),
        });
      }
      fail("Unknown action.");
    });
    afterCommit?.();
    return result;
  } catch (error) {
    if (!(error instanceof ActionRefusal)) throw error;
    // The failed activation has rolled back all costs and defenses. Persist a
    // terminal refusal separately so a stale prompt cannot become valid later.
    // SQL/COMMIT errors must propagate without canceling a retryable action.
    transaction(db, () => {
      const action = getItemAction(db, actionId);
      if (
        action?.state === "confirming" &&
        action.guild_id === guildId &&
        action.actor_id === actorId
      ) {
        finish(
          db,
          action,
          { noCost: true, message: error.message },
          "canceled",
        );
      }
    });
    return { status: "invalid", message: error.message };
  }
}

export function cancelItemAction(db, actionId, guildId, actorId) {
  return transaction(db, () => {
    const action = getItemAction(db, actionId);
    if (
      !action ||
      action.guild_id !== guildId ||
      action.actor_id !== actorId ||
      action.state !== "confirming"
    )
      return false;
    finish(db, action, { message: "Canceled. No cost." }, "canceled");
    return true;
  });
}

export function confirmHostageDelivery(
  db,
  actionId,
  messageId,
  now = Date.now(),
) {
  return transaction(db, () => {
    const action = getItemAction(db, actionId);
    if (action?.state !== "awaiting_delivery") return false;
    const payment = consumeItemActionSource(db, action);
    const selections = { ...action.selections };
    if (hasItemAffection(db)) selections._affectionPayment = payment;
    db.prepare(
      "UPDATE item_actions SET state='active',message_id=?,deadline_at=?,selections_json=? WHERE id=?",
    ).run(
      messageId,
      now +
        (action.selections._rules ?? getItemActionConfig(db, action.guild_id))
          .hostageDecisionMs,
      JSON.stringify(selections),
      actionId,
    );
    return true;
  });
}

export function cancelUndeliveredHostage(db, actionId) {
  return transaction(db, () => {
    const action = getItemAction(db, actionId);
    if (action?.state !== "awaiting_delivery") return false;
    db.prepare("DELETE FROM item_character_reservations WHERE action_id=?").run(
      actionId,
    );
    releaseItemActionSource(db, actionId);
    for (const crown of JSON.parse(action.crown_json ?? "[]")) {
      const row = db
        .prepare(
          "SELECT id,owner_id FROM marriages WHERE guild_id=? AND character_id=?",
        )
        .get(action.guild_id, crown.character_id);
      if (
        row?.id === crown.marriage_id &&
        row.owner_id === crown.user_id &&
        !isCharacterLocked(db, action.guild_id, crown.character_id).locked
      )
        db.prepare(
          "INSERT OR IGNORE INTO counterfeit_crowns VALUES(?,?,?,?,?)",
        ).run(
          crown.guild_id,
          crown.user_id,
          crown.character_id,
          crown.marriage_id,
          crown.generation_id,
        );
    }
    finish(
      db,
      action,
      {
        actualDebit: 0,
        message: "Hostage prompt was not delivered. Note restored.",
      },
      "canceled",
    );
    return true;
  });
}

export function resolveHostage(
  db,
  {
    actionId,
    guildId,
    userId,
    choice,
    now = Date.now(),
    random = Math.random,
    timeout = false,
  },
) {
  try {
    return withOwnershipOperationClock(db, now, () => {
      const action = getItemAction(db, actionId);
      if (!action || action.guild_id !== guildId) fail("Unknown challenge.");
      const target = action.selections.targets?.[0];
      if (!target || (!timeout && target.ownerId !== userId))
        fail("Only the target may choose.");
      if (action.state !== "active")
        return action.result ?? { status: action.state };
      if (timeout && now < action.deadline_at)
        fail("Challenge has not expired.");
      if (now >= action.deadline_at) choice = "gamble";
      if (!["exchange", "gamble"].includes(choice)) fail("Invalid choice.");
      const own = owned(db, guildId, action.selections.own);
      const victim = owned(db, guildId, target);
      let loser = null;
      if (choice === "exchange") {
        transfer(db, guildId, own, victim.ownerId, now);
        transfer(db, guildId, victim, own.ownerId, now);
      } else if (
        random() <
        (action.selections._rules ?? getItemActionConfig(db, guildId))
          .hostageDivorceChance
      ) {
        loser = victim;
        divorce(db, guildId, loser);
      }
      db.prepare(
        "DELETE FROM item_character_reservations WHERE action_id=?",
      ).run(action.id);
      return finish(db, action, {
        choice,
        message:
          choice === "exchange"
            ? `Hostage exchange: **${own.name}** and **${victim.name}** swapped owners.`
            : loser
              ? `Hostage Gamble: **${victim.name}** was divorced. The item user's character remains owned.`
              : `Hostage Gamble: **${victim.name}** escaped divorce. Both characters remain with their owners.`,
        loser,
        characters: [own, victim],
      });
    });
  } catch (error) {
    if (error instanceof ActionRefusal)
      return { status: "invalid", message: error.message };
    throw error;
  }
}

export function recoverItemActions(db, now = Date.now(), random = Math.random) {
  for (const row of db
    .prepare(
      `SELECT id FROM ${currentSeasonRows(db, "item_actions")} WHERE state='awaiting_delivery'`,
    )
    .all())
    cancelUndeliveredHostage(db, row.id);
  for (const row of db
    .prepare(
      `SELECT id,guild_id FROM ${currentSeasonRows(db, "item_actions")} WHERE state='active' AND deadline_at<=?`,
    )
    .all(now))
    resolveHostage(db, {
      actionId: row.id,
      guildId: row.guild_id,
      choice: "gamble",
      timeout: true,
      now,
      random,
    });
  expireItemActions(db, now);
}

/** Shared by startup and the bounded runtime sweep; release holds atomically. */
export function expireItemActions(db, now = Date.now(), limit = 100) {
  return transaction(db, () => {
    const actions = db
      .prepare(
        `SELECT id FROM ${currentSeasonRows(db, "item_actions")} WHERE state='confirming' AND expires_at<=? LIMIT ?`,
      )
      .all(now, limit);
    for (const { id } of actions)
      finish(
        db,
        getItemAction(db, id),
        { message: "Confirmation expired. No cost." },
        "expired",
      );
    return actions.length;
  });
}
