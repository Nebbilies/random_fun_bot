import { withOwnershipOperationClock } from './characterOwnershipHistory.js';
import { hasAffection, getAffectionBenefits, captureAppearanceInTransaction, completeAppearanceInTransaction, cancelAppearanceInTransaction, earnReclaimInTransaction } from './characterAffection.js';
import { resolveAffectionDecisionInTransaction } from './affectionPerks.js';
import { resolveSoulmateNegation } from './itemDefense.js';
import { spendAffectionItemChargeInTransaction } from './affectionItemUse.js';
import { getResolvedItemDefinitions } from './itemRoster.js';

export function getRollAffectionFeedback(db, rollId) {
  if (!hasAffection(db)) return [];
  const roll = db.prepare('SELECT rules_json FROM character_rolls WHERE id=?').get(rollId);
  const terms = roll?.rules_json ? JSON.parse(roll.rules_json) : {};
  if (!terms.affectionSourceKey) return [];
  return db.prepare(`SELECT a.user_id userId,a.character_id characterId,a.amount,a.total,a.milestones_json milestonesJson,
    COALESCE(c.name_full,i.name_full,'Character') name FROM affection_awards a
    JOIN character_identities i ON i.id=a.character_id LEFT JOIN characters c ON c.id=a.character_id WHERE a.source_key=? ORDER BY a.rowid`)
    .all(terms.affectionSourceKey).map(row=>({...row,milestones:JSON.parse(row.milestonesJson)}));
}
import { resolveMysteryConsolation, inspectMysteryConsolation } from './mysteryConsolation.js';
import { hydrateCharacterFranchises } from './characterSeries.js';
import { getGameConfig } from './gameConfig.js';
import { captureRollDelivery } from './rollDelivery.js';
import { hasVaultSessions, reservePaidVaultSession } from './vaultSessions.js';
import { requireNewGameAction } from './catalogMaintenance.js';
import { captureCharacterSnapshot, characterSnapshotFromState, retainCharacterSnapshot, validateCharacterSnapshot } from './characterSnapshot.js';
import { transaction } from './catalogDb.js';
import { inspectLegacyVaultAbandonment } from './legacyVaultAbandonment.js';
import { characterLikesProjection } from './characterLikesProjection.js';
import { characterFranchiseRelation } from './characterFranchises.js';
import { isCharacterBusy, isCharacterPendingTransfer, isCharacterReserved } from './characterAvailability.js';
import { divorceCharacter, getMarriage, marryCharacter } from './characterMarriage.js';
import { passesMysteryGate } from './mysteryOdds.js';
import { passesVaultGate } from './vaultRolls.js';
import { getGuildRates } from './guildRates.js';
import { getUsableInventory, getActiveBuffs, getGuildBuffs, consumeBuffRoll } from './itemStorage.js';

const HOUR = 3_600_000;
const CLAIM_PERIOD = 3 * HOUR;
const VIETNAM_OFFSET = 7 * HOUR;
const DAY = 24 * HOUR;
const DEFAULT_MAX_ROLLS = 7;
const WINDOW = 60_000;
const REPORT_LIFETIME = HOUR;
const ACTIVE_MYSTERY = "('reserved', 'running', 'countdown', 'claim_open')";

// Inspect each time: explicit schema upgrades may occur on the same connection.
function hasRollCharacterSnapshot(db) {
  return db.prepare('PRAGMA table_info(character_rolls)').all()
    .some((column) => column.name === 'character_snapshot_json');
}

/** Load durable published terms, or null for a legacy roll without stored terms.
 * Mystery state is optional, but any present snapshot must validate and agree.
 */
export function loadRollCharacterSnapshot(db, rollId) {
  if (!Number.isSafeInteger(rollId) || rollId <= 0) return null;
  const roll = db.prepare(`SELECT character_id AS characterId, character_name AS characterName,
    mystery_session_id AS mysterySessionId,
    ${hasRollCharacterSnapshot(db) ? 'character_snapshot_json' : 'NULL'} AS snapshotJson
    FROM character_rolls WHERE id = ?`).get(rollId);
  if (!roll) return null;
  const snapshot = roll.snapshotJson === null ? null
    : validateCharacterSnapshot(JSON.parse(roll.snapshotJson), roll.characterId);
  if (snapshot && snapshot.name_full !== roll.characterName) {
    throw new Error('Invalid roll character snapshot: name mismatch');
  }
  let mysterySnapshot = null;
  if (roll.mysterySessionId) {
    const session = getMysterySession(db, roll.mysterySessionId);
    if (!session || session.characterId !== roll.characterId || session.originRollId !== rollId) {
      throw new Error('Mystery origin roll identity mismatch');
    }
    mysterySnapshot = characterSnapshotFromState(JSON.parse(session.stateJson || 'null'),
      session.characterId, session.rankSnapshot);
    if (mysterySnapshot && mysterySnapshot.name_full !== roll.characterName) {
      throw new Error('Invalid mystery character snapshot: origin roll name mismatch');
    }
    if (snapshot && mysterySnapshot && Object.keys(snapshot)
      .some((key) => snapshot[key] !== mysterySnapshot[key])) {
      throw new Error('Invalid roll character snapshot: mystery snapshot mismatch');
    }
  }
  return snapshot ?? mysterySnapshot;
}

function schedule(db, guildId) { return getGameConfig(db, guildId).schedules; }
function bucket(now, interval, offsetMinutes) { return Math.floor((now + offsetMinutes * 60_000) / interval); }
function resetAt(now, interval, offsetMinutes) { return (bucket(now, interval, offsetMinutes) + 1) * interval - offsetMinutes * 60_000; }
function rollPeriod(db, guildId, now) { const s = schedule(db, guildId); return Math.floor((now + (s.timezoneOffsetMinutes * 60_000) % s.rollIntervalMs) / s.rollIntervalMs); }
function claimPeriod(db, guildId, now) { const s = schedule(db, guildId); return bucket(now, s.claimIntervalMs, s.timezoneOffsetMinutes); }
function buffRules(buff) { try { return JSON.parse(buff?.data_json ?? '{}') ?? {}; } catch { return {}; } }

/** @param {any} [db] @param {string | null} [guildId] */
export function nextRollReset(now, db = null, guildId = null) {
  const s = schedule(db, guildId);
  return resetAt(now, s.rollIntervalMs, s.timezoneOffsetMinutes);
}
/** @param {any} [db] @param {string | null} [guildId] */
export function nextClaimReset(now, db = null, guildId = null) {
  const s = schedule(db, guildId);
  return resetAt(now, s.claimIntervalMs, s.timezoneOffsetMinutes);
}
export function getMaxRolls(db, guildId) { return getGameConfig(db, guildId).rolls.maxRolls; }

export function setMaxRolls(db, guildId, amount) {
  if (!validId(guildId) || !Number.isSafeInteger(amount) || amount < 1) {
    throw new Error('Invalid roll maximum');
  }
  db.prepare(`INSERT INTO guild_roll_limits (guild_id, max_rolls) VALUES (?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET max_rolls = excluded.max_rolls`).run(guildId, amount);
}

export function getRollStatus(db, guildId, userId, now = Date.now()) {
  if (![guildId, userId].every(validId) || !validNow(now)) throw new Error('Invalid roll status');
  const period = rollPeriod(db, guildId, now);
  const allowance = db.prepare('SELECT period, used FROM roll_allowances WHERE guild_id = ? AND user_id = ?')
    .get(guildId, userId);
  const used = allowance?.period === period ? allowance.used : 0;
  const capacity = rollCapacity(db, guildId, userId, now);
  return { remaining: Math.max(0, capacity - used), resetAt: nextRollReset(now, db, guildId) };
}

/** Adrenaline Rush doubles the hourly allowance while its buff is live. */
function rollCapacity(db, guildId, userId, now) {
  const base = getMaxRolls(db, guildId);
  const buff = getActiveBuffs(db, guildId, userId, now).find((entry) => entry.buff_id === 'adrenaline_rush');
  const bonus = hasAffection(db) ? getAffectionBenefits(db, guildId, userId).rollBonus : 0;
  return (buff ? Math.floor(base * (buffRules(buff).allowanceMultiplier ?? 2)) : base) + bonus;
}

export function addGlobalRolls(db, amount, now = Date.now()) {
  if (!Number.isSafeInteger(amount) || amount < 1 || !validNow(now)) throw new Error('Invalid roll amount');
  return transaction(db, () => {
    let updated = 0;
    const update = db.prepare('UPDATE roll_allowances SET used = ? WHERE guild_id = ? AND user_id = ?');
    for (const row of db.prepare('SELECT * FROM roll_allowances WHERE used > 0').all()) {
      if (row.period !== rollPeriod(db, row.guild_id, now)) continue;
      update.run(Math.max(0, Math.min(row.used, rollCapacity(db, row.guild_id, row.user_id, now)) - amount), row.guild_id, row.user_id);
      updated++;
    }
    return { updated };
  });
}

export function resetGlobalClaims(db) {
  return transaction(db, () => {
    const updated = Number(db.prepare('DELETE FROM claim_allowances').run().changes);
    db.prepare('DELETE FROM claim_events').run();
    return { updated };
  });
}

export function claimDailyRolls(db, guildId, userId, now = Date.now()) {
  if (![guildId, userId].every(validId) || !validNow(now)) throw new Error('Invalid daily roll claim');
  const s = schedule(db, guildId);
  const period = bucket(now, s.dailyIntervalMs, s.timezoneOffsetMinutes);
  const nextReset = resetAt(now, s.dailyIntervalMs, s.timezoneOffsetMinutes);
  return transaction(db, () => {
    const previous = db.prepare('SELECT * FROM daily_roll_claims WHERE guild_id=? AND user_id=?').get(guildId, userId);
    const previousReset = previous?.reset_at ?? (previous ? (previous.period + 1) * DAY - VIETNAM_OFFSET : 0);
    if (previous && now < previousReset) return { status: 'claimed', resetAt: previousReset };
    db.prepare(`INSERT INTO daily_roll_claims (guild_id, user_id, period, reset_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(guild_id, user_id) DO UPDATE SET period=excluded.period, reset_at=excluded.reset_at`)
      .run(guildId, userId, period, nextReset);
    db.prepare(`INSERT INTO roll_allowances (guild_id, user_id, period, used)
      VALUES (?, ?, ?, 0) ON CONFLICT(guild_id, user_id) DO UPDATE SET
      period = excluded.period, used = 0`).run(guildId, userId, rollPeriod(db, guildId, now));
    return { status: 'refilled', remaining: getRollStatus(db, guildId, userId, now).remaining, resetAt: nextReset };
  });
}

export function getClaimStatus(db, guildId, userId, now = Date.now()) {
  if (![guildId, userId].every(validId) || !validNow(now)) throw new Error('Invalid claim status');
  const ringActive = claimBuffsReadOnly(db, guildId, userId, now)
    .find((buff) => buff.buff_id === 'engagement_ring');
  const cooldownEnd = claimCooldownEnd(db, guildId, userId, now, ringActive);
  return { canClaim: cooldownEnd === null, resetAt: cooldownEnd ?? nextClaimReset(now, db, guildId) };
}

function claimBuffsReadOnly(db, guildId, userId, now) {
  return db.prepare(`SELECT * FROM active_user_buffs WHERE guild_id=? AND user_id=?
    AND (expires_at IS NULL OR expires_at>?) AND (remaining_rolls IS NULL OR remaining_rolls>0)
    AND (starts_at IS NULL OR starts_at<=?) ORDER BY id`).all(guildId, userId, now, now);
}

/** Read-only eligibility, including usable bypass tokens; never consumes a buff. */
export function getClaimAvailability(db, guildId, userId, now = Date.now()) {
  if (![guildId, userId].every(validId) || !validNow(now)) throw new Error('Invalid claim status');
  // getActiveBuffs prunes expired rows. Eligibility inspection must be truly read-only.
  const buffs = claimBuffsReadOnly(db, guildId, userId, now);
  const end = claimCooldownEnd(db, guildId, userId, now,
    buffs.find(buff => buff.buff_id === 'engagement_ring'));
  const bypass = buffs.some(buff => ['double_date', 'crown_of_the_sovereign', 'pinata_claim_token'].includes(buff.buff_id));
  return { canClaim: end === null || bypass, resetAt: end ?? nextClaimReset(now, db, guildId) };
}

/** Claim cooldowns are bucket based, so buffs must be able to shorten the current bucket. */
function claimCooldownEnd(db, guildId, userId, now, ringActive = false) {
  const period = claimPeriod(db, guildId, now);
  const allowance = db.prepare('SELECT period FROM claim_allowances WHERE guild_id = ? AND user_id = ?')
    .get(guildId, userId);
  // A fresh claim bucket is always free, no matter what happened in the previous one.
  if (allowance?.period !== period) return null;
  const claimed = db.prepare('SELECT claimed_at FROM claim_events WHERE guild_id = ? AND user_id = ?')
    .get(guildId, userId);
  if (claimed?.claimed_at == null) return nextClaimReset(now, db, guildId);
  const interval = schedule(db, guildId).claimIntervalMs;
  const reduction = hasAffection(db) ? getAffectionBenefits(db, guildId, userId).claimReductionMs : 0;
  const shortened = Math.min(nextClaimReset(now, db, guildId),
    claimed.claimed_at + Math.max(0, interval - reduction),
    ringActive ? claimed.claimed_at + interval * (buffRules(ringActive).cooldownMultiplier ?? 0.5) : Infinity);
  return now < shortened ? shortened : null;
}

function validId(id) {
  return typeof id === 'string' && /^\d+$/.test(id);
}

function validNow(now) {
  return Number.isSafeInteger(now) && now >= 0;
}

const eligible = `FROM characters AS c WHERE NOT EXISTS
  (SELECT 1 FROM character_rolls AS r WHERE r.guild_id = ? AND r.character_id = c.id
    AND (r.state = 'pending' OR (r.state = 'open' AND r.expires_at > ?)))
  AND NOT EXISTS (SELECT 1 FROM character_protection_locks AS l
    WHERE l.guild_id = ? AND l.character_id = c.id
      AND l.lock_type = 'soulbind' AND l.protected_until IS NULL)
  AND (LOWER(TRIM(COALESCE(c.gender, ''))) NOT IN ('female', 'male')
    OR LOWER(TRIM(c.gender)) = ?)`;

const HIGH_FAVOURITE_CLAUSE = ' AND (c.favourites >= 1000 OR c.rank <= 1000)';

/** @param {{guildId: string, channelId: string, commandMessageId: string, userId: string,
 *   pool: string, now?: number, random?: () => number, prankEnabled?: boolean, vaultEnabled?: boolean,
 *   gameConfig?: ReturnType<typeof getGameConfig>,
 *   mystery?: {eventChannelId: string, selectEvent: (context: any) => any} | null}} request */
export function reserveRoll(db, request) {
  requireNewGameAction(db);
  const { guildId, channelId, commandMessageId, userId, pool,
    now = Date.now(), random = Math.random, mystery = null } = request;
  if (![guildId, channelId, commandMessageId, userId].every(validId)
    || !['w', 'h'].includes(pool) || !validNow(now)
    || (mystery && (!validId(mystery.eventChannelId) || typeof mystery.selectEvent !== 'function'))) {
    throw new Error('Invalid roll request');
  }
  return transaction(db, () => {
    const sourceKey = `roll:${guildId}:${commandMessageId}`;
    const affectionEnabled = hasAffection(db);
    if (affectionEnabled) {
      const saved = db.prepare('SELECT * FROM affection_requests WHERE source_key=?').get(sourceKey);
      if (saved) {
        if (saved.guild_id !== guildId || saved.user_id !== userId || saved.channel_id !== channelId) throw new Error('Roll invocation scope mismatch');
        return { ...JSON.parse(saved.outcome_json), status: 'duplicate' };
      }
    }
    const previous = db.prepare('SELECT id FROM character_rolls WHERE command_message_id = ?').get(commandMessageId);
    if (previous) return { status: 'duplicate', rollId: previous.id };
    if (db.prepare(`SELECT 1 FROM mystery_sessions WHERE guild_id = ? AND state IN ${ACTIVE_MYSTERY} LIMIT 1`)
      .get(guildId)) return { status: 'paused' };
    const period = rollPeriod(db, guildId, now);
    const allowance = db.prepare('SELECT period, used FROM roll_allowances WHERE guild_id = ? AND user_id = ?')
      .get(guildId, userId);
    const used = allowance?.period === period ? allowance.used : 0;
    const maxRolls = rollCapacity(db, guildId, userId, now);
    if (used >= maxRolls) return { status: 'exhausted', resetAt: nextRollReset(now, db, guildId) };
    const windfallChance = affectionEnabled ? getAffectionBenefits(db, guildId, userId).perks.windfall : 0;
    const debit = () => {
      const free = affectionEnabled && resolveAffectionDecisionInTransaction(db, { sourceKey, guildId, userId,
        effect: 'windfall', chance: windfallChance, now, random }).triggered;
      const current = db.prepare('SELECT period,used FROM roll_allowances WHERE guild_id=? AND user_id=?').get(guildId, userId);
      const nextUsed = (current?.period === period ? current.used : 0) + (free ? 0 : 1);
      db.prepare(`INSERT INTO roll_allowances(guild_id,user_id,period,used) VALUES(?,?,?,?)
        ON CONFLICT(guild_id,user_id) DO UPDATE SET period=excluded.period,used=excluded.used`).run(guildId,userId,period,nextUsed);
      return Math.max(0, maxRolls - nextUsed);
    };
    const saveRequest = result => {
      if (affectionEnabled) db.prepare('INSERT INTO affection_requests VALUES(?,?,?,?,?,?)')
        .run(sourceKey,guildId,userId,channelId,JSON.stringify(result),now);
      return result;
    };
    const rates = getGuildRates(db, guildId);
    if (request.prankEnabled && rates.prankRate > 0) {
      const draw = random();
      if (!Number.isFinite(draw) || draw < 0 || draw >= 1) throw new Error('Invalid random value');
      if (draw < rates.prankRate) {
        // Split the prank interval equally between the prank variants
        const halfRate = rates.prankRate / 2;
        const prank = draw < halfRate ? 'dog_clap' : 'john_pork';
        const remaining = debit();
        db.prepare(`INSERT INTO character_rolls
          (guild_id, channel_id, command_message_id, character_id, character_name, state, published_at)
          VALUES (?, ?, ?, 0, ?, 'prank', ?)`)
          .run(guildId, channelId, commandMessageId, prank, now);
        return saveRequest({ status: 'prank', prank, remaining });
      }
    }
    const rules = request.gameConfig ?? getGameConfig(db, guildId);
    if (request.vaultEnabled && rules.vault.enabled && rates.vaultRate > 0) {
      if (passesVaultGate(random, rates.vaultRate)) {
        const remaining = debit();
        db.prepare(`INSERT INTO character_rolls
          (guild_id, channel_id, command_message_id, character_id, character_name, state, published_at)
          VALUES (?, ?, ?, 0, 'vault', 'vault', ?)`)
          .run(guildId, channelId, commandMessageId, now);
        if (hasVaultSessions(db)) reservePaidVaultSession(db, { guildId, userId, channelId,
          commandMessageId, paidRollId: commandMessageId, remaining,
          now, gameConfig: rules });
        return saveRequest({ status: 'vault', remaining });
      }
    }
    const gender = pool === 'w' ? 'female' : 'male';
    const activeBuffs = getActiveBuffs(db, guildId, userId, now);
    const guildBuffs = getGuildBuffs(db, guildId, now);
    const passportBuff = activeBuffs.find((b) => b.buff_id === 'franchise_passport');
    const cloverBuff = activeBuffs.find((b) => b.buff_id === 'four_leaf_clover');
    const feverBuff = activeBuffs.find((b) => b.buff_id === 'rolling_fever');
    const pinataBuff = guildBuffs.find((b) => b.buff_id === 'pinata');

    let buffClause = '';
    let buffParams = [];
    let passportApplied = false;
    let cloverApplied = false;
    if (passportBuff?.data_json) {
      try {
        const parsed = JSON.parse(passportBuff.data_json);
        if (parsed.franchiseId) {
          buffClause = ` AND EXISTS (
            SELECT 1 FROM ${characterFranchiseRelation(db)} AS membership
            WHERE membership.character_id = c.id AND membership.franchise_id = ?
          )`;
          buffParams.push(parsed.franchiseId);
          passportApplied = true;
        }
      } catch {}
    } else if (cloverBuff || pinataBuff) {
      // A Clover charge is only spent when its filter is the one actually applied.
      cloverApplied = Boolean(cloverBuff);
      const effect = buffRules(cloverBuff ?? pinataBuff);
      buffClause = ' AND (c.favourites >= ? OR c.rank <= ?)';
      buffParams.push(effect.minFavourites ?? 1000, effect.maxRank ?? 1000);
    }

    const playerEligible = affectionEnabled ? eligible.replace("AND l.protected_until IS NULL)",
      "AND l.protected_until IS NULL AND NOT EXISTS (SELECT 1 FROM marriages own WHERE own.guild_id=l.guild_id AND own.character_id=c.id AND own.owner_id=?))") : eligible;
    const baseParams = affectionEnabled ? [guildId, now, guildId, userId, gender] : [guildId, now, guildId, gender];
    let queryEligible = `${playerEligible}${buffClause}`;
    let queryParams = [...baseParams, ...buffParams];
    const available = () => db.prepare(`SELECT c.id ${queryEligible}
      AND NOT EXISTS (SELECT 1 FROM item_character_reservations AS reservation
        WHERE reservation.guild_id = ? AND reservation.character_id = c.id)
      ORDER BY c.id`).all(...queryParams, guildId)
      .filter((row) => !isCharacterPendingTransfer(db, guildId, row.id, now));
    let candidates = available();
    let count = candidates.length;

    // Fallback if buff filtered to 0 matches
    if (!count && buffClause) {
      queryEligible = playerEligible;
      queryParams = baseParams;
      passportApplied = false;
      cloverApplied = false;
      candidates = available();
      count = candidates.length;
    }

    if (!count) return { status: 'empty' };
    const fraction = random();
    if (!Number.isFinite(fraction) || fraction < 0 || fraction >= 1) throw new Error('Invalid random value');
    const offset = Math.floor(fraction * count);
    const character = db.prepare(`SELECT c.id, c.name_full, c.rank, c.favourites, ${characterLikesProjection(db, 'c')}, c.image_url, c.anime_titles, c.gender,
      (SELECT tag_name FROM tag_decisions WHERE character_id = c.id AND status = 'approve') AS tag_name
      ${queryEligible} AND c.id = ?`).get(...queryParams, candidates[offset].id);

    hydrateCharacterFranchises(db, [character]);
    const characterSnapshot = captureCharacterSnapshot(character);
    if (affectionEnabled) captureAppearanceInTransaction(db, { sourceKey, guildId, channelId, userId, characterId: character.id, now, random });
    if (passportApplied) consumeBuffRoll(db, passportBuff.id);
    if (cloverApplied) consumeBuffRoll(db, cloverBuff.id);
    if (pinataBuff && !passportApplied && !cloverApplied) consumeBuffRoll(db, pinataBuff.id);
    if (feverBuff) {
      consumeBuffRoll(db, feverBuff.id);
      const effect = buffRules(feverBuff);
      if (character && character.favourites > (effect.favouritesThreshold ?? 1000)) {
        db.prepare(`UPDATE roll_allowances SET used = MAX(0, used - ?)
          WHERE guild_id = ? AND user_id = ? AND period = ?`).run(effect.refundRolls ?? 2, guildId, userId, period);
      }
    }
    let marriage = getMarriage(db, guildId, character.id);
    const ownAppearance = affectionEnabled && marriage?.ownerId === userId;
    let cupidsMisfire = null;
    const misfire = activeBuffs.find(buff => buff.buff_id === 'cupids_misfire');
    if (misfire && marriage && !ownAppearance && !isCharacterBusy(db, guildId, character.id, now)) {
      // All reads, ownership cleanup, defense/effect costs and roll persistence
      // share this write transaction. Never redirect via Crown or consult theft locks.
      const attackKey = `misfire:${sourceKey}`;
      const negated = marriage.ownerId !== userId && resolveSoulmateNegation(db, {
        sourceKey: attackKey, guildId, ownerId: marriage.ownerId, now, random }).triggered;
      const shield = negated || marriage.ownerId === userId ? null : getUsableInventory(db, guildId, marriage.ownerId, now)
        .find(item => item.item_id === 'mirror_shield');
      cupidsMisfire = { version: 1, result: negated ? 'negated' : shield ? 'blocked' : 'divorced',
        characterId: character.id, formerOwnerId: marriage.ownerId, marriageId: marriage.id };
      if (negated) {
        // The armed attack is exhausted below, but natural escape behavior remains.
      } else if (shield) {
        spendAffectionItemChargeInTransaction(db, { sourceKey: attackKey, guildId, userId: marriage.ownerId, inventoryId: shield.id, now, random });
      } else {
        if (!divorceCharacter(db, guildId, character.id, marriage.ownerId, marriage.id, now)) {
          throw new Error('Cupid\'s Misfire marriage changed during commitment');
        }
        marriage = null;
      }
      db.prepare('DELETE FROM active_user_buffs WHERE id=?').run(misfire.id);
    }
    let selectedEvent = null;
    if (!cupidsMisfire && !marriage && mystery && rules.mystery.enabled && passesMysteryGate(character.rank, random, rules.mystery.oddsAnchors)) {
      selectedEvent = mystery.selectEvent({ db, character, guildId, userId, now, random });
      // No eligible event (for example Clue Reveal in a manual-only catalog)
      // leaves this as an ordinary roll, with the already-applied buffs counted once.
      if (selectedEvent && (typeof selectedEvent.eventId !== 'string' || !selectedEvent.eventId.trim()
        || !Number.isSafeInteger(selectedEvent.durationMs) || selectedEvent.durationMs <= 0
        || !Number.isSafeInteger(now + selectedEvent.durationMs))) throw new Error('Invalid mystery event');
    }
    const remaining = debit();
    const result = db.prepare(`INSERT INTO character_rolls
      (guild_id, channel_id, command_message_id, character_id, character_name, state,
        escape_marriage_id, escape_owner_id)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`)
      .run(guildId, selectedEvent ? mystery?.eventChannelId : channelId,
        commandMessageId, characterSnapshot.id, characterSnapshot.name_full, ownAppearance ? null : marriage?.id ?? null, ownAppearance ? null : marriage?.ownerId ?? null);
    const rollId = Number(result.lastInsertRowid);
    // Outcome is an immutable extension of the existing durable roll terms;
    // no inference from mutable ownership is needed for delivery or recovery.
    db.prepare('UPDATE character_rolls SET rules_json=? WHERE id=?')
      .run(JSON.stringify({ ...rules.windows, ...(affectionEnabled ? { affectionVersion: 1, affectionSourceKey: sourceKey } : {}),
        ...(ownAppearance ? { ownAppearance: true } : {}), ...(cupidsMisfire ? { cupidsMisfire } : {}) }), rollId);
    if (hasRollCharacterSnapshot(db)) {
      db.prepare('UPDATE character_rolls SET character_snapshot_json=? WHERE id=?')
        .run(JSON.stringify(characterSnapshot), rollId);
    }
    if (!selectedEvent) {
      captureRollDelivery(db, { rollId, userId, remaining, characterSnapshot });
      return saveRequest({ status: 'reserved', rollId, character: characterSnapshot,
        ownAppearance, escapeOwnerId: ownAppearance ? null : marriage?.ownerId ?? null, cupidsMisfire, windows: rules.windows, remaining });
    }
    const session = db.prepare(`INSERT INTO mystery_sessions
      (guild_id, origin_roll_id, event_id, character_id, rank_snapshot, roller_id,
        event_channel_id, state, state_json, started_at, deadline_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?)`).run(
      guildId, rollId, selectedEvent.eventId, characterSnapshot.id, characterSnapshot.rank, userId,
      mystery?.eventChannelId, JSON.stringify({ ...selectedEvent.state, characterSnapshot }), now, now + selectedEvent.durationMs);
    const sessionId = Number(session.lastInsertRowid);
    db.prepare('UPDATE character_rolls SET mystery_session_id = ? WHERE id = ?').run(sessionId, rollId);
    return saveRequest({ status: 'mystery', rollId, sessionId, eventId: selectedEvent.eventId,
      character: characterSnapshot, remaining });
  });
}

export function publishRoll(db, rollId, messageId, now = Date.now()) {
  if (!Number.isSafeInteger(rollId) || !validId(messageId) || !validNow(now)) throw new Error('Invalid roll publication');
  return transaction(db, () => {
    const roll = db.prepare(`SELECT guild_id AS guildId, character_id AS characterId,
      escape_marriage_id AS escapeMarriageId, escape_owner_id AS escapeOwnerId, rules_json AS rulesJson
      FROM character_rolls WHERE id = ? AND state = 'pending' AND mystery_session_id IS NULL`).get(rollId);
    if (!roll) return false;
    loadRollCharacterSnapshot(db, rollId);
    const windows = roll.rulesJson ? JSON.parse(roll.rulesJson) : getGameConfig(db, roll.guildId).windows;
    if (isCharacterReserved(db, roll.guildId, roll.characterId)
      || (roll.escapeMarriageId && !originalMarriageExists(db, roll))) {
      db.prepare(`UPDATE character_rolls SET message_id = ?, state = 'closed', published_at = ?,
        escape_outcome = 'canceled', escape_resolved_at = ? WHERE id = ?`).run(messageId, now, now, rollId);
      if (windows.affectionSourceKey && hasAffection(db)) cancelAppearanceInTransaction(db, windows.affectionSourceKey, now);
      return false;
    }
    const published = db.prepare(`UPDATE character_rolls SET message_id = ?, state = ?,
      published_at = ?, protected_until = ?, expires_at = ? WHERE id = ? AND state = 'pending'`)
      .run(messageId, windows.ownAppearance ? 'closed' : 'open', now, roll.escapeMarriageId ? now + windows.escapeProtectionMs : null,
        now + (roll.escapeMarriageId ? windows.escapeProtectionMs + windows.escapeClaimMs : windows.claimMs), rollId).changes === 1;
    if (published && windows.affectionSourceKey && hasAffection(db)) completeAppearanceInTransaction(db, {
      sourceKey: windows.affectionSourceKey, now, rewardRoster: getResolvedItemDefinitions(db, roll.guildId) });
    return published;
  });
}

export function failRoll(db, rollId) {
  if (!Number.isSafeInteger(rollId)) throw new Error('Invalid roll');
  return transaction(db, () => {
    const roll = db.prepare('SELECT mystery_session_id AS sessionId FROM character_rolls WHERE id = ?').get(rollId);
    const failed = db.prepare(`UPDATE character_rolls SET state = 'failed',
      escape_outcome = CASE WHEN escape_marriage_id IS NOT NULL THEN 'failed' END,
      escape_resolved_at = CASE WHEN escape_marriage_id IS NOT NULL THEN ? END
      WHERE id = ? AND state IN ('pending', 'open')`)
      .run(Date.now(), rollId).changes === 1;
    if (failed && roll?.sessionId) finishMystery(db, roll.sessionId, 'failed', Date.now());
    return failed;
  });
}

export function getMysterySession(db, sessionId) {
  if (!Number.isSafeInteger(sessionId) || sessionId <= 0) return null;
  return db.prepare(`SELECT id, guild_id AS guildId, origin_roll_id AS originRollId,
    event_id AS eventId, character_id AS characterId, rank_snapshot AS rankSnapshot,
    roller_id AS rollerId, event_channel_id AS eventChannelId,
    event_message_id AS eventMessageId, state, state_json AS stateJson,
    started_at AS startedAt, next_at AS nextAt, deadline_at AS deadlineAt,
    winner_id AS winnerId, resolved_at AS resolvedAt, outcome
    FROM mystery_sessions WHERE id = ?`).get(sessionId) ?? null;
}

export function publishMysteryIntro(db, sessionId, messageId, now = Date.now()) {
  if (!Number.isSafeInteger(sessionId) || sessionId <= 0 || !validId(messageId) || !validNow(now)) {
    throw new Error('Invalid mystery intro');
  }
  return transaction(db, () => {
    const session = getMysterySession(db, sessionId);
    if (session?.state !== 'reserved' || session.eventMessageId) return false;
    characterSnapshotFromState(JSON.parse(session.stateJson || 'null'), session.characterId, session.rankSnapshot);
    const snapshot = session.stateJson ? JSON.parse(session.stateJson)?.gameConfig : null;
    const promptAt = now + (snapshot?.mystery.introDelayMs ?? 5_000);
    const deadlineAt = promptAt + session.deadlineAt - session.startedAt;
    if (!validNow(promptAt) || !validNow(deadlineAt)) throw new Error('Invalid mystery deadline');
    return db.prepare(`UPDATE mystery_sessions SET event_message_id = ?,
      started_at = ?, next_at = ?, deadline_at = ?
      WHERE id = ? AND state = 'reserved' AND event_message_id IS NULL`)
      .run(messageId, promptAt, promptAt, deadlineAt, sessionId).changes === 1;
  });
}

export function advanceMysterySession(db, { sessionId, expectedState, expectedStateJson, state, stateJson,
  nextAt = /** @type {number | null} */ (null), winnerId = null, puzzleId = null, now = Date.now(), random = Math.random,
  deadlineAt = /** @type {number | null} */ (null) }) {
  if (!Number.isSafeInteger(sessionId) || sessionId <= 0 || !validNow(now)
    || (nextAt != null && !validNow(nextAt)) || (winnerId != null && !validId(winnerId))
    || (puzzleId != null && (typeof puzzleId !== 'string' || !puzzleId))
    || (expectedStateJson !== null && typeof expectedStateJson !== 'string')) {
    throw new Error('Invalid mystery transition');
  }
  const allowed = (expectedState === 'reserved' && state === 'running')
    || (expectedState === 'running' && ['running', 'countdown'].includes(state));
  if (!allowed || (state === 'countdown' && !winnerId) || (puzzleId && state !== 'countdown')) {
    throw new Error('Invalid mystery transition');
  }
  return transaction(db, () => {
    const session = getMysterySession(db, sessionId);
    if (session?.state !== expectedState || session.stateJson !== expectedStateJson) return { status: 'stale' };
    characterSnapshotFromState(JSON.parse(session.stateJson || 'null'), session.characterId, session.rankSnapshot);
    if (expectedState === 'reserved' && (!session.eventMessageId || now < session.nextAt)) {
      return { status: 'early' };
    }
    if (deadlineAt != null && (session.eventId !== 'glass_bridge' || !validNow(deadlineAt)
      || deadlineAt <= now)) throw new Error('Invalid mystery deadline extension');
    if (now >= session.deadlineAt && !(session.eventId === 'glass_bridge' && deadlineAt != null)) return { status: 'expired' };
    const next = state === 'countdown' ? (nextAt ?? now + 5_000) : nextAt;
    if (next != null && !validNow(next)) throw new Error('Invalid mystery transition');
    const original = JSON.parse(session.stateJson || 'null');
    const replacement = stateJson === undefined ? original : stateJson;
    const retained = retainCharacterSnapshot(original, replacement, session.characterId);
    // The public transition API predates runtime outcomes: entering countdown
    // with a winner is itself authoritative. Persist that fact here, not later
    // when a restarted legacy Doors row may represent either a win or a loss.
    if (state === 'countdown') {
      const runtime = retained.runtime;
      const resolved = runtime?.resolved ?? { type: 'winner', winnerId };
      if ((runtime?.version != null && runtime.version !== 1)
        || !['winner', 'no_winner'].includes(resolved.type)
        || (resolved.type === 'winner' && resolved.winnerId !== winnerId)
        || (resolved.type === 'no_winner' && resolved.winnerId != null)) {
        throw new Error('Invalid mystery countdown outcome');
      }
      retained.runtime = { ...runtime, version: 1, phase: 'countdown', resolved };
      // Never accept a caller-injected decision or activate on losing Doors.
      delete retained.runtime.consolation;
      if (resolved.type === 'winner') retained.runtime.consolation = resolveMysteryConsolation(db, {
        session, winnerId, canClaim: getClaimAvailability(db, session.guildId, winnerId, now).canClaim, now, random,
      });
    }
    const serialized = stateJson === undefined && state !== 'countdown'
      ? session.stateJson : JSON.stringify(retained);
    const changed = db.prepare(`UPDATE mystery_sessions SET state = ?, state_json = ?, next_at = ?,
      winner_id = COALESCE(?, winner_id), deadline_at = COALESCE(?, deadline_at)
      WHERE id = ? AND state = ? AND state_json IS ?`)
      .run(state, serialized, next, winnerId, deadlineAt, sessionId, expectedState, expectedStateJson).changes;
    if (changed !== 1) return { status: 'stale' };
    if (puzzleId) db.prepare(`INSERT INTO treasure_puzzle_wins (guild_id, puzzle_id, won_at)
      VALUES (?, ?, ?)`).run(session.guildId, puzzleId, now);
    return { status: 'advanced', session: getMysterySession(db, sessionId) };
  });
}

function finishMystery(db, sessionId, outcome, now) {
  const state = outcome === 'canceled' ? 'canceled' : outcome === 'failed' ? 'failed' : 'completed';
  const changed = db.prepare(`UPDATE mystery_sessions SET state = ?, outcome = ?, resolved_at = ?, next_at = NULL
    WHERE id = ? AND state IN ${ACTIVE_MYSTERY}`).run(state, outcome, now, sessionId).changes === 1;
  if (changed) {
    db.prepare(`UPDATE character_rolls SET state = 'closed'
      WHERE mystery_session_id = ? AND state IN ('pending', 'open')`).run(sessionId);
    if (hasAffection(db)) {
      const session = getMysterySession(db, sessionId);
      const origin = db.prepare('SELECT rules_json FROM character_rolls WHERE id=?').get(session.originRollId);
      const terms = origin?.rules_json ? JSON.parse(origin.rules_json) : {};
      if (terms.affectionVersion === 1) {
        if (['canceled','failed'].includes(outcome)) cancelAppearanceInTransaction(db, terms.affectionSourceKey, now);
        else {
          const captured = db.prepare('SELECT state FROM affection_contexts WHERE source_key=?').get(terms.affectionSourceKey);
          if (captured?.state === 'captured') {
            const state = JSON.parse(session.stateJson || '{}');
            state.runtime = { ...state.runtime, affectionRevealPending: true };
            db.prepare('UPDATE mystery_sessions SET state_json=? WHERE id=?').run(JSON.stringify(state),sessionId);
          }
        }
      }
    }
  }
  return changed;
}

export function endMysterySession(db, { sessionId, outcome, now = Date.now() }) {
  if (!Number.isSafeInteger(sessionId) || sessionId <= 0 || typeof outcome !== 'string' || !outcome.trim()
    || !validNow(now)) throw new Error('Invalid mystery resolution');
  return transaction(db, () => finishMystery(db, sessionId, outcome, now));
}

export function openMysteryClaim(db, { sessionId, messageId, now = Date.now() }) {
  if (!Number.isSafeInteger(sessionId) || sessionId <= 0 || !validId(messageId) || !validNow(now)) {
    throw new Error('Invalid mystery claim publication');
  }
  return transaction(db, () => {
    const session = getMysterySession(db, sessionId);
    if (session?.state !== 'countdown' || !session.winnerId) return { status: 'stale' };
    loadRollCharacterSnapshot(db, session.originRollId);
    characterSnapshotFromState(JSON.parse(session.stateJson || 'null'), session.characterId, session.rankSnapshot);
    const runtime = JSON.parse(session.stateJson || 'null')?.runtime;
    // Legacy Doors countdowns do not say whether the roller actually won.
    if (session.eventId === 'doors' && (runtime?.version !== 1
      || runtime.resolved?.type !== 'winner')) return { status: 'ambiguous' };
    if (now < session.nextAt) return { status: 'early' };
    if (inspectMysteryConsolation(db, session)?.status === 'activated') {
      finishMystery(db, sessionId, 'consolation', now);
      return { status: 'unclaimable', reason: 'consolation' };
    }
    const character = db.prepare('SELECT 1 FROM characters WHERE id = ?').get(session.characterId);
    if (!character || getMarriage(db, session.guildId, session.characterId)) {
      finishMystery(db, sessionId, 'unavailable', now);
      return { status: 'unclaimable', reason: 'unavailable' };
    }
    if (!getClaimAvailability(db, session.guildId, session.winnerId, now).canClaim) {
      finishMystery(db, sessionId, 'forfeited', now);
      return { status: 'unclaimable', reason: 'no_claim' };
    }
    const snapshot = db.prepare('SELECT rules_json FROM character_rolls WHERE id=?').get(session.originRollId)?.rules_json;
    const claimWindow = snapshot ? JSON.parse(snapshot).claimMs : getGameConfig(db, session.guildId).windows.claimMs;
    const expiresAt = session.nextAt + claimWindow;
    if (now >= expiresAt) {
      finishMystery(db, sessionId, 'expired', now);
      return { status: 'unclaimable', reason: 'expired' };
    }
    const published = db.prepare(`UPDATE character_rolls SET message_id = ?, state = 'open',
      exclusive_user_id = ?, published_at = ?, expires_at = ?
      WHERE id = ? AND mystery_session_id = ? AND state = 'pending'`)
      .run(messageId, session.winnerId, session.nextAt, expiresAt, session.originRollId, sessionId).changes === 1;
    if (!published) return { status: 'stale' };
    db.prepare("UPDATE mystery_sessions SET state = 'claim_open', next_at = ? WHERE id = ? AND state = 'countdown'")
      .run(expiresAt, sessionId);
    return { status: 'open', rollId: session.originRollId, expiresAt,
      winnerId: session.winnerId };
  });
}

export function cancelActiveMysteries(db, now = Date.now()) {
  if (!validNow(now)) throw new Error('Invalid mystery cancellation');
  return transaction(db, () => {
    const ids = db.prepare(`SELECT id FROM mystery_sessions WHERE state IN ${ACTIVE_MYSTERY}`).all();
    for (const { id } of ids) finishMystery(db, id, 'canceled', now);
    return ids.length;
  });
}

export function getRoll(db, guildId, channelId, messageId) {
  if (![guildId, channelId, messageId].every(validId)) return null;
  return db.prepare(`SELECT id, guild_id AS guildId, channel_id AS channelId,
    message_id AS messageId, command_message_id AS commandMessageId, character_id AS characterId,
    character_name AS characterName, state, published_at AS publishedAt,
    expires_at AS expiresAt, mystery_session_id AS mysterySessionId,
    exclusive_user_id AS exclusiveUserId, escape_marriage_id AS escapeMarriageId,
    escape_owner_id AS escapeOwnerId, protected_until AS protectedUntil,
    escape_outcome AS escapeOutcome, escape_winner_id AS escapeWinnerId,
    escape_resolved_at AS escapeResolvedAt, rules_json AS rulesJson,
    ${hasRollCharacterSnapshot(db) ? 'character_snapshot_json' : 'NULL'} AS characterSnapshotJson FROM character_rolls
    WHERE guild_id = ? AND channel_id = ? AND message_id = ?`)
    .get(guildId, channelId, messageId) ?? null;
}

function originalMarriageExists(db, roll) {
  const marriage = getMarriage(db, roll.guildId, roll.characterId);
  return marriage?.id === roll.escapeMarriageId && marriage?.ownerId === roll.escapeOwnerId;
}

function closeEscape(db, roll, outcome, now, winnerId = null) {
  db.prepare(`UPDATE character_rolls SET state = 'closed', escape_outcome = ?,
    escape_winner_id = ?, escape_resolved_at = ? WHERE id = ? AND state = 'open'`)
    .run(outcome, winnerId, now, roll.id);
}

function settleEscape(db, roll, now) {
  if (!roll?.escapeMarriageId || roll.state !== 'open') return;
  if (!originalMarriageExists(db, roll)
    || !db.prepare('SELECT 1 FROM characters WHERE id = ?').get(roll.characterId)) {
    closeEscape(db, roll, 'canceled', now);
  } else if (now >= roll.expiresAt) {
    closeEscape(db, roll, 'expired', now);
  }
}

export function refreshEscapeRoll(db, guildId, channelId, messageId, now = Date.now()) {
  if (!validNow(now)) throw new Error('Invalid escape time');
  return transaction(db, () => {
    const roll = getRoll(db, guildId, channelId, messageId);
    if (roll) loadRollCharacterSnapshot(db, roll.id);
    settleEscape(db, roll, now);
    return getRoll(db, guildId, channelId, messageId);
  });
}

export function claimRoll(db, request) {
  return transaction(db, () => claimRollInTransaction(db, request));
}

// Caller must already hold the write transaction (passive publication effects).
export function claimRollInTransaction(db, { guildId, channelId, messageId, userId, now = Date.now(), random = Math.random }) {
  if (![guildId, channelId, messageId, userId].every(validId) || !validNow(now)) throw new Error('Invalid claim');
  return (() => {
    const roll = getRoll(db, guildId, channelId, messageId);
    if (!roll) return { status: 'unknown' };
    if (roll.state !== 'open') return { status: 'closed' };
    loadRollCharacterSnapshot(db, roll.id);
    if (Number(db.prepare('PRAGMA user_version').get().user_version) === 12
      && (!Number.isSafeInteger(roll.publishedAt) || !Number.isSafeInteger(roll.expiresAt)
        || roll.expiresAt <= roll.publishedAt)) throw new Error('Invalid durable claim deadline');
    if (isCharacterReserved(db, guildId, roll.characterId)) return { status: 'closed' };
    if (roll.escapeMarriageId) {
      settleEscape(db, roll, now);
      if (getRoll(db, guildId, channelId, messageId).state !== 'open') {
        return { status: now >= roll.expiresAt ? 'expired' : 'closed' };
      }
      if (userId === roll.escapeOwnerId) {
        closeEscape(db, roll, 'reclaimed', now, userId);
        db.prepare("UPDATE character_rolls SET state = 'closed' WHERE guild_id = ? AND character_id = ? AND state = 'open'")
          .run(guildId, roll.characterId);
        const affection = hasAffection(db) ? earnReclaimInTransaction(db, {
          sourceKey: `reclaim:${guildId}:${roll.commandMessageId ?? roll.id}`, guildId, channelId, userId,
          characterId: roll.characterId, now, random, rewardRoster: getResolvedItemDefinitions(db, guildId) }) : null;
        return { status: 'reclaimed', characterName: roll.characterName, characterId: roll.characterId, affection };
      }
      if (now < roll.protectedUntil) return { status: 'protected' };
    }
    if (now >= roll.expiresAt) return { status: 'expired' };
    if (roll.mysterySessionId) {
      const session = db.prepare('SELECT state FROM mystery_sessions WHERE id = ? AND guild_id = ?')
        .get(roll.mysterySessionId, guildId);
      if (session?.state !== 'claim_open') return { status: 'closed' };
      const mystery = getMysterySession(db, roll.mysterySessionId);
      characterSnapshotFromState(JSON.parse(mystery.stateJson || 'null'), mystery.characterId, mystery.rankSnapshot);
      if (mystery.characterId !== roll.characterId) throw new Error('Mystery origin roll identity mismatch');
      if (!roll.exclusiveUserId || roll.exclusiveUserId !== userId) return { status: 'protected' };
    }
    if (!roll.escapeMarriageId && getMarriage(db, guildId, roll.characterId)) {
      db.prepare("UPDATE character_rolls SET state = 'closed' WHERE guild_id = ? AND character_id = ? AND state = 'open'")
        .run(guildId, roll.characterId);
      if (roll.mysterySessionId) finishMystery(db, roll.mysterySessionId, 'unavailable', now);
      return { status: 'closed' };
    }
    const period = claimPeriod(db, guildId, now);
    const claimBuffs = getActiveBuffs(db, guildId, userId, now);
    const crownBuff = claimBuffs.find((b) => b.buff_id === 'crown_of_the_sovereign');
    const doubleDateBuff = claimBuffs.find((b) => b.buff_id === 'double_date');
    const tokenBuff = claimBuffs.find((b) => b.buff_id === 'pinata_claim_token');
    const ringBuff = claimBuffs.find((b) => b.buff_id === 'engagement_ring');
    const cooldownEnd = claimCooldownEnd(db, guildId, userId, now, ringBuff);
    if (!getClaimAvailability(db, guildId, userId, now).canClaim) return { status: 'exhausted', resetAt: cooldownEnd, rollId: roll.id };
    const normalSelected = !doubleDateBuff && !crownBuff && !tokenBuff;
    const ringNeeded = normalSelected && Boolean(ringBuff) && claimCooldownEnd(db, guildId, userId, now, false) !== null;
    const claimConserved = hasAffection(db) && resolveAffectionDecisionInTransaction(db, {
      sourceKey: `marriage:${guildId}:${roll.commandMessageId ?? roll.id}`, guildId, userId, effect: 'claim_conservation',
      chance: getAffectionBenefits(db, guildId, userId).perks.claim_conservation, now, random }).triggered;
    if (roll.escapeMarriageId && !withOwnershipOperationClock(db, now, () =>
      divorceCharacter(db, guildId, roll.characterId, roll.escapeOwnerId, roll.escapeMarriageId, now))) throw new Error('Escape marriage changed during transfer');
    const result = marryCharacter(db, guildId, roll.characterId, userId);
    if (result.status !== 'married') {
      if (roll.escapeMarriageId) throw new Error('Escape marriage transfer failed');
      if (result.status === 'already_owned' || result.status === 'already_yours') {
        db.prepare("UPDATE character_rolls SET state = 'closed' WHERE guild_id = ? AND character_id = ? AND state = 'open'")
          .run(guildId, roll.characterId);
        if (roll.mysterySessionId) finishMystery(db, roll.mysterySessionId, 'unavailable', now);
      }
      return { status: 'closed' };
    }
    if (claimConserved) {
      // Preserve exactly the planned resource, including an enabling Ring use.
    } else if (doubleDateBuff) {
      // Pre-hotfix timed buffs had no counter. Give a retained legacy buff its
      // bounded entitlement on the first successful claim, never on inspection.
      if (doubleDateBuff.remaining_rolls === null) {
        db.prepare('UPDATE active_user_buffs SET remaining_rolls=? WHERE id=?')
          .run(buffRules(doubleDateBuff).freeClaims ?? 2, doubleDateBuff.id);
      }
      consumeBuffRoll(db, doubleDateBuff.id);
    } else if (crownBuff) {
      consumeBuffRoll(db, crownBuff.id);
    } else if (tokenBuff) {
      consumeBuffRoll(db, tokenBuff.id);
    } else {
      db.prepare(`INSERT INTO claim_allowances (guild_id, user_id, period) VALUES (?, ?, ?)
        ON CONFLICT(guild_id, user_id) DO UPDATE SET period = excluded.period`)
        .run(guildId, userId, period);
      db.prepare(`INSERT INTO claim_events (guild_id, user_id, claimed_at) VALUES (?, ?, ?)
        ON CONFLICT(guild_id, user_id) DO UPDATE SET claimed_at = excluded.claimed_at`)
        .run(guildId, userId, now);
      // The ring only pays for a claim it actually shortened.
      if (ringNeeded) consumeBuffRoll(db, ringBuff.id);
    }
    if (roll.escapeMarriageId) closeEscape(db, roll, 'married', now, userId);
    db.prepare("UPDATE character_rolls SET state = 'closed' WHERE guild_id = ? AND character_id = ? AND state = 'open'")
      .run(guildId, roll.characterId);
    if (roll.mysterySessionId) finishMystery(db, roll.mysterySessionId, 'claimed', now);
    return { status: 'married', characterName: roll.characterName, characterId: roll.characterId };
  })();
}

export function markClaimNotice(db, rollId, userId) {
  if (!Number.isSafeInteger(rollId) || !validId(userId)) throw new Error('Invalid claim notice');
  return db.prepare('INSERT OR IGNORE INTO roll_notices (roll_id, user_id) VALUES (?, ?)')
    .run(rollId, userId).changes === 1;
}

export function getReportableRoll(db, guildId, channelId, messageId, now = Date.now()) {
  const roll = getRoll(db, guildId, channelId, messageId);
  const lifetime = roll?.rulesJson ? JSON.parse(roll.rulesJson).reportMs ?? REPORT_LIFETIME : REPORT_LIFETIME;
  return roll?.publishedAt != null && now < roll.publishedAt + lifetime ? roll : null;
}

export function recoverRolls(db, now = Date.now()) {
  // Only bound, validated durable escape cards can survive a restart. Legacy
  // cards without snapshots (and unpublished ordinary escapes) cancel explicitly.
  for (const row of db.prepare(`SELECT id, state, message_id, command_message_id FROM character_rolls
    WHERE escape_marriage_id IS NOT NULL AND state IN ('pending', 'open')`).all()) {
    if (row.state === 'pending' && (row.command_message_id.startsWith('siren:')
      || Number(db.prepare('PRAGMA user_version').get().user_version) === 12)) continue;
    if (row.state === 'open' && row.message_id) {
      try { if (loadRollCharacterSnapshot(db, row.id)) continue; } catch { /* Fail closed. */ }
    }
    db.prepare(`UPDATE character_rolls SET state='closed', escape_outcome='canceled', escape_resolved_at=?
      WHERE id=?`).run(now, row.id);
  }
  // Final-schema paid pending reservations are durable, including malformed or
  // missing delivery records: leave these for recovery/inspection, never fail them.
  // Intermediate/legacy fixtures retain their historical recovery contract.
  if (Number(db.prepare('PRAGMA user_version').get().user_version) !== 12) {
    db.prepare("UPDATE character_rolls SET state = 'failed' WHERE state = 'pending' AND mystery_session_id IS NULL AND command_message_id NOT LIKE 'siren:%'").run();
  }
  return db.prepare(`SELECT id, guild_id AS guildId, channel_id AS channelId,
    message_id AS messageId, character_id AS characterId, expires_at AS expiresAt
    FROM character_rolls WHERE state = 'open' AND mystery_session_id IS NULL AND expires_at > ?`).all(now);
}

export function cleanupRolls(db, now = Date.now()) {
  return transaction(db, () => {
    const abandonment = inspectLegacyVaultAbandonment(db);
    if (abandonment.blockers.length) throw new Error(abandonment.blockers.join('\n'));
    const candidates = db.prepare(`SELECT r.*, m.resolved_at AS mystery_resolved_at FROM character_rolls r
      LEFT JOIN mystery_sessions m ON m.id=r.mystery_session_id`).all();
    let removed = 0;
    for (const row of candidates) {
      // Valid abandonment evidence binds these historical rows exactly, beyond report expiry.
      if (abandonment.ids.has(row.id)) continue;
      if (row.mystery_session_id) {
        const session = getMysterySession(db, row.mystery_session_id);
        if (JSON.parse(session.stateJson || '{}')?.runtime?.affectionRevealPending === true) continue;
        const decision = inspectMysteryConsolation(db, session);
        if (decision?.status === 'activated'
          && JSON.parse(session.stateJson).runtime.consolationRevealAcknowledged !== true) continue;
      }
      const lifetime = row.rules_json ? JSON.parse(row.rules_json).reportMs ?? REPORT_LIFETIME : REPORT_LIFETIME;
      // Never remove a still-active roll merely because reporting expired.
      if (row.state === 'pending' || (row.state === 'open' && row.expires_at > now)) continue;
      if (row.state !== 'failed' && ![row.published_at, row.escape_resolved_at, row.mystery_resolved_at]
        .some((time) => time != null && time < now - lifetime)) continue;
      db.prepare('DELETE FROM roll_notices WHERE roll_id=?').run(row.id);
      removed += db.prepare('DELETE FROM character_rolls WHERE id=?').run(row.id).changes;
    }
    return removed;
  });
}
