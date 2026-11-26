import { currentSeasonRows } from "./seasonSchema.js";
import { assertSeasonWritable } from "../features/seasons/seasonStore.js";
export {
  publishRoll,
  failRoll,
  claimRoll,
  claimRollInTransaction,
  refreshEscapeRoll,
  getRoll,
  markClaimNotice,
  getReportableRoll,
} from "../features/rolls/rollLifecycleService.js";
import { hasRollCharacterSnapshot } from "../features/rolls/rollLifecycleRepository.js";
import { loadRollCharacterSnapshot } from "../features/rolls/rollSnapshot.js";
export { loadRollCharacterSnapshot } from "../features/rolls/rollSnapshot.js";
import { getMysterySession, finishMystery } from "./mysterySessionState.js";
export { getMysterySession } from "./mysterySessionState.js";
import {
  readRollAllowance,
  writeRollAllowance,
  refundRollAllowance,
} from "../features/rolls/rollAllowanceRepository.js";
import {
  nextRollReset,
  getRollStatus,
  getClaimAvailability,
  rollPeriod,
  rollCapacity,
  buffRules,
} from "../features/rolls/rollAllowanceService.js";
export {
  nextRollReset,
  nextClaimReset,
  getMaxRolls,
  setMaxRolls,
  getRollStatus,
  addGlobalRolls,
  resetGlobalClaims,
  claimDailyRolls,
  getClaimStatus,
  getClaimAvailability,
} from "../features/rolls/rollAllowanceService.js";
import {
  hasAffection,
  getAffectionBenefits,
  captureAppearanceInTransaction,
  awardResult,
} from "./characterAffection.js";
import { resolveAffectionDecisionInTransaction } from "./affectionPerks.js";
import { resolveSoulmateNegation } from "./itemDefense.js";
import { spendAffectionItemChargeInTransaction } from "./affectionItemUse.js";
import { getResolvedItemDefinitions } from "./itemRoster.js";

export function getRollAffectionFeedback(db, rollId) {
  if (!hasAffection(db)) return [];
  const roll = db
    .prepare("SELECT * FROM character_rolls WHERE id=?")
    .get(rollId);
  const terms = roll?.rules_json ? JSON.parse(roll.rules_json) : {};
  if (!roll) return [];
  const reclaimKey = `reclaim:${roll.guild_id}:${roll.command_message_id ?? roll.id}`;
  return db
    .prepare(
      `SELECT a.*,
    COALESCE(c.name_full,i.name_full,'Character') name FROM affection_awards a
    JOIN character_identities i ON i.id=a.character_id LEFT JOIN characters c ON c.id=a.character_id WHERE a.source_key IN (?,?) ORDER BY a.rowid`,
    )
    .all(terms.affectionSourceKey ?? "", reclaimKey)
    .map((row) => ({ ...awardResult(row), name: row.name }));
}
import {
  resolveMysteryConsolation,
  inspectMysteryConsolation,
} from "./mysteryConsolation.js";
import { hydrateCharacterMainFranchises } from "./characterSeries.js";
import { getGameConfig } from "./gameConfig.js";
import { captureRollDelivery } from "../features/rolls/rollDeliveryCapture.js";
import { hasVaultSessions, reservePaidVaultSession } from "./vaultSessions.js";
import { requireNewGameAction } from "./catalogMaintenance.js";
import {
  captureCharacterSnapshot,
  characterSnapshotFromState,
  retainCharacterSnapshot,
} from "./characterSnapshot.js";
import { transaction } from "./catalogDb.js";
import { inspectLegacyVaultAbandonment } from "./legacyVaultAbandonment.js";
import { characterLikesProjection } from "./characterLikesProjection.js";
import { characterMainFranchiseRelation } from "./characterFranchises.js";
import {
  isCharacterBusy,
  isCharacterPendingTransfer,
  isCharacterReserved,
} from "./characterAvailability.js";
import { divorceCharacter, getMarriage } from "./characterMarriage.js";
import { passesMysteryGate } from "./mysteryOdds.js";
import { passesVaultGate } from "./vaultRolls.js";
import { getGuildRates } from "./guildRates.js";
import {
  getUsableInventory,
  getActiveBuffs,
  getGuildBuffs,
  consumeBuffRoll,
} from "./itemStorage.js";
import { rollGenderSql } from "./rollCandidatePools.js";

const HOUR = 3_600_000;
const CLAIM_PERIOD = 3 * HOUR;
const DEFAULT_MAX_ROLLS = 7;
const WINDOW = 60_000;
const REPORT_LIFETIME = HOUR;
const ACTIVE_MYSTERY = "('reserved', 'running', 'countdown', 'claim_open')";
const CANDIDATE_DRAW_LIMIT = 8;

function validId(id) {
  return typeof id === "string" && /^\d+$/.test(id);
}

function validNow(now) {
  return Number.isSafeInteger(now) && now >= 0;
}

const eligible = `FROM characters AS c WHERE NOT EXISTS
  (SELECT 1 FROM character_rolls AS r WHERE r.guild_id = ? AND r.character_id = c.id
    AND (r.state = 'pending' OR (r.state = 'open' AND r.expires_at > ?)))
  AND NOT EXISTS (SELECT 1 FROM character_protection_locks AS l
    WHERE l.guild_id = ? AND l.character_id = c.id
      AND l.lock_type = 'soulbind' AND (l.protected_until IS NULL OR l.protected_until > ?))
  AND (${rollGenderSql} NOT IN ('female', 'male') OR ${rollGenderSql} = ?)`;

function drawIndex(random, count) {
  const fraction = random();
  if (!Number.isFinite(fraction) || fraction < 0 || fraction >= 1)
    throw new Error("Invalid random value");
  return Math.floor(fraction * count);
}

/** @param {{guildId: string, channelId: string, commandMessageId: string, userId: string,
 *   pool: string, now?: number, random?: () => number, prankEnabled?: boolean, vaultEnabled?: boolean,
 *   gameConfig?: ReturnType<typeof getGameConfig>, getRollPool?: import('./rollCandidatePools.js').GetRollCandidatePool,
 *   mystery?: {eventChannelId: string, selectEvent: (context: any) => any} | null}} request */
export function reserveRoll(db, request) {
  requireNewGameAction(db);
  const {
    guildId,
    channelId,
    commandMessageId,
    userId,
    pool,
    now = Date.now(),
    random = Math.random,
    mystery = null,
  } = request;
  if (
    ![guildId, channelId, commandMessageId, userId].every(validId) ||
    !["w", "h"].includes(pool) ||
    !validNow(now) ||
    (mystery &&
      (!validId(mystery.eventChannelId) ||
        typeof mystery.selectEvent !== "function"))
  ) {
    throw new Error("Invalid roll request");
  }
  return transaction(db, () => {
    assertSeasonWritable(db, guildId, { now });
    const sourceKey = `roll:${guildId}:${commandMessageId}`;
    const affectionEnabled = hasAffection(db);
    if (affectionEnabled) {
      const saved = db
        .prepare("SELECT * FROM affection_requests WHERE source_key=?")
        .get(sourceKey);
      if (saved) {
        if (
          saved.guild_id !== guildId ||
          saved.user_id !== userId ||
          saved.channel_id !== channelId
        )
          throw new Error("Roll invocation scope mismatch");
        return { ...JSON.parse(saved.outcome_json), status: "duplicate" };
      }
    }
    const previous = db
      .prepare("SELECT id FROM character_rolls WHERE command_message_id = ?")
      .get(commandMessageId);
    if (previous) return { status: "duplicate", rollId: previous.id };
    if (
      db
        .prepare(
          `SELECT 1 FROM mystery_sessions WHERE guild_id = ? AND state IN ${ACTIVE_MYSTERY} LIMIT 1`,
        )
        .get(guildId)
    )
      return { status: "paused" };
    const period = rollPeriod(db, guildId, now);
    const allowance = readRollAllowance(db, guildId, userId);
    const used = allowance?.period === period ? allowance.used : 0;
    const maxRolls = rollCapacity(db, guildId, userId, now);
    if (used >= maxRolls)
      return { status: "exhausted", resetAt: nextRollReset(now, db, guildId) };
    const windfallChance = affectionEnabled
      ? getAffectionBenefits(db, guildId, userId).perks.windfall
      : 0;
    const debit = () => {
      const free =
        affectionEnabled &&
        resolveAffectionDecisionInTransaction(db, {
          sourceKey,
          guildId,
          userId,
          effect: "windfall",
          chance: windfallChance,
          now,
          random,
        }).triggered;
      const current = readRollAllowance(db, guildId, userId);
      const nextUsed =
        (current?.period === period ? current.used : 0) + (free ? 0 : 1);
      writeRollAllowance(db, guildId, userId, period, nextUsed);
      return Math.max(0, maxRolls - nextUsed);
    };
    const saveRequest = (result) => {
      if (affectionEnabled)
        db.prepare("INSERT INTO affection_requests VALUES(?,?,?,?,?,?)").run(
          sourceKey,
          guildId,
          userId,
          channelId,
          JSON.stringify(result),
          now,
        );
      return result;
    };
    const rates = getGuildRates(db, guildId);
    if (request.prankEnabled && rates.prankRate > 0) {
      const draw = random();
      if (!Number.isFinite(draw) || draw < 0 || draw >= 1)
        throw new Error("Invalid random value");
      if (draw < rates.prankRate) {
        // Split the prank interval equally between the prank variants
        const halfRate = rates.prankRate / 2;
        const prank = draw < halfRate ? "dog_clap" : "john_pork";
        const remaining = debit();
        db.prepare(
          `INSERT INTO character_rolls
          (guild_id, channel_id, command_message_id, character_id, character_name, state, published_at)
          VALUES (?, ?, ?, 0, ?, 'prank', ?)`,
        ).run(guildId, channelId, commandMessageId, prank, now);
        return saveRequest({ status: "prank", prank, remaining });
      }
    }
    const rules = request.gameConfig ?? getGameConfig(db, guildId);
    if (request.vaultEnabled && rules.vault.enabled && rates.vaultRate > 0) {
      if (passesVaultGate(random, rates.vaultRate)) {
        const remaining = debit();
        db.prepare(
          `INSERT INTO character_rolls
          (guild_id, channel_id, command_message_id, character_id, character_name, state, published_at)
          VALUES (?, ?, ?, 0, 'vault', 'vault', ?)`,
        ).run(guildId, channelId, commandMessageId, now);
        if (hasVaultSessions(db))
          reservePaidVaultSession(db, {
            guildId,
            userId,
            channelId,
            commandMessageId,
            paidRollId: commandMessageId,
            remaining,
            now,
            gameConfig: rules,
          });
        return saveRequest({ status: "vault", remaining });
      }
    }
    const gender = pool === "w" ? "female" : "male";
    const activeBuffs = getActiveBuffs(db, guildId, userId, now);
    const guildBuffs = getGuildBuffs(db, guildId, now);
    const passportBuff = activeBuffs.find(
      (b) => b.buff_id === "franchise_passport",
    );
    const cloverBuff = activeBuffs.find(
      (b) => b.buff_id === "four_leaf_clover",
    );
    const feverBuff = activeBuffs.find((b) => b.buff_id === "rolling_fever");
    const pinataBuff = guildBuffs.find((b) => b.buff_id === "pinata");

    let buffClause = "";
    let buffParams = [];
    let passportApplied = false;
    let cloverApplied = false;
    if (passportBuff?.data_json) {
      try {
        const parsed = JSON.parse(passportBuff.data_json);
        if (parsed.franchiseId) {
          buffClause = ` AND EXISTS (
            SELECT 1 FROM ${characterMainFranchiseRelation(db)} AS membership
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
      buffClause = " AND c.rank <= ?";
      buffParams.push(effect.maxRank ?? 1500);
    }

    const playerEligible = affectionEnabled
      ? eligible.replace(
          "AND (l.protected_until IS NULL OR l.protected_until > ?))",
          "AND (l.protected_until IS NULL OR l.protected_until > ?) AND NOT EXISTS (SELECT 1 FROM marriages own WHERE own.guild_id=l.guild_id AND own.character_id=c.id AND own.owner_id=?))",
        )
      : eligible;
    const baseParams = affectionEnabled
      ? [guildId, now, guildId, now, userId, gender]
      : [guildId, now, guildId, now, gender];
    let queryEligible = `${playerEligible}${buffClause}`;
    let queryParams = [...baseParams, ...buffParams];
    const selection = () => `SELECT c.id ${queryEligible}
      AND NOT EXISTS (SELECT 1 FROM item_character_reservations AS reservation
        WHERE reservation.guild_id = ? AND reservation.character_id = c.id)`;
    const available = () =>
      db
        .prepare(`${selection()} ORDER BY c.id`)
        .all(...queryParams, guildId)
        .filter((row) => !isCharacterPendingTransfer(db, guildId, row.id, now));
    const constraint = passportApplied
      ? { franchiseId: buffParams[0] }
      : buffClause
        ? { maxRank: buffParams[0] }
        : undefined;
    const staticPool = request.getRollPool?.(pool, constraint);
    let candidateId;
    if (staticPool?.count) {
      const check = db.prepare(`${selection()} AND c.id = ?`);
      for (let attempt = 0; attempt < CANDIDATE_DRAW_LIMIT; attempt++) {
        const id = staticPool.ids[drawIndex(random, staticPool.count)];
        if (
          check.get(...queryParams, guildId, id) &&
          !isCharacterPendingTransfer(db, guildId, id, now)
        ) {
          candidateId = id;
          break;
        }
      }
    }

    if (candidateId === undefined) {
      let candidates = available();
      // Confirm the constrained pool is empty before removing the buff filter.
      if (!candidates.length && buffClause) {
        queryEligible = playerEligible;
        queryParams = baseParams;
        passportApplied = false;
        cloverApplied = false;
        candidates = available();
      }
      if (!candidates.length) return { status: "empty" };
      candidateId = candidates[drawIndex(random, candidates.length)].id;
    }
    const character = db
      .prepare(
        `SELECT c.id, c.name_full, c.rank, c.favourites, ${characterLikesProjection(db, "c")}, c.image_url, c.anime_titles, c.gender,
      (SELECT tag_name FROM tag_decisions WHERE character_id = c.id AND status = 'approve') AS tag_name
      ${queryEligible} AND c.id = ?`,
      )
      .get(...queryParams, candidateId);

    hydrateCharacterMainFranchises(db, [character]);
    const characterSnapshot = captureCharacterSnapshot(character);
    if (affectionEnabled)
      captureAppearanceInTransaction(db, {
        sourceKey,
        guildId,
        channelId,
        userId,
        characterId: character.id,
        now,
        random,
      });
    if (passportApplied) consumeBuffRoll(db, passportBuff.id);
    if (cloverApplied) consumeBuffRoll(db, cloverBuff.id);
    if (pinataBuff && !passportApplied && !cloverApplied)
      consumeBuffRoll(db, pinataBuff.id);
    if (feverBuff) {
      consumeBuffRoll(db, feverBuff.id);
      const effect = buffRules(feverBuff);
      if (character && character.rank <= (effect.maxRank ?? 1500)) {
        refundRollAllowance(
          db,
          guildId,
          userId,
          period,
          effect.refundRolls ?? 2,
        );
      }
    }
    let marriage = getMarriage(db, guildId, character.id);
    const ownAppearance = affectionEnabled && marriage?.ownerId === userId;
    let cupidsMisfire = null;
    const misfire = activeBuffs.find(
      (buff) => buff.buff_id === "cupids_misfire",
    );
    if (
      misfire &&
      marriage &&
      !ownAppearance &&
      !isCharacterBusy(db, guildId, character.id, now)
    ) {
      // All reads, ownership cleanup, defense/effect costs and roll persistence
      // share this write transaction. Never redirect via Crown or consult theft locks.
      const attackKey = `misfire:${sourceKey}`;
      const negated =
        marriage.ownerId !== userId &&
        resolveSoulmateNegation(db, {
          sourceKey: attackKey,
          guildId,
          ownerId: marriage.ownerId,
          now,
          random,
        }).triggered;
      const shield =
        negated || marriage.ownerId === userId
          ? null
          : getUsableInventory(db, guildId, marriage.ownerId, now).find(
              (item) => item.item_id === "mirror_shield",
            );
      cupidsMisfire = {
        version: 1,
        result: negated ? "negated" : shield ? "blocked" : "divorced",
        characterId: character.id,
        formerOwnerId: marriage.ownerId,
        marriageId: marriage.id,
      };
      if (negated) {
        // The armed attack is exhausted below, but natural escape behavior remains.
      } else if (shield) {
        spendAffectionItemChargeInTransaction(db, {
          sourceKey: attackKey,
          guildId,
          userId: marriage.ownerId,
          inventoryId: shield.id,
          now,
          random,
        });
      } else {
        if (
          !divorceCharacter(
            db,
            guildId,
            character.id,
            marriage.ownerId,
            marriage.id,
            now,
          )
        ) {
          throw new Error("Cupid's Misfire marriage changed during commitment");
        }
        marriage = null;
      }
      db.prepare("DELETE FROM active_user_buffs WHERE id=?").run(misfire.id);
    }
    let selectedEvent = null;
    if (
      !cupidsMisfire &&
      !marriage &&
      mystery &&
      rules.mystery.enabled &&
      passesMysteryGate(character.rank, random, rules.mystery.oddsAnchors)
    ) {
      selectedEvent = mystery.selectEvent({
        db,
        character,
        guildId,
        userId,
        now,
        random,
      });
      // No eligible event (for example Clue Reveal in a manual-only catalog)
      // leaves this as an ordinary roll, with the already-applied buffs counted once.
      if (
        selectedEvent &&
        (typeof selectedEvent.eventId !== "string" ||
          !selectedEvent.eventId.trim() ||
          !Number.isSafeInteger(selectedEvent.durationMs) ||
          selectedEvent.durationMs <= 0 ||
          !Number.isSafeInteger(now + selectedEvent.durationMs))
      )
        throw new Error("Invalid mystery event");
    }
    const remaining = debit();
    const result = db
      .prepare(
        `INSERT INTO character_rolls
      (guild_id, channel_id, command_message_id, character_id, character_name, state,
        escape_marriage_id, escape_owner_id)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        guildId,
        selectedEvent ? mystery?.eventChannelId : channelId,
        commandMessageId,
        characterSnapshot.id,
        characterSnapshot.name_full,
        ownAppearance ? null : (marriage?.id ?? null),
        ownAppearance ? null : (marriage?.ownerId ?? null),
      );
    const rollId = Number(result.lastInsertRowid);
    // Outcome is an immutable extension of the existing durable roll terms;
    // no inference from mutable ownership is needed for delivery or recovery.
    db.prepare("UPDATE character_rolls SET rules_json=? WHERE id=?").run(
      JSON.stringify({
        ...rules.windows,
        ...(affectionEnabled
          ? { affectionVersion: 1, affectionSourceKey: sourceKey }
          : {}),
        ...(affectionEnabled && !selectedEvent
          ? { soulmateReclaimVersion: 1 }
          : {}),
        ...(ownAppearance ? { ownAppearance: true } : {}),
        ...(cupidsMisfire ? { cupidsMisfire } : {}),
      }),
      rollId,
    );
    if (hasRollCharacterSnapshot(db)) {
      db.prepare(
        "UPDATE character_rolls SET character_snapshot_json=? WHERE id=?",
      ).run(JSON.stringify(characterSnapshot), rollId);
    }
    if (!selectedEvent) {
      captureRollDelivery(db, { rollId, userId, remaining, characterSnapshot });
      return saveRequest({
        status: "reserved",
        rollId,
        character: characterSnapshot,
        ...(affectionEnabled ? { soulmateReclaimVersion: 1 } : {}),
        ownAppearance,
        escapeOwnerId: ownAppearance ? null : (marriage?.ownerId ?? null),
        cupidsMisfire,
        windows: rules.windows,
        remaining,
      });
    }
    const session = db
      .prepare(
        `INSERT INTO mystery_sessions
      (guild_id, origin_roll_id, event_id, character_id, rank_snapshot, roller_id,
        event_channel_id, state, state_json, started_at, deadline_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?)`,
      )
      .run(
        guildId,
        rollId,
        selectedEvent.eventId,
        characterSnapshot.id,
        characterSnapshot.rank,
        userId,
        mystery?.eventChannelId,
        JSON.stringify({
          ...selectedEvent.state,
          characterSnapshot,
          ...(db.prepare("PRAGMA user_version").get().user_version === 12
            ? { runtime: { version: 1, phase: "reserved", remaining } }
            : {}),
        }),
        now,
        now + selectedEvent.durationMs,
      );
    const sessionId = Number(session.lastInsertRowid);
    db.prepare(
      "UPDATE character_rolls SET mystery_session_id = ? WHERE id = ?",
    ).run(sessionId, rollId);
    return saveRequest({
      status: "mystery",
      rollId,
      sessionId,
      eventId: selectedEvent.eventId,
      character: characterSnapshot,
      remaining,
    });
  });
}

export function publishMysteryIntro(
  db,
  sessionId,
  messageId,
  now = Date.now(),
) {
  if (
    !Number.isSafeInteger(sessionId) ||
    sessionId <= 0 ||
    !validId(messageId) ||
    !validNow(now)
  ) {
    throw new Error("Invalid mystery intro");
  }
  return transaction(db, () => {
    const session = getMysterySession(db, sessionId);
    if (session?.state !== "reserved" || session.eventMessageId) return false;
    characterSnapshotFromState(
      JSON.parse(session.stateJson || "null"),
      session.characterId,
      session.rankSnapshot,
    );
    const snapshot = session.stateJson
      ? JSON.parse(session.stateJson)?.gameConfig
      : null;
    const promptAt = now + (snapshot?.mystery.introDelayMs ?? 5_000);
    const deadlineAt = promptAt + session.deadlineAt - session.startedAt;
    if (!validNow(promptAt) || !validNow(deadlineAt))
      throw new Error("Invalid mystery deadline");
    return (
      db
        .prepare(
          `UPDATE mystery_sessions SET event_message_id = ?,
      started_at = ?, next_at = ?, deadline_at = ?
      WHERE id = ? AND state = 'reserved' AND event_message_id IS NULL`,
        )
        .run(messageId, promptAt, promptAt, deadlineAt, sessionId).changes === 1
    );
  });
}

export function advanceMysterySession(
  db,
  {
    sessionId,
    expectedState,
    expectedStateJson,
    state,
    stateJson,
    nextAt = /** @type {number | null} */ (null),
    winnerId = null,
    puzzleId = null,
    now = Date.now(),
    random = Math.random,
    deadlineAt = /** @type {number | null} */ (null),
  },
) {
  if (
    !Number.isSafeInteger(sessionId) ||
    sessionId <= 0 ||
    !validNow(now) ||
    (nextAt != null && !validNow(nextAt)) ||
    (winnerId != null && !validId(winnerId)) ||
    (puzzleId != null && (typeof puzzleId !== "string" || !puzzleId)) ||
    (expectedStateJson !== null && typeof expectedStateJson !== "string")
  ) {
    throw new Error("Invalid mystery transition");
  }
  const allowed =
    (expectedState === "reserved" && state === "running") ||
    (expectedState === "running" && ["running", "countdown"].includes(state));
  if (
    !allowed ||
    (state === "countdown" && !winnerId) ||
    (puzzleId && state !== "countdown")
  ) {
    throw new Error("Invalid mystery transition");
  }
  return transaction(db, () => {
    const session = getMysterySession(db, sessionId);
    if (
      session?.state !== expectedState ||
      session.stateJson !== expectedStateJson
    )
      return { status: "stale" };
    characterSnapshotFromState(
      JSON.parse(session.stateJson || "null"),
      session.characterId,
      session.rankSnapshot,
    );
    if (
      expectedState === "reserved" &&
      (!session.eventMessageId || now < session.nextAt)
    ) {
      return { status: "early" };
    }
    if (
      deadlineAt != null &&
      (session.eventId !== "glass_bridge" ||
        !validNow(deadlineAt) ||
        deadlineAt <= now)
    )
      throw new Error("Invalid mystery deadline extension");
    if (
      now >= session.deadlineAt &&
      !(session.eventId === "glass_bridge" && deadlineAt != null)
    )
      return { status: "expired" };
    const next = state === "countdown" ? (nextAt ?? now + 5_000) : nextAt;
    if (next != null && !validNow(next))
      throw new Error("Invalid mystery transition");
    const original = JSON.parse(session.stateJson || "null");
    const replacement = stateJson === undefined ? original : stateJson;
    const retained = retainCharacterSnapshot(
      original,
      replacement,
      session.characterId,
    );
    // The public transition API predates runtime outcomes: entering countdown
    // with a winner is itself authoritative. Persist that fact here, not later
    // when a restarted legacy Doors row may represent either a win or a loss.
    if (state === "countdown") {
      const runtime = retained.runtime;
      const resolved = runtime?.resolved ?? { type: "winner", winnerId };
      if (
        (runtime?.version != null && runtime.version !== 1) ||
        !["winner", "no_winner"].includes(resolved.type) ||
        (resolved.type === "winner" && resolved.winnerId !== winnerId) ||
        (resolved.type === "no_winner" && resolved.winnerId != null)
      ) {
        throw new Error("Invalid mystery countdown outcome");
      }
      retained.runtime = {
        ...runtime,
        version: 1,
        phase: "countdown",
        resolved,
      };
      // Never accept a caller-injected decision or activate on losing Doors.
      delete retained.runtime.consolation;
      if (resolved.type === "winner")
        retained.runtime.consolation = resolveMysteryConsolation(db, {
          session,
          winnerId,
          canClaim: getClaimAvailability(db, session.guildId, winnerId, now)
            .canClaim,
          now,
          random,
        });
    }
    const serialized =
      stateJson === undefined && state !== "countdown"
        ? session.stateJson
        : JSON.stringify(retained);
    const changed = db
      .prepare(
        `UPDATE mystery_sessions SET state = ?, state_json = ?, next_at = ?,
      winner_id = COALESCE(?, winner_id), deadline_at = COALESCE(?, deadline_at)
      WHERE id = ? AND state = ? AND state_json IS ?`,
      )
      .run(
        state,
        serialized,
        next,
        winnerId,
        deadlineAt,
        sessionId,
        expectedState,
        expectedStateJson,
      ).changes;
    if (changed !== 1) return { status: "stale" };
    if (puzzleId)
      db.prepare(
        `INSERT INTO treasure_puzzle_wins (guild_id, puzzle_id, won_at)
      VALUES (?, ?, ?)`,
      ).run(session.guildId, puzzleId, now);
    return { status: "advanced", session: getMysterySession(db, sessionId) };
  });
}

export function endMysterySession(
  db,
  { sessionId, outcome, now = Date.now() },
) {
  if (
    !Number.isSafeInteger(sessionId) ||
    sessionId <= 0 ||
    typeof outcome !== "string" ||
    !outcome.trim() ||
    !validNow(now)
  )
    throw new Error("Invalid mystery resolution");
  return transaction(db, () => finishMystery(db, sessionId, outcome, now));
}

export function openMysteryClaim(
  db,
  { sessionId, messageId, now = Date.now() },
) {
  if (
    !Number.isSafeInteger(sessionId) ||
    sessionId <= 0 ||
    !validId(messageId) ||
    !validNow(now)
  ) {
    throw new Error("Invalid mystery claim publication");
  }
  return transaction(db, () => {
    const session = getMysterySession(db, sessionId);
    if (session?.state !== "countdown" || !session.winnerId)
      return { status: "stale" };
    loadRollCharacterSnapshot(db, session.originRollId);
    characterSnapshotFromState(
      JSON.parse(session.stateJson || "null"),
      session.characterId,
      session.rankSnapshot,
    );
    const runtime = JSON.parse(session.stateJson || "null")?.runtime;
    // Legacy Doors countdowns do not say whether the roller actually won.
    if (
      session.eventId === "doors" &&
      (runtime?.version !== 1 || runtime.resolved?.type !== "winner")
    )
      return { status: "ambiguous" };
    if (now < session.nextAt) return { status: "early" };
    if (inspectMysteryConsolation(db, session)?.status === "activated") {
      finishMystery(db, sessionId, "consolation", now);
      return { status: "unclaimable", reason: "consolation" };
    }
    const character = db
      .prepare("SELECT 1 FROM characters WHERE id = ?")
      .get(session.characterId);
    if (!character || getMarriage(db, session.guildId, session.characterId)) {
      finishMystery(db, sessionId, "unavailable", now);
      return { status: "unclaimable", reason: "unavailable" };
    }
    if (
      !getClaimAvailability(db, session.guildId, session.winnerId, now).canClaim
    ) {
      finishMystery(db, sessionId, "forfeited", now);
      return { status: "unclaimable", reason: "no_claim" };
    }
    const snapshot = db
      .prepare("SELECT rules_json FROM character_rolls WHERE id=?")
      .get(session.originRollId)?.rules_json;
    const claimWindow = snapshot
      ? JSON.parse(snapshot).claimMs
      : getGameConfig(db, session.guildId).windows.claimMs;
    const expiresAt = session.nextAt + claimWindow;
    if (now >= expiresAt) {
      finishMystery(db, sessionId, "expired", now);
      return { status: "unclaimable", reason: "expired" };
    }
    const published =
      db
        .prepare(
          `UPDATE character_rolls SET message_id = ?, state = 'open',
      exclusive_user_id = ?, published_at = ?, expires_at = ?
      WHERE id = ? AND mystery_session_id = ? AND state = 'pending'`,
        )
        .run(
          messageId,
          session.winnerId,
          session.nextAt,
          expiresAt,
          session.originRollId,
          sessionId,
        ).changes === 1;
    if (!published) return { status: "stale" };
    db.prepare(
      "UPDATE mystery_sessions SET state = 'claim_open', next_at = ? WHERE id = ? AND state = 'countdown'",
    ).run(expiresAt, sessionId);
    return {
      status: "open",
      rollId: session.originRollId,
      expiresAt,
      winnerId: session.winnerId,
    };
  });
}

export function cancelActiveMysteries(db, now = Date.now()) {
  if (!validNow(now)) throw new Error("Invalid mystery cancellation");
  return transaction(db, () => {
    const ids = db
      .prepare(
        `SELECT id FROM ${currentSeasonRows(db, "mystery_sessions")} WHERE state IN ${ACTIVE_MYSTERY}`,
      )
      .all();
    for (const { id } of ids) finishMystery(db, id, "canceled", now);
    return ids.length;
  });
}

export function recoverRolls(db, now = Date.now()) {
  // Only bound, validated durable escape cards can survive a restart. Legacy
  // cards without snapshots (and unpublished ordinary escapes) cancel explicitly.
  for (const row of db
    .prepare(
      `SELECT id, state, message_id, command_message_id FROM ${currentSeasonRows(db, "character_rolls")}
    WHERE escape_marriage_id IS NOT NULL AND state IN ('pending', 'open')`,
    )
    .all()) {
    if (
      row.state === "pending" &&
      (row.command_message_id.startsWith("siren:") ||
        Number(db.prepare("PRAGMA user_version").get().user_version) === 12)
    )
      continue;
    if (row.state === "open" && row.message_id) {
      try {
        if (loadRollCharacterSnapshot(db, row.id)) continue;
      } catch {
        /* Fail closed. */
      }
    }
    db.prepare(
      `UPDATE character_rolls SET state='closed', escape_outcome='canceled', escape_resolved_at=?
      WHERE id=?`,
    ).run(now, row.id);
  }
  // Final-schema paid pending reservations are durable, including malformed or
  // missing delivery records: leave these for recovery/inspection, never fail them.
  // Intermediate/legacy fixtures retain their historical recovery contract.
  if (Number(db.prepare("PRAGMA user_version").get().user_version) !== 12) {
    db.prepare(
      "UPDATE character_rolls SET state = 'failed' WHERE state = 'pending' AND mystery_session_id IS NULL AND command_message_id NOT LIKE 'siren:%'",
    ).run();
  }
  return db
    .prepare(
      `SELECT id, guild_id AS guildId, channel_id AS channelId,
    message_id AS messageId, character_id AS characterId, expires_at AS expiresAt
    FROM ${currentSeasonRows(db, "character_rolls")} WHERE state = 'open' AND mystery_session_id IS NULL AND expires_at > ?`,
    )
    .all(now);
}

export function cleanupRolls(db, now = Date.now()) {
  return transaction(db, () => {
    const abandonment = inspectLegacyVaultAbandonment(db);
    if (abandonment.blockers.length)
      throw new Error(abandonment.blockers.join("\n"));
    const candidates = db
      .prepare(
        `SELECT r.*, m.resolved_at AS mystery_resolved_at FROM ${currentSeasonRows(db, "character_rolls")} r
      LEFT JOIN mystery_sessions m ON m.id=r.mystery_session_id`,
      )
      .all();
    let removed = 0;
    for (const row of candidates) {
      // Valid abandonment evidence binds these historical rows exactly, beyond report expiry.
      if (abandonment.ids.has(row.id)) continue;
      if (row.mystery_session_id) {
        const session = getMysterySession(db, row.mystery_session_id);
        if (
          JSON.parse(session.stateJson || "{}")?.runtime
            ?.affectionRevealPending === true
        )
          continue;
        const decision = inspectMysteryConsolation(db, session);
        if (
          decision?.status === "activated" &&
          JSON.parse(session.stateJson).runtime
            .consolationRevealAcknowledged !== true
        )
          continue;
      }
      const lifetime = row.rules_json
        ? (JSON.parse(row.rules_json).reportMs ?? REPORT_LIFETIME)
        : REPORT_LIFETIME;
      // Never remove a still-active roll merely because reporting expired.
      if (
        row.state === "pending" ||
        (row.state === "open" && row.expires_at > now)
      )
        continue;
      if (
        row.state !== "failed" &&
        ![
          row.published_at,
          row.escape_resolved_at,
          row.mystery_resolved_at,
        ].some((time) => time != null && time < now - lifetime)
      )
        continue;
      db.prepare("DELETE FROM roll_notices WHERE roll_id=?").run(row.id);
      removed += db
        .prepare("DELETE FROM character_rolls WHERE id=?")
        .run(row.id).changes;
    }
    return removed;
  });
}
