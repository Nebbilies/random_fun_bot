import { randomUUID } from 'node:crypto';
import { bloodPact } from './items/bloodPact.js';
import { getItemRules } from './itemRuntimeConfig.js';
import { requireNewGameAction } from './catalogMaintenance.js';
import { cancelSelectedCharacterInteractions } from './characterInteractionCancellation.js';
import { isCharacterBusy } from './characterAvailability.js';
import { redirectWithCrown } from './itemDefense.js';
export { redirectWithCrown } from './itemDefense.js';
import { transaction } from './catalogDb.js';
import { getItemDefinition, getRewardItemsInTier } from './itemRoster.js';
import { getInventory, getUsableInventory, removeItemFromInventory, addItemToInventory, decrementItemCharge, isCharacterLocked } from './itemStorage.js';
import { getItemAction, setCounterfeitCrown } from './itemActionStorage.js';
import { getItemActionConfig, randomIndex, weightedTier } from './itemActionConfig.js';

export const ACTION_ITEMS = new Set(['blood_pact', 'alchemist', 'chaos_exchange', 'counterfeit_crown', 'heart_for_a_heart', 'hostage_note', 'severed_fate', 'grand_masquerade', 'kaimetsu']);
const fail = (message) => { throw new ActionRefusal(message); };
class ActionRefusal extends Error {}

export function createItemAction(db, { guildId, actorId, channelId, inventoryId, selections = {}, now = Date.now() }) {
  requireNewGameAction(db);
  const item = getUsableInventory(db, guildId, actorId).find((row) => row.id === inventoryId);
  if (!item || !ACTION_ITEMS.has(item.item_id)) return { status: 'invalid', message: 'This item is unavailable.' };
  const id = randomUUID();
  const rules = getItemActionConfig(db, guildId);
  if (item.item_id === 'blood_pact') rules.bloodPactSacrificeCount = getItemRules(db, guildId, 'blood_pact').sacrificeCount;
  selections = { ...selections, _rules: rules,
    _rewardPools: Object.fromEntries(['rare', 'epic', 'legendary'].map(tier => [tier, getRewardItemsInTier(db, guildId, tier)])) };
  db.prepare(`INSERT INTO item_actions(id,kind,guild_id,actor_id,channel_id,inventory_id,state,selections_json,created_at,expires_at)
    VALUES(?,?,?,?,?,?,'confirming',?,?,?)`).run(id, item.item_id, guildId, actorId, channelId, inventoryId, JSON.stringify(selections), now, now + (item.item_id === 'grand_masquerade' ? rules.masqueradeConfirmationMs : rules.confirmationMs));
  return getItemAction(db, id);
}

export function updateItemSelection(db, id, guildId, actorId, selections, now = Date.now()) {
  const action = getItemAction(db, id);
  if (!action || action.state !== 'confirming' || action.guild_id !== guildId || action.actor_id !== actorId || now >= action.expires_at) return false;
  db.prepare('UPDATE item_actions SET selections_json=? WHERE id=?').run(JSON.stringify({ ...selections, _rules: action.selections._rules, _rewardPools: action.selections._rewardPools }), id);
  return true;
}

function owned(db, guildId, choice) {
  if (!choice?.characterId || !choice.ownerId || !choice.marriageId) fail('Select a current owned character.');
  const row = db.prepare(`SELECT m.id AS marriageId,m.character_id AS characterId,m.owner_id AS ownerId,c.rank,c.name_full AS name
    FROM marriages m JOIN characters c ON c.id=m.character_id WHERE m.guild_id=? AND m.character_id=?`).get(guildId, choice.characterId);
  if (!row || row.ownerId !== choice.ownerId || row.marriageId !== choice.marriageId) fail('Ownership changed. Nothing was consumed.');
  return row;
}

function busy(db, guild, id, now) {
  return isCharacterBusy(db, guild, id, now);
}
function eligible(db, guild, row, now, unprotected = false) {
  const lock = isCharacterLocked(db, guild, row.characterId, now);
  if (lock.permanent || (unprotected && lock.locked) || busy(db, guild, row.characterId, now)) fail('Character is protected or committed to another action.');
  return row;
}
function loseCrown(db, guild, id) { db.prepare('DELETE FROM counterfeit_crowns WHERE guild_id=? AND character_id=?').run(guild, id); }
function divorce(db, guild, row) {
  loseCrown(db, guild, row.characterId);
  const change = db.prepare('DELETE FROM marriages WHERE guild_id=? AND character_id=? AND owner_id=? AND id=?').run(guild, row.characterId, row.ownerId, row.marriageId);
  if (change.changes !== 1) fail('Ownership changed.');
}
function transfer(db, guild, row, owner, now) {
  loseCrown(db, guild, row.characterId);
  if (db.prepare('UPDATE marriages SET owner_id=?,married_at=? WHERE guild_id=? AND character_id=? AND owner_id=? AND id=?')
    .run(owner, new Date(now).toISOString(), guild, row.characterId, row.ownerId, row.marriageId).changes !== 1) fail('Ownership changed.');
}
function finish(db, action, result, state = 'resolved') {
  const outcome = { status: state, ...result };
  db.prepare('UPDATE item_actions SET state=?,result_json=?,delivery_pending=1 WHERE id=?').run(state, JSON.stringify(outcome), action.id);
  return outcome;
}


export function activateItemAction(db, { actionId, guildId, actorId, now = Date.now(), random = Math.random }) {
  // Never cancel memory-only sessions inside the transaction: a later SQL or
  // COMMIT failure must leave them live. No await may separate commit and cleanup.
  let afterCommit = null;
  try {
    const result = transaction(db, () => {
      const action = getItemAction(db, actionId);
      if (!action || action.guild_id !== guildId || action.actor_id !== actorId) fail('This action is not yours.');
      if (action.state !== 'confirming') return action.result ?? { status: action.state };
      if (now >= action.expires_at) return finish(db, action, { message: 'Confirmation expired. No cost.' }, 'expired');
      const source = getUsableInventory(db, guildId, actorId).find((row) => row.id === action.inventory_id && row.item_id === action.kind);
      if (!source) fail('Item is no longer available.');
      const s = action.selections;
      const rules = s._rules ?? getItemActionConfig(db, guildId);
      if (action.kind === 'kaimetsu') {
        // Do not join the current catalog or look up guild members: archived and
        // departed owners' marriages count too. Only permanent locks are immune.
        const rows = db.prepare(`SELECT m.id AS marriageId,m.character_id AS characterId,m.owner_id AS ownerId
          FROM marriages m WHERE m.guild_id=? AND NOT EXISTS (
            SELECT 1 FROM character_protection_locks l WHERE l.guild_id=m.guild_id
              AND l.character_id=m.character_id AND l.protected_until IS NULL)
          ORDER BY m.owner_id,m.id`).all(guildId);
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
        if (!selected.length) return finish(db, action, { kind: 'kaimetsu', actorId, totalDivorced: 0,
          affectedOwners: 0, noCost: true, message: 'Kaimetsu would divorce nobody. No cost.' });
        afterCommit = cancelSelectedCharacterInteractions(db, guildId, selected, now);
        for (const row of selected) divorce(db, guildId, row);
        decrementItemCharge(db, source.id);
        return finish(db, action, { kind: 'kaimetsu', actorId, totalDivorced: selected.length,
          affectedOwners, message: `⚫ <@${actorId}> used **Kaimetsu**. **${selected.length}** characters were divorced across **${affectedOwners}** owners in this guild.` });
      }
      if (action.kind === 'blood_pact') {
        const choices = s.sacrifices ?? [];
        const count = rules.bloodPactSacrificeCount;
        if (choices.length !== count || new Set(choices.map((row) => row.characterId)).size !== count) fail(`Choose ${count} distinct sacrifices.`);
        for (const choice of choices) {
          const current = eligible(db, guildId, owned(db, guildId, choice), now);
          if (current.ownerId !== actorId) fail('Select your own characters.');
        }
        const result = bloodPact.execute({ db, guildId, userId: actorId, choices, sacrificeCount: count, now });
        if (!result.success) fail(result.message);
        decrementItemCharge(db, source.id);
        return finish(db, action, { character: { id: result.character.id, name: result.character.name_full, rank: result.character.rank }, message: result.message });
      }
      if (action.kind === 'alchemist') {
        const ids = s.inventoryIds ?? [];
        if (ids.length !== rules.alchemistCost || new Set(ids).size !== rules.alchemistCost) fail(`Choose ${rules.alchemistCost} distinct Common inventory entries.`);
        const inv = getUsableInventory(db, guildId, actorId);
        const costs = ids.map((id) => inv.find((row) => row.id === id));
        if (costs.some((row) => !row || row.id === source.id || getItemDefinition(row.item_id)?.tier !== 'common')) fail('Selected costs changed.');
        const pools = s._rewardPools ?? Object.fromEntries(['rare', 'epic', 'legendary'].map(tier => [tier, getRewardItemsInTier(db, guildId, tier)]));
        if (!Object.entries(rules.alchemistRewardWeights).some(([tier, weight]) => weight > 0 && pools[tier]?.length)) fail('No eligible Alchemist rewards. Nothing was consumed.');
        const tier = weightedTier(Object.fromEntries(Object.entries(rules.alchemistRewardWeights).filter(([tier]) => pools[tier]?.length)), random);
        const pool = pools[tier]; const reward = pool[randomIndex(pool.length, random)];
        for (const row of costs) if (!removeItemFromInventory(db, row.id)) fail('Cost unavailable.');
        decrementItemCharge(db, source.id);
        if (addItemToInventory(db, guildId, actorId, reward.id, reward.maxCharges ?? 1).status !== 'added') fail('Inventory is full.');
        return finish(db, action, { rewardId: reward.id, message: `Alchemist created **${reward.name}**.` });
      }
      const own = action.kind === 'severed_fate' ? null : eligible(db, guildId, owned(db, guildId, s.own), now, action.kind === 'counterfeit_crown');
      if (own && own.ownerId !== actorId) fail('Select your own character.');
      if (action.kind === 'counterfeit_crown') {
        setCounterfeitCrown(db, guildId, actorId, own); decrementItemCharge(db, source.id);
        return finish(db, action, { privateCharacter: own, message: 'Counterfeit Crown is active. Its decoy is secret.' });
      }
      if (action.kind === 'chaos_exchange') {
        const pool = db.prepare(`SELECT c.id,c.name_full AS name,c.rank FROM characters c WHERE c.rank BETWEEN ? AND ? AND c.id<>?
          AND NOT EXISTS(SELECT 1 FROM marriages m WHERE m.guild_id=? AND m.character_id=c.id)
          AND NOT EXISTS(SELECT 1 FROM item_character_reservations r WHERE r.guild_id=? AND r.character_id=c.id)
          AND NOT EXISTS(SELECT 1 FROM character_rolls r WHERE r.guild_id=? AND r.character_id=c.id AND (r.state='pending' OR (r.state='open' AND r.expires_at>?)))
          AND NOT EXISTS(SELECT 1 FROM mystery_sessions ms WHERE ms.guild_id=? AND ms.character_id=c.id AND ms.state IN ('reserved','running','countdown','claim_open')) ORDER BY c.id`)
          .all(Math.ceil(own.rank * rules.chaosMinRankMultiplier), Math.floor(own.rank * rules.chaosMaxRankMultiplier), own.characterId, guildId, guildId, guildId, now, guildId);
        if (!pool.length) fail('No replacement is available. Nothing was consumed.');
        const reward = pool[randomIndex(pool.length, random)];
        divorce(db, guildId, own); decrementItemCharge(db, source.id);
        db.prepare('INSERT INTO marriages(guild_id,character_id,owner_id,married_at) VALUES(?,?,?,?)').run(guildId, reward.id, actorId, new Date(now).toISOString());
        return finish(db, action, { character: reward, message: `Chaos Exchange married **${reward.name}** to <@${actorId}>.` });
      }
      const originals = (s.targets ?? []).map((choice) => eligible(db, guildId, owned(db, guildId, choice), now));
      const masquerade = action.kind === 'grand_masquerade';
      if (originals.length !== (masquerade ? 3 : 1) || new Set([actorId, ...originals.map((row) => row.ownerId)]).size !== originals.length + 1) fail('Choose distinct other owners.');
      if (action.kind === 'heart_for_a_heart' && originals[0].rank <= own.rank) fail('Target must have a strictly larger rank number than your sacrifice.');
      if (masquerade && originals.some((row) => !(row.rank >= Math.ceil(rules.masqueradeMinRankMultiplier * own.rank) || (own.rank <= rules.masqueradeTopRank && row.rank <= rules.masqueradeTopRank)))) fail('A target is outside the permitted rank interval.');
      if (!masquerade) {
        const shield = getUsableInventory(db, guildId, originals[0].ownerId).find((row) => row.item_id === 'mirror_shield');
        if (shield) { decrementItemCharge(db, shield.id); decrementItemCharge(db, source.id); return finish(db, action, { blocked: true, message: 'Mirror Shield shattered. All characters remain owned.' }); }
      }
      const redirected = originals.map((row) => redirectWithCrown(db, guildId, row, now));
      const targets = redirected.map(({ target }) => eligible(db, guildId, target, now));
      const redirects = redirected.map(({ target, crown }, i) => crown ? `Crown: **${originals[i].name}** → **${target.name}**.` : '').filter(Boolean).join('\n');
      if (action.kind === 'hostage_note') {
        for (const row of [own, targets[0]]) db.prepare('INSERT INTO item_character_reservations VALUES(?,?,?,?,?)').run(guildId, row.characterId, action.id, row.ownerId, row.marriageId);
        db.prepare('INSERT INTO item_action_costs VALUES(?,?,?)').run(action.id, source.id, JSON.stringify(source));
        const effective = { ...s, own, targets, originals };
        db.prepare("UPDATE item_actions SET state='awaiting_delivery',selections_json=?,crown_json=? WHERE id=?")
          .run(JSON.stringify(effective), JSON.stringify(redirected.map((row) => row.crown).filter(Boolean)), action.id);
        return { status: 'awaiting_delivery', action: getItemAction(db, action.id) };
      }
      decrementItemCharge(db, source.id);
      if (action.kind === 'heart_for_a_heart') divorce(db, guildId, own);
      if (action.kind === 'heart_for_a_heart' || action.kind === 'severed_fate') {
        divorce(db, guildId, targets[0]);
        return finish(db, action, { originals, targets, message: `${redirects ? `${redirects}\n` : ''}Forced divorce: **${targets[0].name}**${action.kind === 'heart_for_a_heart' ? ` and **${own.name}**` : ''}. Nobody receives them automatically.` });
      }
      if (masquerade) {
        const pool = [own, ...targets];
        const permutations = [];
        function visit(prefix) { if (prefix.length === pool.length) { permutations.push(prefix); return; } for (let i = 0; i < pool.length; i++) if (i !== prefix.length && !prefix.includes(i)) visit([...prefix, i]); }
        visit([]); const assignment = permutations[randomIndex(permutations.length, random)];
        pool.forEach((row, i) => transfer(db, guildId, row, pool[assignment[i]].ownerId, now));
        return finish(db, action, { originals: [own, ...originals], targets: pool, assignment, message: `${redirects ? `${redirects}\n` : ''}Grand Masquerade:\n` + pool.map((row, i) => `**${row.name}** → <@${pool[assignment[i]].ownerId}>`).join('\n') });
      }
      fail('Unknown action.');
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
      if (action?.state === 'confirming' && action.guild_id === guildId && action.actor_id === actorId) {
        finish(db, action, { noCost: true, message: error.message }, 'canceled');
      }
    });
    return { status: 'invalid', message: error.message };
  }
}

export function cancelItemAction(db, actionId, guildId, actorId) {
  const action = getItemAction(db, actionId);
  if (!action || action.guild_id !== guildId || action.actor_id !== actorId || action.state !== 'confirming') return false;
  finish(db, action, { message: 'Canceled. No cost.' }, 'canceled'); return true;
}

export function confirmHostageDelivery(db, actionId, messageId, now = Date.now()) {
  return transaction(db, () => {
    const action = getItemAction(db, actionId);
    if (action?.state !== 'awaiting_delivery') return false;
    db.prepare('DELETE FROM item_action_costs WHERE action_id=?').run(actionId);
    if (!db.prepare('SELECT 1 FROM user_inventory WHERE id=?').get(action.inventory_id)) fail('Escrowed Note disappeared.');
    decrementItemCharge(db, action.inventory_id);
    db.prepare("UPDATE item_actions SET state='active',message_id=?,deadline_at=? WHERE id=?").run(messageId, now + (action.selections._rules ?? getItemActionConfig(db, action.guild_id)).hostageDecisionMs, actionId);
    return true;
  });
}

export function cancelUndeliveredHostage(db, actionId) {
  return transaction(db, () => {
    const action = getItemAction(db, actionId);
    if (action?.state !== 'awaiting_delivery') return false;
    db.prepare('DELETE FROM item_character_reservations WHERE action_id=?').run(actionId);
    db.prepare('DELETE FROM item_action_costs WHERE action_id=?').run(actionId);
    for (const crown of JSON.parse(action.crown_json ?? '[]')) {
      const row = db.prepare('SELECT id,owner_id FROM marriages WHERE guild_id=? AND character_id=?').get(action.guild_id, crown.character_id);
      if (row?.id === crown.marriage_id && row.owner_id === crown.user_id && !isCharacterLocked(db, action.guild_id, crown.character_id).locked)
        db.prepare('INSERT OR IGNORE INTO counterfeit_crowns VALUES(?,?,?,?,?)').run(crown.guild_id, crown.user_id, crown.character_id, crown.marriage_id, crown.generation_id);
    }
    finish(db, action, { message: 'Hostage prompt was not delivered. Note restored.' }, 'canceled'); return true;
  });
}

export function resolveHostage(db, { actionId, guildId, userId, choice, now = Date.now(), random = Math.random, timeout = false }) {
  try { return transaction(db, () => {
    const action = getItemAction(db, actionId);
    if (!action || action.guild_id !== guildId) fail('Unknown challenge.');
    const target = action.selections.targets?.[0];
    if (!target || (!timeout && target.ownerId !== userId)) fail('Only the target may choose.');
    if (action.state !== 'active') return action.result ?? { status: action.state };
    if (timeout && now < action.deadline_at) fail('Challenge has not expired.');
    if (now >= action.deadline_at) choice = 'gamble';
    if (!['exchange', 'gamble'].includes(choice)) fail('Invalid choice.');
    const own = owned(db, guildId, action.selections.own); const victim = owned(db, guildId, target);
    let loser = null;
    if (choice === 'exchange') { transfer(db, guildId, own, victim.ownerId, now); transfer(db, guildId, victim, own.ownerId, now); }
    else { loser = random() < (action.selections._rules ?? getItemActionConfig(db, guildId)).hostageDivorceChance ? own : victim; divorce(db, guildId, loser); }
    db.prepare('DELETE FROM item_character_reservations WHERE action_id=?').run(action.id);
    return finish(db, action, { choice, message: choice === 'exchange' ? `Hostage exchange: **${own.name}** and **${victim.name}** swapped owners.` : `Hostage Gamble: **${loser.name}** was divorced. The other stake remains owned.`, loser, characters: [own, victim] });
  }); } catch (error) { if (error instanceof ActionRefusal) return { status: 'invalid', message: error.message }; throw error; }
}

export function recoverItemActions(db, now = Date.now(), random = Math.random) {
  for (const row of db.prepare("SELECT id FROM item_actions WHERE state='awaiting_delivery'").all()) cancelUndeliveredHostage(db, row.id);
  for (const row of db.prepare("SELECT id,guild_id FROM item_actions WHERE state='active' AND deadline_at<=?").all(now)) resolveHostage(db, { actionId: row.id, guildId: row.guild_id, choice: 'gamble', timeout: true, now, random });
  db.prepare("UPDATE item_actions SET state='expired' WHERE state='confirming' AND expires_at<=?").run(now);
}
