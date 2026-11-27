import { createHash } from "node:crypto";
import { characterMainFranchiseRelation } from "./characterFranchises.js";
import {
  weeklyPrize,
  scoreWeekly,
} from "../features/weeklyEvents/weeklyEvents.js";
import {
  AFFECTION_CAP,
  NORMAL_MILESTONES,
  SOULMATE_CHECKPOINTS,
  getPerks,
  progressInterval,
  relatedAffectionBase,
} from "./affectionRules.js";
import {
  resolveAffectionDecisionInTransaction,
  captureCurrentPerks,
  requireAffectionTransaction,
  validateAffectionScope,
  drawAffectionRandom,
} from "./affectionPerks.js";
import { isCharacterBusy } from "./characterAvailability.js";
import { validateSavedAffectionContext } from "./affectionSnapshot.js";
import { requireNewGameAction } from "./catalogMaintenance.js";
import {
  assertSeasonWritable,
  currentSeason,
} from "../features/seasons/seasonStore.js";
import { currentSeasonRows, hasSeasonSchema } from "./seasonSchema.js";

export function hasAffection(db) {
  return Boolean(
    db
      .prepare(
        "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='affection_schema'",
      )
      .get(),
  );
}
export function getAffectionTotal(db, guildId, userId, characterId) {
  return hasAffection(db)
    ? (db
        .prepare(
          "SELECT total FROM character_affection WHERE guild_id=? AND user_id=? AND character_id=?",
        )
        .get(guildId, userId, characterId)?.total ?? 0)
    : 0;
}
export function getSoulmateState(db, guildId, userId) {
  if (!hasAffection(db))
    return {
      characterId: null,
      selectedAt: null,
      switchAvailableAt: 0,
      revision: 0,
    };
  const row = db
    .prepare(
      "SELECT character_id,selected_at,switch_available_at,revision FROM player_soulmates WHERE guild_id=? AND user_id=?",
    )
    .get(guildId, userId);
  return row
    ? {
        characterId: row.character_id,
        selectedAt: row.selected_at,
        switchAvailableAt: row.switch_available_at,
        revision: row.revision,
      }
    : {
        characterId: null,
        selectedAt: null,
        switchAvailableAt: 0,
        revision: 0,
      };
}
export function getAffectionBenefits(db, guildId, userId) {
  const empty = {
    rollBonus: 0,
    claimReductionMs: 0,
    soulmate: null,
    perks: getPerks(0),
  };
  if (!hasAffection(db)) return empty;
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(a.total>=200),0) rolls,COALESCE(SUM(a.total>=700),0) claims
    FROM character_affection a JOIN marriages m ON m.guild_id=a.guild_id AND m.owner_id=a.user_id AND m.character_id=a.character_id
    WHERE a.guild_id=? AND a.user_id=?`,
    )
    .get(guildId, userId);
  const selected = getSoulmateState(db, guildId, userId).characterId;
  const owned =
    selected &&
    db
      .prepare(
        "SELECT 1 FROM marriages WHERE guild_id=? AND owner_id=? AND character_id=?",
      )
      .get(guildId, userId, selected);
  return {
    rollBonus: Math.min(5, row.rolls),
    claimReductionMs: Math.min(10, row.claims) * 360000,
    soulmate: owned
      ? {
          characterId: selected,
          total: getAffectionTotal(db, guildId, userId, selected),
        }
      : null,
    perks: captureCurrentPerks(db, guildId, userId),
  };
}
/** Owns a top-level transaction. Busy offers use the existing connection-local registry.
 * @param {any} db
 * @param {{guildId:string,userId:string,characterId:string|number,expectedRevision?:number,season?:number,now?:number}} options
 */
export function confirmSoulmate(
  db,
  { guildId, userId, characterId, expectedRevision, season, now = Date.now() },
) {
  if (db.isTransaction)
    throw new Error("Soulmate confirmation requires its own transaction");
  validateAffectionScope({ guildId, userId, sourceKey: characterId, now });
  if (!hasAffection(db)) throw new Error("Affection schema required");
  db.exec("BEGIN IMMEDIATE");
  try {
    requireNewGameAction(db);
    assertSeasonWritable(db, guildId, { season, now });
    const state = getSoulmateState(db, guildId, userId);
    let status;
    if (expectedRevision !== undefined && expectedRevision !== state.revision)
      status = "stale";
    else if (
      !db
        .prepare(
          "SELECT 1 FROM marriages WHERE guild_id=? AND owner_id=? AND character_id=?",
        )
        .get(guildId, userId, characterId)
    )
      status = "not_owned";
    else if (state.characterId === characterId) status = "unchanged";
    else if (isCharacterBusy(db, guildId, characterId, now)) status = "busy";
    else if (
      state.characterId &&
      now < state.switchAvailableAt &&
      !useSeasonSoulmateWaiver(db, guildId, userId, now)
    )
      status = "cooldown";
    else {
      if (
        !Number.isSafeInteger(now + 43200000) ||
        state.revision >= Number.MAX_SAFE_INTEGER
      )
        throw new Error("Soulmate state overflow");
      db.prepare(
        `INSERT INTO player_soulmates VALUES(?,?,?,?,?,?) ON CONFLICT(guild_id,user_id) DO UPDATE SET
        character_id=excluded.character_id,selected_at=excluded.selected_at,switch_available_at=excluded.switch_available_at,revision=excluded.revision`,
      ).run(
        guildId,
        userId,
        characterId,
        now,
        now + 43200000,
        state.revision + 1,
      );
      status = "selected";
    }
    const result = { status, state: getSoulmateState(db, guildId, userId) };
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function seasonSoulmateWaiverAvailable(
  db,
  guildId,
  userId,
  now = Date.now(),
) {
  return (
    hasSeasonSchema(db) &&
    Boolean(
      db
        .prepare(
          `SELECT 1 FROM season_rollovers r JOIN guild_seasons s USING(guild_id,season)
    WHERE r.guild_id=? AND r.phase='announced' AND r.announced_at<=? AND r.cutoff_at>?
    AND NOT EXISTS (SELECT 1 FROM season_soulmate_waivers w WHERE w.guild_id=r.guild_id AND w.season=r.season AND w.user_id=?)`,
        )
        .get(guildId, now, now, userId),
    )
  );
}

function useSeasonSoulmateWaiver(db, guildId, userId, now) {
  if (!seasonSoulmateWaiverAvailable(db, guildId, userId, now)) return false;
  return Boolean(
    db
      .prepare(
        `INSERT OR IGNORE INTO season_soulmate_waivers(guild_id,season,user_id)
    SELECT guild_id,season,? FROM guild_seasons WHERE guild_id=?`,
      )
      .run(userId, guildId).changes,
  );
}
function pendingFor(db, guildId, userId, characterId) {
  return db
    .prepare(
      `SELECT * FROM affection_entitlements WHERE guild_id=? AND user_id=?
    AND (? IS NULL OR character_id=?) AND state IN ('owed','selected') ORDER BY earned_at,threshold,character_id`,
    )
    .all(guildId, userId, characterId, characterId)
    .map((row) => ({
      ...row,
      outcome: row.outcome_json ? JSON.parse(row.outcome_json) : null,
    }));
}
export function getAffectionDetail(
  db,
  { guildId, userId, characterId, now = Date.now() },
) {
  if (!hasAffection(db)) return null;
  const row = db
    .prepare(
      `SELECT i.id characterId,COALESCE(c.name_full,i.name_full) name,c.rank,
    COALESCE(c.image_url,i.image_url) image,COALESCE(a.total,0) total,
    EXISTS(SELECT 1 FROM marriages m WHERE m.guild_id=? AND m.owner_id=? AND m.character_id=i.id) isOwned,
    EXISTS(SELECT 1 FROM character_ownership_losses l WHERE l.guild_id=? AND l.former_owner_id=? AND l.character_id=i.id) lost
    FROM character_identities i LEFT JOIN characters c ON c.id=i.id
    LEFT JOIN character_affection a ON a.character_id=i.id AND a.guild_id=? AND a.user_id=? WHERE i.id=?`,
    )
    .get(guildId, userId, guildId, userId, guildId, userId, characterId);
  if (!row) return null;
  return relationshipDetail(db, row, {
    benefits: getAffectionBenefits(db, guildId, userId),
    pending: pendingFor(db, guildId, userId, characterId),
    soulmateState: getSoulmateState(db, guildId, userId),
    now,
  });
}
function relationshipDetail(
  db,
  row,
  { benefits, pending, soulmateState, now },
) {
  const { characterId } = row,
    isOwned = Boolean(row.isOwned);
  const isSoulmate = isOwned && benefits.soulmate?.characterId === characterId;
  const franchises = db
    .prepare(
      `SELECT f.id,f.display_name name FROM ${characterMainFranchiseRelation(db)} cf
    JOIN franchises f ON f.id=cf.franchise_id WHERE cf.character_id=? ORDER BY f.display_name,f.id`,
    )
    .all(characterId);
  const normalContribution = {
    rollBonus: isOwned && row.total >= 200 ? 1 : 0,
    claimReductionMs: isOwned && row.total >= 700 ? 360000 : 0,
  };
  return {
    characterId,
    name: row.name,
    rank: row.rank,
    image: row.image,
    franchises,
    total: row.total,
    isOwned,
    isFormer: !isOwned && (Boolean(row.lost) || row.total > 0),
    isSoulmate,
    interval: progressInterval(row.total, { soulmate: isSoulmate }),
    normalContribution,
    pending,
    benefits,
    soulmateState,
    now,
  };
}
export function getAffectionOverview(
  db,
  { guildId, userId, former = false, page = 0, pageSize = 5, now = Date.now() },
) {
  if (!hasAffection(db))
    return {
      rows: [],
      total: 0,
      page: 0,
      pageSize,
      pages: 1,
      former,
      hasFormer: false,
      benefits: getAffectionBenefits(db, guildId, userId),
      pending: [],
      soulmate: getSoulmateState(db, guildId, userId),
    };
  pageSize = Math.max(1, Math.min(25, Math.floor(pageSize) || 5));
  page = Math.max(0, Math.floor(page) || 0);
  // Read only base relationship rows across the collection. Preserve locale-aware
  // name ties in JS; build franchises/intervals/details only after sorting/paging.
  const baseRows = db
    .prepare(
      `WITH ids AS (
    SELECT character_id FROM marriages WHERE guild_id=? AND owner_id=?
    UNION SELECT character_id FROM character_affection WHERE guild_id=? AND user_id=?
    UNION SELECT character_id FROM character_ownership_losses WHERE guild_id=? AND former_owner_id=?)
    SELECT i.id characterId,COALESCE(c.name_full,i.name_full) name,c.rank,
      COALESCE(c.image_url,i.image_url) image,COALESCE(a.total,0) total,
      (m.owner_id=?) IS TRUE isOwned,l.character_id IS NOT NULL lost
    FROM ids JOIN character_identities i ON i.id=ids.character_id
    LEFT JOIN characters c ON c.id=i.id
    LEFT JOIN character_affection a ON a.character_id=i.id AND a.guild_id=? AND a.user_id=?
    LEFT JOIN marriages m ON m.character_id=i.id AND m.guild_id=?
    LEFT JOIN character_ownership_losses l ON l.character_id=i.id AND l.guild_id=? AND l.former_owner_id=?`,
    )
    .all(
      guildId,
      userId,
      guildId,
      userId,
      guildId,
      userId,
      userId,
      guildId,
      userId,
      guildId,
      guildId,
      userId,
    );
  const isFormer = (row) =>
    !row.isOwned && (Boolean(row.lost) || row.total > 0);
  const all = baseRows
    .filter((row) => (former ? isFormer(row) : row.isOwned))
    .sort(
      (a, b) =>
        b.total - a.total ||
        String(a.name ?? "").localeCompare(String(b.name ?? ""), "en") ||
        a.characterId.localeCompare(b.characterId),
    );
  const benefits = getAffectionBenefits(db, guildId, userId),
    pending = pendingFor(db, guildId, userId, null),
    soulmate = getSoulmateState(db, guildId, userId);
  const pendingByCharacter = new Map();
  for (const entry of pending) {
    if (!pendingByCharacter.has(entry.character_id))
      pendingByCharacter.set(entry.character_id, []);
    pendingByCharacter.get(entry.character_id).push(entry);
  }
  const rows = all.slice(page * pageSize, (page + 1) * pageSize).map((row) =>
    relationshipDetail(db, row, {
      benefits,
      pending: pendingByCharacter.get(row.characterId) ?? [],
      soulmateState: soulmate,
      now,
    }),
  );
  return {
    rows,
    total: all.length,
    page,
    pageSize,
    pages: Math.max(1, Math.ceil(all.length / pageSize)),
    former,
    hasFormer: baseRows.some(isFormer),
    benefits,
    pending,
    soulmate,
  };
}
function sharedFranchises(db, a, b) {
  const membership = characterMainFranchiseRelation(db);
  return db
    .prepare(
      `SELECT f.franchise_id,COUNT(DISTINCT c.id) size FROM ${membership} f
    JOIN characters c ON c.id=f.character_id WHERE f.franchise_id IN
    (SELECT franchise_id FROM ${membership} WHERE character_id=? INTERSECT
     SELECT franchise_id FROM ${membership} WHERE character_id=?) GROUP BY f.franchise_id`,
    )
    .all(a, b);
}
function checkContextScope(row, args) {
  if (
    row.guild_id !== args.guildId ||
    row.user_id !== args.userId ||
    row.channel_id !== args.channelId ||
    row.character_id !== args.characterId
  )
    throw new Error("Affection source scope conflict");
}
/** Saves eligibility AND the pre-event Bond draw before consequences; caller must earn only after true presentation. */
export function captureAppearanceInTransaction(
  db,
  {
    sourceKey,
    guildId,
    channelId,
    userId,
    characterId,
    now = Date.now(),
    random = Math.random,
  },
) {
  requireAffectionTransaction(db);
  validateAffectionScope({ sourceKey, guildId, userId, now });
  const prior = db
    .prepare("SELECT * FROM affection_contexts WHERE source_key=?")
    .get(sourceKey);
  if (prior) {
    checkContextScope(prior, { guildId, channelId, userId, characterId });
    return validateSavedAffectionContext(prior);
  }
  const benefits = getAffectionBenefits(db, guildId, userId),
    candidates = new Map();
  const owned = Boolean(
    db
      .prepare(
        "SELECT 1 FROM marriages WHERE guild_id=? AND owner_id=? AND character_id=?",
      )
      .get(guildId, userId, characterId),
  );
  if (owned) candidates.set(characterId, 100);
  let matching = null;
  if (benefits.soulmate) {
    const id = benefits.soulmate.characterId;
    const shared = sharedFranchises(db, id, characterId);
    matching = {
      sharedFranchises: shared,
      soulmateGenres: [],
      rolledGenres: [],
    };
    const base = relatedAffectionBase({
      sharedFranchiseSizes: shared.map((f) => f.size),
    });
    if (base) candidates.set(id, Math.max(base, candidates.get(id) ?? 0));
  }
  const chance = benefits.perks.unbroken_bond;
  const awards = [...candidates].map(([id, base]) => ({
    userId,
    characterId: id,
    base,
    bondChance: chance,
    bond: chance > 0 && drawAffectionRandom(random) < chance,
  }));
  const snapshot = {
    version: 2,
    owned,
    soulmate: benefits.soulmate,
    matching,
    awards,
  };
  validateSavedAffectionContext({
    source_key: sourceKey,
    guild_id: guildId,
    user_id: userId,
    channel_id: channelId,
    character_id: characterId,
    capture_version: 1,
    state: "captured",
    snapshot_json: JSON.stringify(snapshot),
  });
  db.prepare(
    "INSERT INTO affection_contexts VALUES(?,?,?,?,?,1,?,?,?,NULL)",
  ).run(
    sourceKey,
    guildId,
    userId,
    channelId,
    characterId,
    JSON.stringify(snapshot),
    "captured",
    now,
  );
  return snapshot;
}
function rewardIdFor(db, guildId, userId, characterId, key) {
  const scope = [guildId, userId, characterId, key];
  const season = currentSeason(db, guildId)?.season;
  if (season) scope.push(String(season));
  return (
    "affection-" +
    createHash("sha256").update(JSON.stringify(scope)).digest("hex")
  );
}
function chooseEntitlement(db, row, rewardRoster, random) {
  const pool = row.item_id
    ? rewardRoster.filter((i) => i.id === row.item_id)
    : rewardRoster.filter(
        (i) =>
          i.tier === row.tier &&
          i.rewardEligible !== false &&
          i.rules?.rewardEligible !== false,
      );
  if (!pool.length) return false;
  const item =
    pool[
      row.item_id ? 0 : Math.floor(drawAffectionRandom(random) * pool.length)
    ];
  const charges =
    item.startingCharges ?? item.rules?.startingCharges ?? item.maxCharges ?? 1;
  if (!Number.isSafeInteger(charges) || charges < 1)
    throw new Error("Invalid trusted affection reward charges");
  // Existing reward pipeline consumes {tier,item}; freeze configured starting charges.
  const outcome = {
    tier: item.tier,
    item: { ...item, maxCharges: charges, startingCharges: charges },
  };
  db.prepare(
    `UPDATE affection_entitlements SET state='selected',item_id=?,outcome_json=?,reward_id=?
    WHERE guild_id=? AND user_id=? AND character_id=? AND milestone_key=? AND state='owed'`,
  ).run(
    item.id,
    JSON.stringify(outcome),
    rewardIdFor(
      db,
      row.guild_id,
      row.user_id,
      row.character_id,
      row.milestone_key,
    ),
    row.guild_id,
    row.user_id,
    row.character_id,
    row.milestone_key,
  );
  return true;
}
/** @param {import('node:sqlite').DatabaseSync} db
 * @param {{guildId:string,userId:string,rewardRoster?:any[],random?:()=>number,now?:number}} options */
export function selectOwedAffectionRewardsInTransaction(
  db,
  {
    guildId,
    userId,
    rewardRoster = [],
    random = Math.random,
    now = Date.now(),
  },
) {
  requireAffectionTransaction(db);
  validateAffectionScope({ guildId, userId, sourceKey: "owed", now });
  let selected = 0;
  for (const row of db
    .prepare(
      "SELECT * FROM affection_entitlements WHERE guild_id=? AND user_id=? AND state='owed' ORDER BY earned_at,threshold,character_id",
    )
    .all(guildId, userId))
    if (chooseEntitlement(db, row, rewardRoster, random)) selected++;
  return { selected, pending: pendingFor(db, guildId, userId, null) };
}
function queueMilestoneItems(
  db,
  { sourceKey, guildId, channelId, userId, characterId, milestones, now },
) {
  for (const milestone of milestones.filter(
    (entry) => entry.itemId || entry.tier,
  )) {
    db.prepare(
      `INSERT INTO affection_entitlements(source_key,guild_id,user_id,character_id,milestone_key,threshold,tier,item_id,state,earned_at,channel_id)
      VALUES(?,?,?,?,?,?,?,?,'owed',?,?) ON CONFLICT(guild_id,user_id,character_id,milestone_key) DO NOTHING`,
    ).run(
      sourceKey,
      guildId,
      userId,
      characterId,
      milestone.key,
      milestone.threshold,
      milestone.tier ?? null,
      milestone.itemId ?? null,
      now,
      channelId,
    );
  }
}

export function seedSoulmateAffectionInTransaction(
  db,
  {
    guildId,
    userId,
    characterId,
    channelId,
    total,
    season,
    now,
    rewardRoster,
    random,
  },
) {
  requireAffectionTransaction(db);
  db.prepare("INSERT INTO character_affection VALUES (?,?,?,?,?)").run(
    guildId,
    userId,
    characterId,
    total,
    now,
  );
  queueMilestoneItems(db, {
    sourceKey: `season:${guildId}:${season}:${userId}`,
    guildId,
    channelId,
    userId,
    characterId,
    milestones: NORMAL_MILESTONES.filter(
      (milestone) => milestone.threshold <= total,
    ),
    now,
  });
  selectOwedAffectionRewardsInTransaction(db, {
    guildId,
    userId,
    rewardRoster,
    random,
    now,
  });
}

function award(
  db,
  {
    sourceKey,
    guildId,
    channelId,
    userId,
    characterId,
    base,
    bond,
    soulmate = false,
    now,
    rewardRoster,
    random,
  },
) {
  const previous = db
    .prepare(
      "SELECT * FROM affection_awards WHERE source_key=? AND guild_id=? AND user_id=? AND character_id=?",
    )
    .get(sourceKey, guildId, userId, characterId);
  if (previous) return awardResult(previous);
  const before = getAffectionTotal(db, guildId, userId, characterId);
  const amount = base * (bond ? 2 : 1);
  const prize = weeklyPrize(db, guildId, userId, "affection", now);
  const extra =
    amount > 0 && prize
      ? Math.max(
          prize.affectionMinimum,
          Math.floor(amount * prize.affectionRate),
        )
      : 0;
  const total = Math.min(AFFECTION_CAP, before + amount + extra);
  const milestones = NORMAL_MILESTONES.filter(
    (m) => m.threshold > before && m.threshold <= total,
  );
  const checkpoints = soulmate
    ? SOULMATE_CHECKPOINTS.filter(
        (m) => m.threshold > before && m.threshold <= total,
      )
    : [];
  db.prepare(
    `INSERT INTO character_affection VALUES(?,?,?,?,?) ON CONFLICT(guild_id,user_id,character_id)
    DO UPDATE SET total=excluded.total,updated_at=excluded.updated_at`,
  ).run(guildId, userId, characterId, total, now);
  queueMilestoneItems(db, {
    sourceKey,
    guildId,
    channelId,
    userId,
    characterId,
    milestones,
    now,
  });
  db.prepare("INSERT INTO affection_awards VALUES(?,?,?,?,?,?,?,?,?)").run(
    sourceKey,
    guildId,
    userId,
    characterId,
    base,
    total - before,
    total,
    JSON.stringify([...milestones, ...checkpoints]),
    now,
  );
  scoreWeekly(db, {
    guildId,
    userId,
    theme: "affection",
    key: JSON.stringify([sourceKey, userId, characterId]),
    now,
    points: total - before,
  });
  return {
    userId,
    characterId,
    base,
    amount: total - before,
    total,
    milestones,
    checkpoints,
  };
}
export function awardResult(row) {
  const rewards = JSON.parse(row.milestones_json);
  return {
    userId: row.user_id,
    characterId: row.character_id,
    base: row.base,
    amount: row.amount,
    total: row.total,
    milestones: rewards.filter((m) => !m.effect),
    checkpoints: rewards.filter((m) => m.effect),
  };
}
function sourceAwards(db, sourceKey) {
  return db
    .prepare("SELECT * FROM affection_awards WHERE source_key=? ORDER BY rowid")
    .all(sourceKey)
    .map(awardResult);
}
/** @param {import('node:sqlite').DatabaseSync} db
 * @param {{sourceKey:string,now?:number,rewardRoster?:any[],random?:()=>number}} options */
export function completeAppearanceInTransaction(
  db,
  { sourceKey, now = Date.now(), rewardRoster = [], random = Math.random },
) {
  requireAffectionTransaction(db);
  const context =
    /** @type {{guild_id:string,user_id:string,channel_id:string,state:string,snapshot_json:string}|undefined} */
    (
      db
        .prepare(
          `SELECT * FROM ${currentSeasonRows(db, "affection_contexts")} WHERE source_key=?`,
        )
        .get(sourceKey)
    );
  if (!context) {
    if (
      hasSeasonSchema(db) &&
      db
        .prepare("SELECT 1 FROM affection_contexts WHERE source_key=?")
        .get(sourceKey)
    )
      return { awards: [] };
    throw new Error(
      "Missing affection appearance capture; require explicit legacy source evidence",
    );
  }
  const snapshot = validateSavedAffectionContext(context);
  if (context.state === "completed") {
    const candidates = snapshot.awards;
    return {
      awards: sourceAwards(db, sourceKey).filter((a) =>
        candidates.some(
          (c) => c.userId === a.userId && c.characterId === a.characterId,
        ),
      ),
    };
  }
  if (context.state === "canceled") return { awards: [] };
  const awards = [];
  for (const candidate of snapshot.awards)
    awards.push(
      award(db, {
        sourceKey,
        guildId: context.guild_id,
        channelId: context.channel_id,
        userId: context.user_id,
        characterId: candidate.characterId,
        base: candidate.base,
        bond: candidate.bond,
        soulmate: snapshot.soulmate?.characterId === candidate.characterId,
        now,
        rewardRoster,
        random,
      }),
    );
  selectOwedAffectionRewardsInTransaction(db, {
    guildId: context.guild_id,
    userId: context.user_id,
    rewardRoster,
    random,
    now,
  });
  db.prepare(
    "UPDATE affection_contexts SET state='completed',completed_at=? WHERE source_key=?",
  ).run(now, sourceKey);
  return { awards };
}
export function cancelAppearanceInTransaction(db, sourceKey, now = Date.now()) {
  requireAffectionTransaction(db);
  return (
    db
      .prepare(
        `UPDATE affection_contexts SET state='canceled',completed_at=?
    WHERE source_key IN (SELECT source_key FROM ${currentSeasonRows(db, "affection_contexts")}
      WHERE source_key=? AND state='captured')`,
      )
      .run(now, sourceKey).changes === 1
  );
}
/** @param {import('node:sqlite').DatabaseSync} db
 * @param {{sourceKey:string,guildId:string,channelId:string,userId:string,characterId:string,now?:number,rewardRoster?:any[],random?:()=>number}} options */
export function earnReclaimInTransaction(
  db,
  {
    sourceKey,
    guildId,
    channelId,
    userId,
    characterId,
    now = Date.now(),
    rewardRoster = [],
    random = Math.random,
  },
) {
  requireAffectionTransaction(db);
  validateAffectionScope({ sourceKey, guildId, userId, now });
  const previous = db
    .prepare(
      "SELECT * FROM affection_awards WHERE source_key=? AND guild_id=? AND user_id=? AND character_id=?",
    )
    .get(sourceKey, guildId, userId, characterId);
  if (previous) return { awards: [awardResult(previous)] };
  if (
    !db
      .prepare(
        "SELECT 1 FROM marriages WHERE guild_id=? AND owner_id=? AND character_id=?",
      )
      .get(guildId, userId, characterId)
  )
    throw new Error("Reclaim affection requires current ownership");
  const chance = captureCurrentPerks(db, guildId, userId).unbroken_bond;
  const { triggered: bond } = resolveAffectionDecisionInTransaction(db, {
    sourceKey: `affection-reclaim:${JSON.stringify([sourceKey, characterId])}`,
    guildId,
    userId,
    effect: "unbroken_bond",
    chance,
    now,
    random,
  });
  const result = award(db, {
    sourceKey,
    guildId,
    channelId,
    userId,
    characterId,
    base: 20,
    bond,
    soulmate: getSoulmateState(db, guildId, userId).characterId === characterId,
    now,
    rewardRoster,
    random,
  });
  selectOwedAffectionRewardsInTransaction(db, {
    guildId,
    userId,
    rewardRoster,
    random,
    now,
  });
  return { awards: [result] };
}

/** Called only at the validated paid roll's successful owner-reclaim transition.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{sourceKey:string,guildId:string,channelId:string,userId:string,now?:number,rewardRoster?:any[],random?:()=>number}} options */
export function earnRollerReclaimInTransaction(
  db,
  {
    sourceKey,
    guildId,
    channelId,
    userId,
    now = Date.now(),
    rewardRoster = [],
    random = Math.random,
  },
) {
  requireAffectionTransaction(db);
  validateAffectionScope({ sourceKey, guildId, userId, now });
  // Resolve an existing receipt before consulting a potentially changed selection.
  const previous = db
    .prepare(
      "SELECT * FROM affection_awards WHERE source_key=? AND guild_id=? AND user_id=?",
    )
    .get(sourceKey, guildId, userId);
  if (previous) {
    // Preserve historical base-8 awards verbatim; new awards use base 5.
    if (previous.base !== 8 && previous.base !== 5)
      throw new Error("Invalid roller reclaim receipt");
    return { awards: [awardResult(previous)] };
  }
  const benefits = getAffectionBenefits(db, guildId, userId);
  if (!benefits.soulmate) return { awards: [] };
  const { triggered: bond } = resolveAffectionDecisionInTransaction(db, {
    sourceKey: `affection-roller-reclaim:${sourceKey}`,
    guildId,
    userId,
    effect: "unbroken_bond",
    chance: benefits.perks.unbroken_bond,
    now,
    random,
  });
  const result = award(db, {
    sourceKey,
    guildId,
    channelId,
    userId,
    characterId: benefits.soulmate.characterId,
    base: 5,
    bond,
    soulmate: true,
    now,
    rewardRoster,
    random,
  });
  selectOwedAffectionRewardsInTransaction(db, {
    guildId,
    userId,
    rewardRoster,
    random,
    now,
  });
  return { awards: [result] };
}
