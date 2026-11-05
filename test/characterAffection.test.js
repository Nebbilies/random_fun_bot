import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFinalCatalog, openCatalog, transaction } from '../lib/catalogDb.js';
import { hasAffection, getAffectionTotal, getAffectionBenefits, getSoulmateState, confirmSoulmate,
  captureAppearanceInTransaction, completeAppearanceInTransaction, cancelAppearanceInTransaction,
  earnReclaimInTransaction, getAffectionOverview, getAffectionDetail, selectOwedAffectionRewardsInTransaction } from '../lib/characterAffection.js';
import { resolveAffectionDecisionInTransaction, getAffectionDecision, captureCurrentPerks } from '../lib/affectionPerks.js';
import { registerPendingTransfer } from '../lib/characterAvailability.js';
const a='11111111-1111-4111-8111-111111111111', b='22222222-2222-4222-8222-222222222222';
const scope={guildId:'g',userId:'u',channelId:'c'};
function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'affection-core-')), db=createFinalCatalog(join(dir,'synthetic.sqlite'));
  t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
  for (const [id,n] of [[a,1],[b,2]]) {
    db.prepare("INSERT INTO character_identities(id,name_full,creation_method) VALUES(?,?,'manual')").run(id,`Character ${n}`);
    db.prepare("INSERT INTO characters(id,rank,favourites,tie_order,likes_source,name_full) VALUES(?,?,0,?,'generated',?)").run(id,n,n,`Character ${n}`);
    db.prepare("INSERT INTO marriages(guild_id,character_id,owner_id,married_at) VALUES('g',?,'u','date')").run(id);
  }
  return db;
}
function capture(db,sourceKey,characterId=a,now=100,random=()=>.99) {
  return transaction(db,()=>captureAppearanceInTransaction(db,{...scope,sourceKey,characterId,now,random}));
}
function complete(db,sourceKey,now=101,rewardRoster=[]) {
  return transaction(db,()=>completeAppearanceInTransaction(db,{sourceKey,now,rewardRoster,random:()=>.99}));
}

test('selection validates busy, stale menus, ownership loss and replacement cooldown without losing progress', t=>{
  const db=fixture(t);
  assert.equal(hasAffection(db),true);
  assert.equal(getAffectionTotal(db,'g','u',a),0);
  registerPendingTransfer(db,'gift','g',[a],200);
  assert.equal(confirmSoulmate(db,{...scope,characterId:a,now:100}).status,'busy');
  assert.equal(confirmSoulmate(db,{...scope,characterId:a,expectedRevision:0,now:200}).status,'selected');
  assert.equal(getSoulmateState(db,'g','u').switchAvailableAt,43200200);
  assert.equal(confirmSoulmate(db,{...scope,characterId:b,expectedRevision:0,now:300}).status,'stale');
  assert.equal(confirmSoulmate(db,{...scope,characterId:b,now:300}).status,'cooldown');
  capture(db,'own'); complete(db,'own');
  db.prepare("UPDATE marriages SET owner_id='other' WHERE character_id=?").run(a);
  assert.deepEqual(getSoulmateState(db,'g','u'),{characterId:null,selectedAt:200,switchAvailableAt:43200200,revision:2});
  assert.equal(getAffectionTotal(db,'g','u',a),100);
  assert.equal(confirmSoulmate(db,{...scope,characterId:b,expectedRevision:2,now:400}).status,'selected');
  db.prepare("UPDATE marriages SET owner_id='u' WHERE character_id=?").run(a);
  assert.equal(getSoulmateState(db,'g','u').characterId,b);
  db.prepare('DELETE FROM marriages WHERE character_id=?').run(b);
  assert.equal(getSoulmateState(db,'g','u').characterId,null);
});

test('saved appearance awards original relationship once, freezes items, cancellation never earns', t=>{
  const db=fixture(t);
  capture(db,'one');
  assert.equal(getAffectionTotal(db,'g','u',a),0);
  db.prepare("UPDATE marriages SET owner_id='other' WHERE character_id=?").run(a);
  const rewardRoster=[{id:'four_leaf_clover',tier:'common',maxCharges:2},{id:'hourglass_of_haste',tier:'common',maxCharges:1}];
  const result=complete(db,'one',200,rewardRoster);
  assert.equal(result.awards[0].amount,100);
  assert.deepEqual(result.awards[0].milestones.map(m=>m.threshold),[25,50,100]);
  assert.deepEqual(complete(db,'one'),result);
  const detail=getAffectionDetail(db,{...scope,characterId:a,now:300});
  assert.equal(detail.total,100); assert.equal(detail.isFormer,true); assert.equal(detail.pending.length,3);
  assert.equal(detail.pending[0].outcome.item.maxCharges,2);
  capture(db,'cancel',b);
  transaction(db,()=>cancelAppearanceInTransaction(db,'cancel',201));
  assert.deepEqual(complete(db,'cancel'),{awards:[]});
  assert.equal(getAffectionTotal(db,'g','u',b),0);
  const before=db.prepare('SELECT total_changes() n').get().n;
  getAffectionOverview(db,{...scope,now:300}); getAffectionDetail(db,{...scope,characterId:b,now:300});
  assert.equal(db.prepare('SELECT total_changes() n').get().n,before);
});

test('semantic decisions persist false and zero, consult receipt before new chance or RNG', t=>{
  const db=fixture(t), args={...scope,sourceKey:'use',effect:'item_conservation',chance:.08,now:1,random:()=>.5};
  transaction(db,()=>assert.deepEqual(resolveAffectionDecisionInTransaction(db,args),{triggered:false,chance:.08}));
  transaction(db,()=>assert.deepEqual(resolveAffectionDecisionInTransaction(db,{...args,chance:1,random:()=>{throw Error('redraw');}}),{triggered:false,chance:.08}));
  assert.deepEqual(getAffectionDecision(db,args),{triggered:false,chance:.08});
  transaction(db,()=>assert.deepEqual(resolveAffectionDecisionInTransaction(db,{...args,sourceKey:'zero',chance:0,random:()=>{throw Error('no draw');}}),{triggered:false,chance:0}));
  assert.deepEqual(captureCurrentPerks(db,'g','u'),{windfall:0,item_conservation:0,unbroken_bond:0,claim_conservation:0,fortunes_favor:0,negation:0,echo:0});
});

test('franchise counts use all published identities and minimum shared category, direct pair stays separate', t=>{
  const db=fixture(t);
  db.exec("INSERT INTO franchises(id,display_name,created_at) VALUES(1,'Small','d'),(2,'Large','d')");
  for (const id of [a,b]) for (const fid of [1,2]) db.prepare('INSERT INTO character_franchise_memberships VALUES(?,?)').run(id,fid);
  for (let n=3;n<=11;n++) {
    const id=`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
    db.prepare("INSERT INTO character_identities(id,creation_method) VALUES(?,'manual')").run(id);
    db.prepare("INSERT INTO characters(id,rank,favourites,tie_order,likes_source) VALUES(?,?,0,?,'generated')").run(id,n,n);
    db.prepare('INSERT INTO character_franchise_memberships VALUES(?,2)').run(id);
  }
  confirmSoulmate(db,{...scope,characterId:a,now:1});
  const saved=capture(db,'related',b);
  assert.deepEqual(saved.awards.map(x=>[x.characterId,x.base]),[[b,100],[a,5]]);
  complete(db,'related');
  assert.equal(getAffectionTotal(db,'g','u',a),5); assert.equal(getAffectionTotal(db,'g','u',b),100);
  const direct=capture(db,'direct',a);
  assert.deepEqual(direct.awards.map(x=>x.base),[100]);
  db.exec('DELETE FROM character_franchise_memberships WHERE franchise_id=2');
  assert.equal(capture(db,'small',b).awards.find(x=>x.characterId===a).base,12);
});

test('genre union and missing-metadata fallback are asymmetric', t=>{
  const db=fixture(t);
  confirmSoulmate(db,{...scope,characterId:a,now:1});
  assert.equal(capture(db,'empty',b).awards.find(x=>x.characterId===a).base,1);
  db.exec(`INSERT INTO anime(id,genres,fetched_at) VALUES(1,'["Action","Action"]','d'),(2,'["Comedy"]','d'),(3,'["Action"]','d')`);
  db.prepare('INSERT INTO character_anime VALUES(?,1)').run(a);
  assert.equal(capture(db,'covered',b).awards.some(x=>x.characterId===a),false);
  db.prepare('INSERT INTO character_anime VALUES(?,2)').run(a);
  db.prepare('INSERT INTO character_anime VALUES(?,3)').run(b);
  assert.equal(capture(db,'shared',b).awards.find(x=>x.characterId===a).base,1);
});

test('pre-award Bond freezes before unlock, doubles once, clamps, and restores only owned benefits', t=>{
  const db=fixture(t);
  confirmSoulmate(db,{...scope,characterId:a,now:1});
  capture(db,'first',a,10,()=>0); complete(db,'first');
  assert.equal(getAffectionTotal(db,'g','u',a),100);
  capture(db,'second',a,20,()=>0); complete(db,'second');
  assert.equal(getAffectionTotal(db,'g','u',a),200);
  capture(db,'third',a,30,()=>0); const doubled=complete(db,'third');
  assert.equal(doubled.awards[0].amount,200); assert.equal(getAffectionTotal(db,'g','u',a),400);
  for (let n=0;n<18;n++) {capture(db,`more-${n}`,a,100+n);complete(db,`more-${n}`,200+n);}
  assert.equal(getAffectionTotal(db,'g','u',a),2100);
  capture(db,'cap',a); assert.equal(complete(db,'cap').awards[0].amount,0);
  assert.deepEqual([getAffectionBenefits(db,'g','u').rollBonus,getAffectionBenefits(db,'g','u').claimReductionMs],[1,360000]);
  db.prepare("UPDATE marriages SET owner_id='other' WHERE character_id=?").run(a);
  assert.equal(getAffectionBenefits(db,'g','u').rollBonus,0);
  db.prepare("UPDATE marriages SET owner_id='u' WHERE character_id=?").run(a);
  assert.equal(getAffectionBenefits(db,'g','u').rollBonus,1);
  assert.equal(getAffectionBenefits(db,'g','u').soulmate,null);
});

test('reclaim is direct twenty once and empty tiers stay owed until trusted tier becomes available',t=>{
  const db=fixture(t);
  const args={...scope,sourceKey:'reclaim',characterId:a,now:1,rewardRoster:[],random:()=>.99};
  assert.throws(()=>earnReclaimInTransaction(db,args),/transaction/);
  assert.equal(transaction(db,()=>earnReclaimInTransaction(db,args)).awards[0].amount,20);
  assert.equal(transaction(db,()=>earnReclaimInTransaction(db,args)).awards[0].total,20);
  // Persistence contract: reclaim keeps even its zero-chance pre-award Bond evidence.
  const receipt=db.prepare("SELECT chance,triggered FROM affection_decisions WHERE effect='unbroken_bond' AND user_id='u'").get();
  assert.deepEqual({...receipt},{chance:0,triggered:0});
  transaction(db,()=>earnReclaimInTransaction(db,{...args,sourceKey:'second',now:2}));
  capture(db,'appearance');complete(db,'appearance');
  let pending=getAffectionDetail(db,{...scope,characterId:a}).pending;
  assert.equal(pending.filter(x=>x.state==='owed').length,3);
  transaction(db,()=>selectOwedAffectionRewardsInTransaction(db,{...scope,now:200,rewardRoster:[{id:'rare',tier:'rare'}],random:()=>0}));
  assert.equal(getAffectionDetail(db,{...scope,characterId:a}).pending.filter(x=>x.state==='owed').length,3);
  transaction(db,()=>selectOwedAffectionRewardsInTransaction(db,{...scope,now:201,rewardRoster:[{id:'common',tier:'common',maxCharges:3}],random:()=>0}));
  pending=getAffectionDetail(db,{...scope,characterId:a}).pending;
  assert.equal(pending.filter(x=>x.state==='selected').length,1);
  assert.equal(pending.find(x=>x.state==='selected').outcome.item.maxCharges,3);
});

test('normal passive caps and exact cooldown boundary preserve current ownership and read purity',t=>{
  const db=fixture(t);
  for (let n=1;n<=12;n++) {
    const id=n===1?a:n===2?b:`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
    if (n>2) {
      db.prepare("INSERT INTO character_identities(id) VALUES(?)").run(id);
      db.prepare("INSERT INTO marriages(guild_id,character_id,owner_id,married_at) VALUES('g',?,'u','d')").run(id);
    }
    db.prepare("INSERT INTO character_affection VALUES('g','u',?,700,0)").run(id);
  }
  assert.equal(getAffectionBenefits(db,'g','u').rollBonus,5);
  assert.equal(getAffectionBenefits(db,'g','u').claimReductionMs,3600000);
  confirmSoulmate(db,{...scope,characterId:a,now:1});
  assert.equal(confirmSoulmate(db,{...scope,characterId:b,now:43200001}).status,'selected');
  const mutations=db.prepare('SELECT total_changes() n').get().n;
  const overview=getAffectionOverview(db,{...scope,page:0,pageSize:5});
  assert.equal(overview.rows.length,5);assert.equal(overview.pages,3);assert.equal(overview.former,false);
  assert.equal(db.prepare('SELECT total_changes() n').get().n,mutations);
});

test('appearance replay excludes independent reclaim awards on the same source',t=>{
  const db=fixture(t);
  db.prepare("UPDATE marriages SET owner_id='other' WHERE character_id=?").run(b);
  confirmSoulmate(db,{...scope,characterId:a,now:1});
  capture(db,'shared-source',b);
  const appearance=complete(db,'shared-source');
  const reclaim=transaction(db,()=>earnReclaimInTransaction(db,{...scope,userId:'other',sourceKey:'shared-source',characterId:b,now:200}));
  assert.equal(reclaim.awards[0].amount,20);
  assert.deepEqual(complete(db,'shared-source'),appearance);
});

test('source and pair receipts survive presentation cleanup, reconnect, and ownership loss',t=>{
  const dir=mkdtempSync(join(tmpdir(),'affection-reopen-')),path=join(dir,'synthetic.sqlite');
  let db=createFinalCatalog(path);
  t.after(()=>{db?.close();rmSync(dir,{recursive:true,force:true});});
  db.prepare('INSERT INTO character_identities(id) VALUES(?)').run(a);
  db.prepare("INSERT INTO marriages(guild_id,character_id,owner_id,married_at) VALUES('g',?,'u','d')").run(a);
  capture(db,'permanent',a);
  const original=complete(db,'permanent');
  db.prepare("INSERT INTO character_rolls(guild_id,channel_id,command_message_id,character_id,character_name,state) VALUES('g','c','permanent',?,'A','closed')").run(a);
  db.exec('DELETE FROM character_rolls; DELETE FROM marriages');
  db.close();db=openCatalog(path);
  assert.deepEqual(complete(db,'permanent'),original);
  assert.equal(getAffectionTotal(db,'g','u',a),100);
  assert.equal(getAffectionDetail(db,{...scope,characterId:a}).pending.length,3);
  assert.throws(()=>capture(db,'permanent',b),/scope conflict/);
  assert.throws(()=>complete(db,'unknown'),/Missing.*capture/);
});

test('legacy v10 detection is pure and preserves old behavior',()=>{
  const db=openCatalog(':memory:');
  try {assert.equal(hasAffection(db),false);assert.equal(getAffectionBenefits(db,'g','u').rollBonus,0);} finally {db.close();}
});
