import { characterMainFranchiseRelation } from "./characterFranchises.js";

export const rollGenderSql = "LOWER(TRIM(COALESCE(c.gender, '')))";

/** @typedef {{ ids: readonly string[], count: number }} RollCandidatePool */
/** @typedef {{ franchiseId: unknown } | { maxRank: unknown }} RollPoolConstraint */
/** @typedef {(pool: string, constraint?: RollPoolConstraint) => RollCandidatePool | undefined} GetRollCandidatePool */
/** @typedef {{ ids: string[], ranks: number[] }} RankedPool */

function rankPrefix(ranks, maxRank) {
  let start = 0;
  let end = ranks.length;
  while (start < end) {
    const middle = Math.floor((start + end) / 2);
    if (ranks[middle] <= maxRank) start = middle + 1;
    else end = middle;
  }
  return start;
}

/** @returns {GetRollCandidatePool} */
export function loadRollCandidatePools(db) {
  /** @type {RankedPool} */
  const w = { ids: [], ranks: [] };
  /** @type {RankedPool} */
  const h = { ids: [], ranks: [] };
  /** @type {Map<string, string>} */
  const genders = new Map();
  // Read table pages in sequence. Walking the rank index also fetches each row's gender.
  const characters = db
    .prepare(
      `SELECT c.id, c.rank, ${rollGenderSql} AS gender
    FROM characters c NOT INDEXED`,
    )
    .all();
  characters.sort((left, right) => left.rank - right.rank);
  for (const { id, rank, gender } of characters) {
    genders.set(id, gender);
    if (gender !== "male") {
      w.ids.push(id);
      w.ranks.push(rank);
    }
    if (gender !== "female") {
      h.ids.push(id);
      h.ranks.push(rank);
    }
  }
  Object.freeze(w.ids);
  Object.freeze(h.ids);

  /** @type {Map<number, { w: string[], h: string[] }>} */
  const franchises = new Map();
  for (const { character_id: id, franchise_id: franchiseId } of db
    .prepare(
      `SELECT character_id, franchise_id FROM ${characterMainFranchiseRelation(db)}`,
    )
    .iterate()) {
    const gender = genders.get(id);
    if (gender === undefined) continue;
    let members = franchises.get(franchiseId);
    if (!members) {
      members = { w: [], h: [] };
      franchises.set(franchiseId, members);
    }
    if (gender !== "male") members.w.push(id);
    if (gender !== "female") members.h.push(id);
  }
  for (const members of franchises.values()) {
    Object.freeze(members.w);
    Object.freeze(members.h);
  }

  return (pool, constraint) => {
    if (constraint && "franchiseId" in constraint) {
      if (typeof constraint.franchiseId !== "number") return;
      const members = franchises.get(constraint.franchiseId);
      if (!members) return;
      const ids = pool === "w" ? members.w : members.h;
      return { ids, count: ids.length };
    }
    const { ids, ranks } = pool === "w" ? w : h;
    if (!constraint) return { ids, count: ids.length };
    const { maxRank } = constraint;
    if (typeof maxRank !== "number" || !Number.isFinite(maxRank)) return;
    return { ids, count: rankPrefix(ranks, maxRank) };
  };
}
