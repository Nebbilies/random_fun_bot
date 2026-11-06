// Initial release rules. Rates are probabilities (0..1), never percentages or additive stacks.
export const AFFECTION_CAP = 2100;
const normal = (threshold, reward) => Object.freeze({ key:`normal_${threshold}`, threshold, ...reward });
export const NORMAL_MILESTONES = Object.freeze([
  normal(25,{itemId:'four_leaf_clover'}), normal(50,{itemId:'hourglass_of_haste'}),
  normal(100,{tier:'common'}), normal(200,{rollBonus:1}), normal(300,{itemId:'love_letter'}),
  normal(400,{tier:'rare'}), normal(500,{itemId:'golden_whistle'}), normal(600,{tier:'rare'}),
  normal(700,{claimReductionMs:360000}), normal(800,{tier:'rare'}), normal(900,{itemId:'franchise_passport'}),
  ...Array.from({length:12},(_,i)=>normal(1000+i*100,{tier:i%3===2?'legendary':'epic'})),
]);
export const PERK_KEYS = Object.freeze(['windfall','item_conservation','unbroken_bond','claim_conservation','fortunes_favor','negation','echo']);
/** @type {Array<[number,string,number]>} */
const checkpoints = [
  [100,'windfall',.08],[150,'item_conservation',.08],[200,'unbroken_bond',.08],
  [250,'windfall',.10],[300,'claim_conservation',.08],[400,'item_conservation',.16],
  [500,'fortunes_favor',.08],[600,'unbroken_bond',.16],[700,'negation',.08],
  [800,'claim_conservation',.16],[900,'echo',.08],[1000,'fortunes_favor',.16],
  [1100,'negation',.12],[1200,'echo',.16],[1300,'windfall',.15],
  [1400,'item_conservation',.20],[1500,'unbroken_bond',.20],[1650,'claim_conservation',.20],
  [1800,'fortunes_favor',.20],[1950,'negation',.16],[2100,'echo',.20],
];
export const SOULMATE_CHECKPOINTS = Object.freeze(checkpoints.map(([threshold,effect,chance])=>Object.freeze({key:`soulmate_${threshold}`,threshold,effect,chance})));
export function getPerks(total) {
  const perks = Object.fromEntries(PERK_KEYS.map(key=>[key,0]));
  for (const checkpoint of SOULMATE_CHECKPOINTS) if (total >= checkpoint.threshold) perks[checkpoint.effect] = checkpoint.chance;
  return perks;
}
export function progressInterval(total, { soulmate = false } = {}) {
  const value = Math.min(AFFECTION_CAP, Math.max(0, Math.floor(total)));
  const track = soulmate ? [...NORMAL_MILESTONES,...SOULMATE_CHECKPOINTS] : NORMAL_MILESTONES;
  const previous = Math.max(0,...track.filter(m=>m.threshold<=value).map(m=>m.threshold));
  const next = Math.min(...track.filter(m=>m.threshold>value).map(m=>m.threshold));
  if (!Number.isFinite(next)) return {previous,next:null,rewards:[],progress:0,required:0,remaining:0};
  return {previous,next,rewards:track.filter(m=>m.threshold===next),progress:value-previous,required:next-previous,remaining:next-value};
}
/** @param {{sharedFranchiseSizes?:number[], soulmateGenres?:string[], rolledGenres?:string[]}} facts */
export function relatedAffectionBase({ sharedFranchiseSizes = [] }) {
  if (sharedFranchiseSizes.length) return Math.min(...sharedFranchiseSizes.map(size=>size<=5?12:size<=10?10:5));
  return 0;
}
