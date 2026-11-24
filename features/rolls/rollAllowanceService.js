import { getGameConfig } from '../../lib/gameConfig.js';
import { hasAffection, getAffectionBenefits } from '../../lib/characterAffection.js';
import { getActiveBuffs } from '../../lib/itemStorage.js';
import { transaction } from '../../lib/catalogDb.js';
import { claimResetBoundary, guildsAtCutoff } from '../seasons/seasonStore.js';
import { readRollAllowance, writeRollAllowance, updateUsedRollAllowances, writeMaxRolls,
  clearClaimUsage, readDailyClaim, writeDailyClaim, readClaimAllowance, readClaimEvent, readClaimBuffs } from './rollAllowanceRepository.js';

const DAY = 86_400_000;
const VIETNAM_OFFSET = 7 * 3_600_000;

// Transaction-neutral helpers are shared with the roll lifecycle; do not import its compatibility module.
function schedule(db, guildId) { return getGameConfig(db, guildId).schedules; }
function bucket(now, interval, offsetMinutes) { return Math.floor((now + offsetMinutes * 60_000) / interval); }
function resetAt(now, interval, offsetMinutes) { return (bucket(now, interval, offsetMinutes) + 1) * interval - offsetMinutes * 60_000; }
export function rollPeriod(db, guildId, now) { const s = schedule(db, guildId); return Math.floor((now + (s.timezoneOffsetMinutes * 60_000) % s.rollIntervalMs) / s.rollIntervalMs); }
export function claimPeriod(db, guildId, now) { const s = schedule(db, guildId); return bucket(now, s.claimIntervalMs, s.timezoneOffsetMinutes); }
export function buffRules(buff) { try { return JSON.parse(buff?.data_json ?? '{}') ?? {}; } catch { return {}; } }

/** @param {any} [db] @param {string | null} [guildId] */
export function nextRollReset(now, db = null, guildId = null) {
  const s = schedule(db, guildId);
  return resetAt(now, s.rollIntervalMs, s.timezoneOffsetMinutes);
}
/** @param {any} [db] @param {string | null} [guildId] */
export function nextClaimReset(now, db = null, guildId = null) {
  return claimResetBoundary(now,schedule(db,guildId));
}
export function getMaxRolls(db, guildId) { return getGameConfig(db, guildId).rolls.maxRolls; }

export function setMaxRolls(db, guildId, amount) {
  if (!validId(guildId) || !Number.isSafeInteger(amount) || amount < 1) {
    throw new Error('Invalid roll maximum');
  }
  writeMaxRolls(db, guildId, amount);
}

export function getRollStatus(db, guildId, userId, now = Date.now()) {
  if (![guildId, userId].every(validId) || !validNow(now)) throw new Error('Invalid roll status');
  const period = rollPeriod(db, guildId, now);
  const allowance = readRollAllowance(db, guildId, userId);
  const used = allowance?.period === period ? allowance.used : 0;
  const capacity = rollCapacity(db, guildId, userId, now);
  return { remaining: Math.max(0, capacity - used), resetAt: nextRollReset(now, db, guildId) };
}

/** Adrenaline Rush doubles the hourly allowance while its buff is live. */
export function rollCapacity(db, guildId, userId, now) {
  const base = getMaxRolls(db, guildId);
  const buff = getActiveBuffs(db, guildId, userId, now).find((entry) => entry.buff_id === 'adrenaline_rush');
  const bonus = hasAffection(db) ? getAffectionBenefits(db, guildId, userId).rollBonus : 0;
  return (buff ? Math.floor(base * (buffRules(buff).allowanceMultiplier ?? 2)) : base) + bonus;
}

/** @param {any} db @param {unknown} amount @param {number} [now] */
export function addGlobalRolls(db, amount, now) {
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 1 || (now !== undefined && !validNow(now))) {
    throw new Error('Invalid roll amount');
  }
  return transaction(db, () => {
    const time = now ?? Date.now();
    const skippedGuilds = guildsAtCutoff(db,time);
    const updated = updateUsedRollAllowances(db, row => {
      if (skippedGuilds.includes(row.guild_id)) return null;
      if (row.period !== rollPeriod(db, row.guild_id, time)) return null;
      return Math.max(0, Math.min(row.used, rollCapacity(db, row.guild_id, row.user_id, time)) - amount);
    });
    return skippedGuilds.length ? { updated, skippedGuilds } : { updated };
  });
}

export function resetGlobalClaims(db) {
  return transaction(db, () => {
    const skippedGuilds = guildsAtCutoff(db);
    const updated = clearClaimUsage(db,skippedGuilds);
    return skippedGuilds.length ? { updated, skippedGuilds } : { updated };
  });
}

export function claimDailyRolls(db, guildId, userId, now = Date.now()) {
  if (![guildId, userId].every(validId) || !validNow(now)) throw new Error('Invalid daily roll claim');
  const s = schedule(db, guildId);
  const period = bucket(now, s.dailyIntervalMs, s.timezoneOffsetMinutes);
  const nextReset = resetAt(now, s.dailyIntervalMs, s.timezoneOffsetMinutes);
  return transaction(db, () => {
    const previous = readDailyClaim(db, guildId, userId);
    const previousReset = previous?.reset_at ?? (previous ? (previous.period + 1) * DAY - VIETNAM_OFFSET : 0);
    if (previous && now < previousReset) return { status: 'claimed', resetAt: previousReset };
    writeDailyClaim(db, guildId, userId, period, nextReset);
    writeRollAllowance(db, guildId, userId, rollPeriod(db, guildId, now), 0);
    return { status: 'refilled', remaining: getRollStatus(db, guildId, userId, now).remaining, resetAt: nextReset };
  });
}

export function getClaimStatus(db, guildId, userId, now = Date.now()) {
  if (![guildId, userId].every(validId) || !validNow(now)) throw new Error('Invalid claim status');
  const ringActive = readClaimBuffs(db, guildId, userId, now)
    .find((buff) => buff.buff_id === 'engagement_ring');
  const cooldownEnd = claimCooldownEnd(db, guildId, userId, now, ringActive);
  return { canClaim: cooldownEnd === null, resetAt: cooldownEnd ?? nextClaimReset(now, db, guildId) };
}

/** Read-only eligibility, including usable bypass tokens; never consumes a buff. */
export function getClaimAvailability(db, guildId, userId, now = Date.now()) {
  if (![guildId, userId].every(validId) || !validNow(now)) throw new Error('Invalid claim status');
  // getActiveBuffs prunes expired rows. Eligibility inspection must be truly read-only.
  const buffs = readClaimBuffs(db, guildId, userId, now);
  const end = claimCooldownEnd(db, guildId, userId, now,
    buffs.find(buff => buff.buff_id === 'engagement_ring'));
  const bypass = buffs.some(buff => ['double_date', 'crown_of_the_sovereign', 'pinata_claim_token'].includes(buff.buff_id));
  return { canClaim: end === null || bypass, resetAt: end ?? nextClaimReset(now, db, guildId) };
}

/** Claim cooldowns are bucket based, so buffs must be able to shorten the current bucket. */
export function claimCooldownEnd(db, guildId, userId, now, ringActive = false) {
  const period = claimPeriod(db, guildId, now);
  const allowance = readClaimAllowance(db, guildId, userId);
  // A fresh claim bucket is always free, no matter what happened in the previous one.
  if (allowance?.period !== period) return null;
  const claimed = readClaimEvent(db, guildId, userId);
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
