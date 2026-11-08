import test from 'node:test';
import assert from 'node:assert/strict';
import { AFFECTION_CAP, NORMAL_MILESTONES, SOULMATE_CHECKPOINTS, getPerks, progressInterval, relatedAffectionBase } from '../lib/affectionRules.js';

test('indirect affection requires a shared franchise, regardless of genre metadata', () => {
  assert.equal(relatedAffectionBase({}), 0);
  assert.equal(relatedAffectionBase({ soulmateGenres: ['Action'], rolledGenres: ['Action'] }), 0);
  assert.equal(relatedAffectionBase({ soulmateGenres: [], rolledGenres: ['Action'] }), 0);
  assert.equal(relatedAffectionBase({ soulmateGenres: ['Action'], rolledGenres: [] }), 0);
  for (const [size, expected] of [[1,12],[5,12],[6,10],[10,10],[11,5]]) {
    assert.equal(relatedAffectionBase({ sharedFranchiseSizes: [size] }), expected);
  }
  assert.equal(relatedAffectionBase({ sharedFranchiseSizes: [3,8,12] }), 5);
});

test('approved tracks use exact thresholds and replacement rates', () => {
  assert.equal(AFFECTION_CAP, 2100);
  assert.deepEqual(NORMAL_MILESTONES.map(m => m.threshold), [100,200,300,400,500,600,700,800,900,1000,1100,1200,1300,1400,1500,1600,1700,1800,1900,2000,2100]);
  assert.deepEqual(SOULMATE_CHECKPOINTS.map(m => m.threshold), [100,150,200,250,300,400,500,600,700,800,900,1000,1100,1200,1300,1400,1500,1650,1800,1950,2100]);
  assert.deepEqual(getPerks(900), { windfall:.10, item_conservation:.16, unbroken_bond:.16, claim_conservation:.16, fortunes_favor:.08, negation:.08, echo:.08 });
  assert.deepEqual(getPerks(2100), { windfall:.15, item_conservation:.20, unbroken_bond:.20, claim_conservation:.20, fortunes_favor:.20, negation:.16, echo:.20 });
});

test('normal grants preserve named copies, passive amounts, and the accepted late tier cadence',()=>{
  assert.deepEqual(NORMAL_MILESTONES.slice(0,9).map(({threshold,itemId,tier,rollBonus,claimReductionMs})=>[threshold,itemId??tier??rollBonus??claimReductionMs]),
    [[100,'common'],[200,1],[300,'love_letter'],[400,'rare'],[500,'golden_whistle'],[600,'rare'],[700,360000],[800,'rare'],[900,'franchise_passport']]);
  assert.deepEqual(NORMAL_MILESTONES.slice(9).map(m=>m.tier),['epic','epic','legendary','epic','epic','legendary','epic','epic','legendary','epic','epic','legendary']);
  assert.equal(getPerks(99).windfall,0);assert.equal(getPerks(100).windfall,.08);
  assert.equal(getPerks(1649).claim_conservation,.16);assert.equal(getPerks(1650).claim_conservation,.20);
});

test('compact interval uses applicable union, ties, and finite capped completion', () => {
  assert.deepEqual(progressInterval(640, { soulmate:true }), { previous:600, next:700, rewards:[...NORMAL_MILESTONES.filter(m=>m.threshold===700), ...SOULMATE_CHECKPOINTS.filter(m=>m.threshold===700)], progress:40, required:100, remaining:60 });
  for (const total of [0,24,25,49,50,99]) {
    const interval = progressInterval(total);
    assert.deepEqual([interval.previous,interval.next,interval.remaining], [0,100,100-total]);
  }
  const normal = progressInterval(820);
  assert.deepEqual([normal.previous,normal.next,normal.progress,normal.required,normal.remaining], [800,900,20,100,80]);
  const late = progressInterval(1640,{soulmate:true});
  assert.deepEqual([late.previous,late.next,late.required,late.remaining], [1600,1650,50,10]);
  assert.deepEqual(progressInterval(2100), { previous:2100,next:null,rewards:[],progress:0,required:0,remaining:0 });
});
