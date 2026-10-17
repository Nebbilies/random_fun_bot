export const MYSTERY_ODDS_ANCHORS = Object.freeze([
  Object.freeze({ rank: 20, chance: 1 }),
  Object.freeze({ rank: 50, chance: 0.75 }),
  Object.freeze({ rank: 100, chance: 0.50 }),
  Object.freeze({ rank: 200, chance: 0.35 }),
  Object.freeze({ rank: 500, chance: 0.2 }),
  Object.freeze({ rank: 1_000, chance: 0.05 }),
  Object.freeze({ rank: 4_000, chance: 0.01 }),
  Object.freeze({ rank: 15_000, chance: 0.005 }),
]);

export function validateMysteryOddsAnchors(anchors) {
  if (!Array.isArray(anchors) || anchors.length < 2) throw new Error('At least two mystery odds anchors are required');
  let previous = null;
  for (const anchor of anchors) {
    if (!Number.isSafeInteger(anchor?.rank) || anchor.rank < 1
      || (previous && anchor.rank <= previous.rank)) throw new Error('Mystery odds anchor ranks must increase');
    if (!Number.isFinite(anchor.chance) || anchor.chance <= 0 || anchor.chance > 1) {
      throw new Error('Mystery odds anchor chance must be between zero and one');
    }
    if (previous && anchor.chance > previous.chance) {
      throw new Error('Mystery odds anchor chances must be nondecreasing toward lower ranks');
    }
    previous = anchor;
  }
  return anchors;
}

validateMysteryOddsAnchors(MYSTERY_ODDS_ANCHORS);

export function mysteryChanceForRank(rank, anchors = MYSTERY_ODDS_ANCHORS) {
  if (!Number.isSafeInteger(rank) || rank < 1) throw new Error('Invalid character rank');
  if (anchors !== MYSTERY_ODDS_ANCHORS) validateMysteryOddsAnchors(anchors);
  if (rank <= anchors[0].rank) return anchors[0].chance;
  for (let i = 1; i < anchors.length; i++) {
    if (rank === anchors[i].rank) return anchors[i].chance;
    if (rank < anchors[i].rank) return interpolate(rank, anchors[i - 1], anchors[i]);
  }
  return interpolate(rank, anchors.at(-2), anchors.at(-1));
}

function interpolate(rank, left, right) {
  const fraction = (rank - left.rank) / (right.rank - left.rank);
  return Math.max(Number.MIN_VALUE, left.chance * (right.chance / left.chance) ** fraction);
}

export function passesMysteryGate(rank, random = Math.random) {
  const chance = mysteryChanceForRank(rank);
  const draw = random();
  if (!Number.isFinite(draw) || draw < 0 || draw >= 1) throw new Error('Invalid random value');
  return draw < chance;
}
