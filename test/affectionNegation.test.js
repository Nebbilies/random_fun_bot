import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFinalCatalog } from '../lib/catalogDb.js';
import { addItemToInventory } from '../lib/itemStorage.js';
import { executeItemUseById } from '../lib/itemActivation.js';
import { createItemAction, activateItemAction, confirmHostageDelivery, resolveHostage } from '../lib/itemActions.js';

function fixture(t, defenderTotal = 2100) {
  const dir=mkdtempSync(join(tmpdir(),'affection-negation-')); const db=createFinalCatalog(join(dir,'synthetic.sqlite'));
  t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
  const characters=['101','202','202'].map((ownerId,i)=>{
    const id=`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`;
    db.prepare('INSERT INTO character_identities(id) VALUES(?)').run(id);
    db.prepare("INSERT INTO characters(id,rank,favourites,tie_order,likes_source,name_full) VALUES(?,?,1,?,'generated',?)").run(id,(i+1)*10,i+1,`Character ${i+1}`);
    const marriageId=Number(db.prepare("INSERT INTO marriages(guild_id,character_id,owner_id,married_at) VALUES('1',?,?,'2026')").run(id,ownerId).lastInsertRowid);
    return {characterId:id,marriageId,ownerId};
  });
  for(const [i,total] of [[0,2100],[1,defenderTotal]]) {
    const c=characters[i]; db.prepare("INSERT INTO character_affection VALUES('1',?,?,?,0)").run(c.ownerId,c.characterId,total);
    db.prepare("INSERT INTO player_soulmates VALUES('1',?,?,0,0,1)").run(c.ownerId,c.characterId);
  }
  const decoy=characters[2];
  db.prepare("INSERT INTO counterfeit_crowns VALUES('1','202',?,?,'crown-generation')").run(decoy.characterId,decoy.marriageId);
  const shield=addItemToInventory(db,'1','202','mirror_shield',2,{now:100}).item;
  return {db,characters,shield};
}
const charge=(db,id)=>db.prepare('SELECT charges FROM user_inventory WHERE id=?').get(id)?.charges??0;
function unchanged(x) {
  assert.equal(x.db.prepare('SELECT count(*) n FROM marriages').get().n,3);
  assert.equal(charge(x.db,x.shield.id),2);
  assert.equal(x.db.prepare('SELECT count(*) n FROM counterfeit_crowns').get().n,1);
}
for(const kind of ['master_key','pickpockets_hook','sirens_call']) test(`${kind}: Negation preserves target, Shield, Crown and conserves attack source`,t=>{
  const x=fixture(t);const source=addItemToInventory(x.db,'1','101',kind,1,{now:100}).item;
  const options={channelId:'10',commandMessageId:kind,now:100,random:()=>0};
  const result=executeItemUseById(x.db,'1','101',source.id,['202','Character 2'],options);
  assert.equal(result.blocked,true);assert.equal(result.blockedBy,'negation');assert.equal(result.actualDebit,0);unchanged(x);
  assert.equal(x.db.prepare('SELECT count(*) n FROM character_rolls').get().n,0);
  assert.deepEqual(executeItemUseById(x.db,'1','101',source.id,['202','Character 2'],{...options,random:()=>{throw Error('replayed');}}),result);
});
for(const kind of ['severed_fate','heart_for_a_heart','hostage_note']) test(`${kind}: validated action Negation stops sacrifice/challenge and settles once`,t=>{
  const x=fixture(t);const source=addItemToInventory(x.db,'1','101',kind,1,{now:100}).item;
  const action=createItemAction(x.db,{guildId:'1',actorId:'101',channelId:'10',inventoryId:source.id,now:100,
    selections:{own:x.characters[0],targets:[x.characters[1]]}});
  const request={actionId:action.id,guildId:'1',actorId:'101',now:101,random:()=>0};
  const result=activateItemAction(x.db,request);
  assert.equal(result.blocked,true);assert.equal(result.blockedBy,'negation');assert.equal(result.actualDebit,0);unchanged(x);
  assert.equal(x.db.prepare('SELECT count(*) n FROM item_character_reservations').get().n,0);
  assert.deepEqual(activateItemAction(x.db,{...request,random:()=>{throw Error('replayed');}}),result);
});
for(const kind of ['master_key','pickpockets_hook']) test(`${kind}: invalid target never spends Shield or creates a perk decision`,t=>{
  const x=fixture(t);const source=addItemToInventory(x.db,'1','101',kind,1,{now:100}).item;
  const args=kind==='master_key'?['202','Nobody']:['303'];
  const result=executeItemUseById(x.db,'1','101',source.id,args,{now:100,random:()=>{throw Error('invalid target drew');}});
  assert.equal(result.success,false);assert.equal(charge(x.db,source.id),1);unchanged(x);
  assert.equal(x.db.prepare('SELECT count(*) n FROM affection_decisions').get().n,0);
});
for(const [total,chance] of [[700,.08],[1100,.12],[1950,.16]]) test(`Negation boundary ${total}: failed check proceeds through Shield, not Crown`,t=>{
  const x=fixture(t,total);const source=addItemToInventory(x.db,'1','101','master_key',1,{now:100}).item;
  const draws=[chance,.99,.99][Symbol.iterator]();
  const result=executeItemUseById(x.db,'1','101',source.id,['202','Character 2'],{channelId:'10',commandMessageId:'boundary',now:100,random:()=>draws.next().value});
  assert.equal(result.blockedBy,'mirror_shield');assert.equal(charge(x.db,x.shield.id),1);
  assert.equal(x.db.prepare("SELECT triggered FROM affection_decisions WHERE effect='negation'").get().triggered,0);
  assert.equal(x.db.prepare('SELECT count(*) n FROM counterfeit_crowns').get().n,1);
});
test('failed Negation redirects to one Crown decoy without a second check or prepaid cost',t=>{
  const x=fixture(t);x.db.prepare('DELETE FROM user_inventory WHERE id=?').run(x.shield.id);
  const source=addItemToInventory(x.db,'1','101','master_key',1,{now:100}).item;
  const result=executeItemUseById(x.db,'1','101',source.id,['202','Character 2'],{channelId:'10',commandMessageId:'redirect',now:100,random:()=>.99});
  assert.equal(result.success,true);assert.equal(result.character.character_id,x.characters[2].characterId);
  assert.equal(x.db.prepare("SELECT count(*) n FROM affection_decisions WHERE effect='negation'").get().n,1);
  assert.equal(x.db.prepare('SELECT count(*) n FROM counterfeit_crowns').get().n,0);
  assert.equal(x.db.prepare("SELECT count(*) n FROM affection_decisions WHERE effect='item_conservation'").get().n,1);
});
test('stale action ownership is rejected before any new decisions or defenses',t=>{
  const x=fixture(t);const source=addItemToInventory(x.db,'1','101','heart_for_a_heart',1,{now:100}).item;
  const action=createItemAction(x.db,{guildId:'1',actorId:'101',channelId:'10',inventoryId:source.id,now:100,selections:{own:x.characters[0],targets:[x.characters[1]]}});
  x.db.prepare("UPDATE marriages SET owner_id='303' WHERE character_id=?").run(x.characters[1].characterId);
  assert.equal(activateItemAction(x.db,{actionId:action.id,guildId:'1',actorId:'101',now:101,random:()=>{throw Error('stale drew');}}).status,'invalid');
  assert.equal(charge(x.db,source.id),1);assert.equal(charge(x.db,x.shield.id),2);
  assert.equal(x.db.prepare('SELECT count(*) n FROM affection_decisions').get().n,0);
});
test('Kaimetsu bypasses Negation, Shield and Crown while its own semantic charge is conserved',t=>{
  const x=fixture(t);const source=addItemToInventory(x.db,'1','101','kaimetsu',1,{now:100}).item;
  const action=createItemAction(x.db,{guildId:'1',actorId:'101',channelId:'10',inventoryId:source.id,now:100});
  const result=activateItemAction(x.db,{actionId:action.id,guildId:'1',actorId:'101',now:101,random:()=>0});
  assert.equal(result.totalDivorced,1);assert.equal(result.actualDebit,0);assert.equal(charge(x.db,x.shield.id),2);
  assert.equal(x.db.prepare("SELECT count(*) n FROM affection_decisions WHERE effect='negation'").get().n,0);
});
test('Heart captures actor conservation before sacrificing its funding soulmate',t=>{
  const x=fixture(t,0);x.db.prepare('DELETE FROM user_inventory WHERE id=?').run(x.shield.id);x.db.exec('DELETE FROM counterfeit_crowns');
  const source=addItemToInventory(x.db,'1','101','heart_for_a_heart',1,{now:100}).item;
  const action=createItemAction(x.db,{guildId:'1',actorId:'101',channelId:'10',inventoryId:source.id,now:100,selections:{own:x.characters[0],targets:[x.characters[1]]}});
  const result=activateItemAction(x.db,{actionId:action.id,guildId:'1',actorId:'101',now:101,random:()=>0});
  assert.equal(result.actualDebit,0);assert.equal(charge(x.db,source.id),1);
  assert.equal(x.db.prepare("SELECT character_id FROM player_soulmates WHERE user_id='101'").get().character_id,null);
});
test('Hostage source decision freezes at opening and later exchange does not check Negation again',t=>{
  const x=fixture(t,0);x.db.prepare('DELETE FROM user_inventory WHERE id=?').run(x.shield.id);x.db.exec('DELETE FROM counterfeit_crowns');
  const source=addItemToInventory(x.db,'1','101','hostage_note',2,{now:100}).item;
  const action=createItemAction(x.db,{guildId:'1',actorId:'101',channelId:'10',inventoryId:source.id,now:100,selections:{own:x.characters[0],targets:[x.characters[1]]}});
  assert.equal(activateItemAction(x.db,{actionId:action.id,guildId:'1',actorId:'101',now:101,random:()=>0}).status,'awaiting_delivery');
  x.db.exec("UPDATE player_soulmates SET character_id=NULL WHERE user_id='101'; UPDATE character_affection SET total=2100 WHERE user_id='202'");
  assert.equal(confirmHostageDelivery(x.db,action.id,'message',102),true);assert.equal(charge(x.db,source.id),2);
  const result=resolveHostage(x.db,{actionId:action.id,guildId:'1',userId:'202',choice:'exchange',now:103,random:()=>{throw Error('exchange drew');}});
  assert.equal(result.status,'resolved');assert.equal(x.db.prepare("SELECT count(*) n FROM affection_decisions WHERE effect='negation'").get().n,1);
});
