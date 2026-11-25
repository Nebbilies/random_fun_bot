import { transaction } from "../../lib/catalogDb.js";
import { getGameConfig } from "../../lib/gameConfig.js";
import { withOwnershipOperationClock } from "../../lib/characterOwnershipHistory.js";
import {
  hasAffection,
  getAffectionBenefits,
  completeAppearanceInTransaction,
  cancelAppearanceInTransaction,
  earnReclaimInTransaction,
  earnRollerReclaimInTransaction,
} from "../../lib/characterAffection.js";
import { resolveAffectionDecisionInTransaction } from "../../lib/affectionPerks.js";
import { getResolvedItemDefinitions } from "../../lib/itemRoster.js";
import { loadValidatedRollAffection } from "../../lib/affectionRollCapture.js";
import { isCharacterReserved } from "../../lib/characterAvailability.js";
import {
  divorceCharacter,
  getMarriage,
  marryCharacter,
} from "../../lib/characterMarriage.js";
import { getActiveBuffs, consumeBuffRoll } from "../../lib/itemStorage.js";
import { characterSnapshotFromState } from "../../lib/characterSnapshot.js";
import {
  getMysterySession,
  finishMystery,
} from "../../lib/mysterySessionState.js";
import {
  getClaimAvailability,
  claimPeriod,
  claimCooldownEnd,
  buffRules,
} from "./rollAllowanceService.js";
import { recordClaimUsage } from "./rollAllowanceRepository.js";
import { loadRollCharacterSnapshot } from "./rollSnapshot.js";
import {
  readPendingPublication,
  cancelRollPublication,
  publishPendingRoll,
  readRollSession,
  failActiveRoll,
  readRoll,
  closeEscapeRoll,
  rollCharacterExists,
  readRollSchemaVersion,
  readMysteryClaimState,
  closeCharacterRolls,
  initializeDoubleDateClaims,
  insertClaimNotice,
} from "./rollLifecycleRepository.js";

const REPORT_LIFETIME = 3_600_000;

function validId(id) {
  return typeof id === "string" && /^\d+$/.test(id);
}

function validNow(now) {
  return Number.isSafeInteger(now) && now >= 0;
}

export function publishRoll(db, rollId, messageId, now = Date.now()) {
  if (!Number.isSafeInteger(rollId) || !validId(messageId) || !validNow(now))
    throw new Error("Invalid roll publication");
  return transaction(db, () => {
    const roll = readPendingPublication(db, rollId);
    if (!roll) return false;
    loadRollCharacterSnapshot(db, rollId);
    const capturedAffection = loadValidatedRollAffection(db, rollId);
    const windows = roll.rulesJson
      ? JSON.parse(roll.rulesJson)
      : getGameConfig(db, roll.guildId).windows;
    if (
      isCharacterReserved(db, roll.guildId, roll.characterId) ||
      (roll.escapeMarriageId && !originalMarriageExists(db, roll))
    ) {
      cancelRollPublication(db, rollId, messageId, now);
      if (windows.affectionSourceKey && hasAffection(db))
        cancelAppearanceInTransaction(db, windows.affectionSourceKey, now);
      return false;
    }
    const published = publishPendingRoll(
      db,
      rollId,
      messageId,
      windows.ownAppearance ? "closed" : "open",
      now,
      roll.escapeMarriageId ? now + windows.escapeProtectionMs : null,
      now +
        (roll.escapeMarriageId
          ? windows.escapeProtectionMs + windows.escapeClaimMs
          : windows.claimMs),
    );
    if (published && capturedAffection)
      completeAppearanceInTransaction(db, {
        sourceKey: capturedAffection.sourceKey,
        now,
        rewardRoster: getResolvedItemDefinitions(db, roll.guildId),
      });
    return published;
  });
}

export function failRoll(db, rollId) {
  if (!Number.isSafeInteger(rollId)) throw new Error("Invalid roll");
  return transaction(db, () => {
    const roll = readRollSession(db, rollId);
    const failed = failActiveRoll(db, rollId, Date.now());
    if (failed && roll?.sessionId)
      finishMystery(db, roll.sessionId, "failed", Date.now());
    return failed;
  });
}

export function getRoll(db, guildId, channelId, messageId) {
  if (![guildId, channelId, messageId].every(validId)) return null;
  return readRoll(db, guildId, channelId, messageId);
}

function originalMarriageExists(db, roll) {
  const marriage = getMarriage(db, roll.guildId, roll.characterId);
  return (
    marriage?.id === roll.escapeMarriageId &&
    marriage?.ownerId === roll.escapeOwnerId
  );
}

function closeEscape(db, roll, outcome, now, winnerId = null) {
  closeEscapeRoll(db, roll.id, outcome, now, winnerId);
}

function settleEscape(db, roll, now) {
  if (!roll?.escapeMarriageId || roll.state !== "open") return;
  if (
    !originalMarriageExists(db, roll) ||
    !rollCharacterExists(db, roll.characterId)
  ) {
    closeEscape(db, roll, "canceled", now);
  } else if (now >= roll.expiresAt) {
    closeEscape(db, roll, "expired", now);
  }
}

export function refreshEscapeRoll(
  db,
  guildId,
  channelId,
  messageId,
  now = Date.now(),
) {
  if (!validNow(now)) throw new Error("Invalid escape time");
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
export function claimRollInTransaction(
  db,
  {
    guildId,
    channelId,
    messageId,
    userId,
    now = Date.now(),
    random = Math.random,
  },
) {
  if (![guildId, channelId, messageId, userId].every(validId) || !validNow(now))
    throw new Error("Invalid claim");
  return (() => {
    const roll = getRoll(db, guildId, channelId, messageId);
    if (!roll) return { status: "unknown" };
    if (roll.state !== "open") return { status: "closed" };
    loadRollCharacterSnapshot(db, roll.id);
    if (
      readRollSchemaVersion(db) === 12 &&
      (!Number.isSafeInteger(roll.publishedAt) ||
        !Number.isSafeInteger(roll.expiresAt) ||
        roll.expiresAt <= roll.publishedAt)
    )
      throw new Error("Invalid durable claim deadline");
    if (isCharacterReserved(db, guildId, roll.characterId))
      return { status: "closed" };
    if (roll.escapeMarriageId) {
      settleEscape(db, roll, now);
      if (getRoll(db, guildId, channelId, messageId).state !== "open") {
        return { status: now >= roll.expiresAt ? "expired" : "closed" };
      }
      if (userId === roll.escapeOwnerId) {
        const captured = hasAffection(db)
          ? loadValidatedRollAffection(db, roll.id)
          : null;
        if (
          captured?.terms.soulmateReclaimVersion === 1 &&
          (captured.context.state !== "completed" ||
            captured.request.user_id === userId ||
            captured.outcome.ownAppearance !== false)
        ) {
          throw new Error("Invalid completed roller reclaim origin");
        }
        closeEscape(db, roll, "reclaimed", now, userId);
        closeCharacterRolls(db, guildId, roll.characterId);
        const affection = hasAffection(db)
          ? earnReclaimInTransaction(db, {
              sourceKey: `reclaim:${guildId}:${roll.commandMessageId ?? roll.id}`,
              guildId,
              channelId,
              userId,
              characterId: roll.characterId,
              now,
              random,
              rewardRoster: getResolvedItemDefinitions(db, guildId),
            })
          : null;
        if (affection && captured?.terms.soulmateReclaimVersion === 1)
          affection.awards.push(
            ...earnRollerReclaimInTransaction(db, {
              sourceKey: `reclaim:${guildId}:${roll.commandMessageId}`,
              guildId,
              channelId,
              userId: captured.request.user_id,
              now,
              random,
              rewardRoster: getResolvedItemDefinitions(db, guildId),
            }).awards,
          );
        return {
          status: "reclaimed",
          characterName: roll.characterName,
          characterId: roll.characterId,
          affection,
        };
      }
      if (now < roll.protectedUntil) return { status: "protected" };
    }
    if (now >= roll.expiresAt) return { status: "expired" };
    if (roll.mysterySessionId) {
      const session = readMysteryClaimState(db, roll.mysterySessionId, guildId);
      if (session?.state !== "claim_open") return { status: "closed" };
      const mystery = getMysterySession(db, roll.mysterySessionId);
      characterSnapshotFromState(
        JSON.parse(mystery.stateJson || "null"),
        mystery.characterId,
        mystery.rankSnapshot,
      );
      if (mystery.characterId !== roll.characterId)
        throw new Error("Mystery origin roll identity mismatch");
      if (!roll.exclusiveUserId || roll.exclusiveUserId !== userId)
        return { status: "protected" };
    }
    if (!roll.escapeMarriageId && getMarriage(db, guildId, roll.characterId)) {
      closeCharacterRolls(db, guildId, roll.characterId);
      if (roll.mysterySessionId)
        finishMystery(db, roll.mysterySessionId, "unavailable", now);
      return { status: "closed" };
    }
    const period = claimPeriod(db, guildId, now);
    const claimBuffs = getActiveBuffs(db, guildId, userId, now);
    const crownBuff = claimBuffs.find(
      (b) => b.buff_id === "crown_of_the_sovereign",
    );
    const doubleDateBuff = claimBuffs.find((b) => b.buff_id === "double_date");
    const tokenBuff = claimBuffs.find(
      (b) => b.buff_id === "pinata_claim_token",
    );
    const ringBuff = claimBuffs.find((b) => b.buff_id === "engagement_ring");
    const cooldownEnd = claimCooldownEnd(db, guildId, userId, now, ringBuff);
    if (!getClaimAvailability(db, guildId, userId, now).canClaim)
      return { status: "exhausted", resetAt: cooldownEnd, rollId: roll.id };
    const normalSelected = !doubleDateBuff && cooldownEnd === null;
    const ringNeeded =
      normalSelected &&
      Boolean(ringBuff) &&
      claimCooldownEnd(db, guildId, userId, now, false) !== null;
    const claimConserved =
      hasAffection(db) &&
      resolveAffectionDecisionInTransaction(db, {
        sourceKey: `marriage:${guildId}:${roll.commandMessageId ?? roll.id}`,
        guildId,
        userId,
        effect: "claim_conservation",
        chance: getAffectionBenefits(db, guildId, userId).perks
          .claim_conservation,
        now,
        random,
      }).triggered;
    if (
      roll.escapeMarriageId &&
      !withOwnershipOperationClock(db, now, () =>
        divorceCharacter(
          db,
          guildId,
          roll.characterId,
          roll.escapeOwnerId,
          roll.escapeMarriageId,
          now,
        ),
      )
    )
      throw new Error("Escape marriage changed during transfer");
    const result = marryCharacter(db, guildId, roll.characterId, userId);
    if (result.status !== "married") {
      if (roll.escapeMarriageId)
        throw new Error("Escape marriage transfer failed");
      if (
        result.status === "already_owned" ||
        result.status === "already_yours"
      ) {
        closeCharacterRolls(db, guildId, roll.characterId);
        if (roll.mysterySessionId)
          finishMystery(db, roll.mysterySessionId, "unavailable", now);
      }
      return { status: "closed" };
    }
    if (claimConserved) {
      // Preserve exactly the planned resource, including an enabling Ring use.
    } else if (doubleDateBuff) {
      // Pre-hotfix timed buffs had no counter. Give a retained legacy buff its
      // bounded entitlement on the first successful claim, never on inspection.
      if (doubleDateBuff.remaining_rolls === null) {
        initializeDoubleDateClaims(
          db,
          doubleDateBuff.id,
          buffRules(doubleDateBuff).freeClaims ?? 2,
        );
      }
      consumeBuffRoll(db, doubleDateBuff.id);
    } else if (normalSelected) {
      recordClaimUsage(db, guildId, userId, period, now);
      // The ring only pays for a claim it actually shortened.
      if (ringNeeded) consumeBuffRoll(db, ringBuff.id);
    } else if (crownBuff) {
      consumeBuffRoll(db, crownBuff.id);
    } else if (tokenBuff) {
      consumeBuffRoll(db, tokenBuff.id);
    }
    if (roll.escapeMarriageId) closeEscape(db, roll, "married", now, userId);
    closeCharacterRolls(db, guildId, roll.characterId);
    if (roll.mysterySessionId)
      finishMystery(db, roll.mysterySessionId, "claimed", now);
    return {
      status: "married",
      characterName: roll.characterName,
      characterId: roll.characterId,
      ...(claimConserved ? { claimConserved: true } : {}),
    };
  })();
}

export function markClaimNotice(db, rollId, userId) {
  if (!Number.isSafeInteger(rollId) || !validId(userId))
    throw new Error("Invalid claim notice");
  return insertClaimNotice(db, rollId, userId);
}

export function getReportableRoll(
  db,
  guildId,
  channelId,
  messageId,
  now = Date.now(),
) {
  const roll = getRoll(db, guildId, channelId, messageId);
  const lifetime = roll?.rulesJson
    ? (JSON.parse(roll.rulesJson).reportMs ?? REPORT_LIFETIME)
    : REPORT_LIFETIME;
  return roll?.publishedAt != null && now < roll.publishedAt + lifetime
    ? roll
    : null;
}
